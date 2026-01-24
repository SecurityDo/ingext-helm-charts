#!/bin/bash

# ==============================================================================
# Script Name: setup_karpenter.sh
# Usage: ./setup_karpenter.sh <cluster-name> <profile> <region>
# Example: ./setup_karpenter.sh ingextlake demo us-east-1
# ==============================================================================

set -e # Exit immediately if a command exits with a non-zero status

if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <profile> <region> <cluster-name>"
    echo "Example: $0 demo us-east-1 my-cluster"
    exit 1
fi

PROFILE=$1
REGION=$2
CLUSTER_NAME=$3

# Export Profile globally so eksctl/aws/helm/kubectl all use it automatically
export AWS_PROFILE=$PROFILE
# Version compatible with EKS 1.34+ (Using latest stable v1.8.3)
KARPENTER_VERSION="1.8.3"

echo "=== Setting up Karpenter for Cluster: $CLUSTER_NAME ==="
echo "Profile: $AWS_PROFILE | Region: $REGION | Karpenter Version: $KARPENTER_VERSION"

# 1. Get Account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [ -z "$ACCOUNT_ID" ]; then
    echo "Error: Could not retrieve AWS Account ID. Check your profile credentials."
    exit 1
fi
echo "-> AWS Account ID: $ACCOUNT_ID"

# 2. Tag VPC Resources (Critical for Discovery)
echo "-> Tagging VPC Subnets and Security Groups..."
VPC_ID=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" --query "cluster.resourcesVpcConfig.vpcId" --output text)

SUBNETS=$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" --region "$REGION" --query "Subnets[].SubnetId" --output text)
if [ -n "$SUBNETS" ]; then
    # Convert newline separated subnets to space separated
    SUBNET_LIST=$(echo $SUBNETS | tr '\n' ' ')
    aws ec2 create-tags --resources $SUBNET_LIST --tags Key=karpenter.sh/discovery,Value="$CLUSTER_NAME" --region "$REGION"
fi

#SGS=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$VPC_ID" --region "$REGION" --query "SecurityGroups[].GroupId" --output text)
#if [ -n "$SGS" ]; then
#    # Convert newline separated SGs to space separated
#    SG_LIST=$(echo $SGS | tr '\n' ' ')
#    aws ec2 create-tags --resources $SG_LIST --tags Key=karpenter.sh/discovery,Value="$CLUSTER_NAME" --region "$REGION"
#fi

# --- REPLACE OLD STEP 2 SECURITY GROUP TAGGING ---
echo "-> Tagging ONLY the Cluster Shared Node Security Group..."
# Fetch the specific security group EKS created for nodes
NODE_SG=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" \
  --query "cluster.resourcesVpcConfig.clusterSecurityGroupId" --output text)

if [ -n "$NODE_SG" ] && [ "$NODE_SG" != "None" ]; then
    echo "   Found Cluster SG: $NODE_SG"
    aws ec2 create-tags --resources "$NODE_SG" \
      --tags Key=karpenter.sh/discovery,Value="$CLUSTER_NAME" --region "$REGION"
else
    echo "   Warning: Could not find Cluster Security Group to tag."
fi


# 3. Create Karpenter Node Role (Worker Nodes)
NODE_ROLE_NAME="KarpenterNodeRole-${CLUSTER_NAME}"
echo "-> Creating Node Role: $NODE_ROLE_NAME"

cat <<EOT > node-trust.json
{
  "Version": "2012-10-17",
  "Statement": [ { "Effect": "Allow", "Principal": { "Service": "ec2.amazonaws.com" }, "Action": "sts:AssumeRole" } ]
}
EOT

aws iam create-role --role-name "$NODE_ROLE_NAME" --assume-role-policy-document file://node-trust.json > /dev/null 2>&1 || true
aws iam attach-role-policy --role-name "$NODE_ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy
aws iam attach-role-policy --role-name "$NODE_ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy
aws iam attach-role-policy --role-name "$NODE_ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly
aws iam attach-role-policy --role-name "$NODE_ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
rm node-trust.json

# 4. Create Access Entry (Allow nodes to join EKS)
echo "-> Creating EKS Access Entry..."
aws eks create-access-entry --cluster-name "$CLUSTER_NAME" \
  --principal-arn "arn:aws:iam::$ACCOUNT_ID:role/$NODE_ROLE_NAME" \
  --type EC2_LINUX \
  --region "$REGION" > /dev/null 2>&1 || true

# 5. Create Controller Policy & Role
CONTROLLER_ROLE_NAME="KarpenterControllerRole-${CLUSTER_NAME}"
POLICY_NAME="KarpenterControllerPolicy-${CLUSTER_NAME}"
echo "-> Creating Controller Policy and Role..."

# Complete Policy (Includes Spot Pricing, Instance Profiles, Correct EC2 Tags)
cat <<EOT > controller-policy.json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "KarpenterCore",
            "Effect": "Allow",
            "Action": [
                "ssm:GetParameter",
                "ec2:DescribeImages",
                "ec2:RunInstances",
                "ec2:DescribeSubnets",
                "ec2:DescribeSecurityGroups",
                "ec2:DescribeLaunchTemplates",
                "ec2:DescribeInstances",
                "ec2:DescribeInstanceTypes",
                "ec2:DescribeInstanceTypeOfferings",
                "ec2:DescribeAvailabilityZones",
                "ec2:DeleteLaunchTemplate",
                "ec2:CreateTags",
                "ec2:DeleteTags",
                "ec2:CreateLaunchTemplate",
                "ec2:CreateFleet",
                "ec2:TerminateInstances",
                "ec2:DescribeSpotPriceHistory",
                "pricing:GetProducts"
            ],
            "Resource": "*"
        },
        {
            "Sid": "KarpenterInstanceProfileManagement",
            "Effect": "Allow",
            "Action": [
                "iam:CreateInstanceProfile",
                "iam:TagInstanceProfile",
                "iam:AddRoleToInstanceProfile",
                "iam:RemoveRoleFromInstanceProfile",
                "iam:DeleteInstanceProfile",
                "iam:GetInstanceProfile",
                "iam:ListInstanceProfiles"
            ],
            "Resource": "*"
        },
        {
            "Sid": "KarpenterClusterDiscovery",
            "Effect": "Allow",
            "Action": "eks:DescribeCluster",
            "Resource": "arn:aws:eks:${REGION}:${ACCOUNT_ID}:cluster/${CLUSTER_NAME}"
        },
        {
            "Sid": "KarpenterPassRole",
            "Effect": "Allow",
            "Action": "iam:PassRole",
            "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${NODE_ROLE_NAME}",
            "Condition": {
                "StringEquals": {
                    "iam:PassedToService": "ec2.amazonaws.com"
                }
            }
        },
        {
            "Sid": "AllowInterruptionQueue",
            "Effect": "Allow",
            "Action": [ "sqs:DeleteMessage", "sqs:GetQueueUrl", "sqs:ReceiveMessage" ],
            "Resource": "*"
        }
    ]
}
EOT

# Create or Update Policy
POLICY_ARN=$(aws iam create-policy --policy-name "$POLICY_NAME" --policy-document file://controller-policy.json --query 'Policy.Arn' --output text 2>/dev/null || echo "arn:aws:iam::$ACCOUNT_ID:policy/$POLICY_NAME")

echo "   Updating Policy Version for $POLICY_ARN..."
# Delete old versions if they exist to avoid LimitExceeded
aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id v1 > /dev/null 2>&1 || true
aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id v2 > /dev/null 2>&1 || true
aws iam create-policy-version --policy-arn "$POLICY_ARN" --policy-document file://controller-policy.json --set-as-default > /dev/null 2>&1 || true
rm controller-policy.json

# Create Controller Role with Pod Identity Trust Policy
cat <<EOT > trust-policy.json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": { "Service": "pods.eks.amazonaws.com" },
            "Action": [ "sts:AssumeRole", "sts:TagSession" ]
        }
    ]
}
EOT

aws iam create-role --role-name "$CONTROLLER_ROLE_NAME" --assume-role-policy-document file://trust-policy.json > /dev/null 2>&1 || true
aws iam attach-role-policy --role-name "$CONTROLLER_ROLE_NAME" --policy-arn "$POLICY_ARN"
rm trust-policy.json

# 6. Create Service Linked Role (Spot)
aws iam create-service-linked-role --aws-service-name spot.amazonaws.com 2>/dev/null || true

# 7. Create Pod Identity Association
echo "-> Creating Pod Identity Association..."
# Removed --profile flag here, using env var instead
eksctl create podidentityassociation \
  --cluster "$CLUSTER_NAME" \
  --namespace kube-system \
  --service-account-name karpenter \
  --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${CONTROLLER_ROLE_NAME}" \
  --region "$REGION" \
  2>/dev/null || echo "   (Association might already exist)"

# 8. Authenticate Helm (Important for OCI)
echo "-> Logging into ECR Public..."
aws ecr-public get-login-password --region us-east-1 | helm registry login --username AWS --password-stdin public.ecr.aws

# 9. Install via Helm
echo "-> Installing Karpenter v${KARPENTER_VERSION} via Helm..."
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version "$KARPENTER_VERSION" \
  --namespace kube-system \
  --create-namespace \
  --set settings.clusterName="$CLUSTER_NAME" \
  --set settings.interruptionQueue="" \
  --set controller.resources.requests.cpu=1 \
  --set controller.resources.requests.memory=1Gi \
  --set controller.resources.limits.cpu=1 \
  --set controller.resources.limits.memory=1Gi \
  --wait

echo "========================================================"
echo "✅ Karpenter Setup Complete!"
echo "Node Role: $NODE_ROLE_NAME"
echo "Controller Role: $CONTROLLER_ROLE_NAME"
echo "Check logs: kubectl logs -f -n kube-system -l app.kubernetes.io/name=karpenter"
echo "========================================================"
