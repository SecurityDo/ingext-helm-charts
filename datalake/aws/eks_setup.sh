#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Check for required arguments
if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <profile> <region> <cluster_name>"
    exit 1
fi

# 1. Setup Environment Variables
export PROFILE=$1
export REGION=$2
export CLUSTER_NAME=$3
export AWS_PROFILE=$PROFILE

# Fetch AWS Account ID for IAM Policy ARNs
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo "--- Starting EKS Setup ---"
echo "Profile: $AWS_PROFILE"
echo "Region:  $REGION"
echo "Cluster: $CLUSTER_NAME"
echo "Account: $ACCOUNT_ID"
echo "--------------------------"

# 2. Create EKS Cluster
echo "Creating EKS cluster (this may take 15-20 minutes)..."
eksctl create cluster \
  --name "$CLUSTER_NAME" \
  --region "$REGION" \
  --version 1.34 \
  --nodegroup-name standard-workers \
  --node-type t3.large \
  --nodes 3 \
  --nodes-min 3 \
  --nodes-max 4 \
  --managed

# 3. Update Kubeconfig
echo "Updating kubeconfig..."
aws eks update-kubeconfig --region "$REGION" --name "$CLUSTER_NAME"

# 4. Install Pod Identity Agent Add-on
echo "Installing EKS Pod Identity Agent..."
eksctl create addon \
  --cluster "$CLUSTER_NAME" \
  --name eks-pod-identity-agent \
  --region "$REGION"

# 5. Setup EBS CSI Driver with Pod Identity
echo "Configuring EBS CSI Driver Association..."
eksctl create podidentityassociation \
  --cluster "$CLUSTER_NAME" \
  --namespace kube-system \
  --service-account-name ebs-csi-controller-sa \
  --role-name "AmazonEKS_EBS_CSI_DriverRole_$CLUSTER_NAME" \
  --permission-policy-arns arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
  --region "$REGION"

echo "Installing EBS CSI Driver Add-on..."
eksctl create addon \
  --cluster "$CLUSTER_NAME" \
  --name aws-ebs-csi-driver \
  --region "$REGION"

# 6. Install gp3 Storage Class
echo "Installing gp3 storage class..."
# refresh aws public ecr login
aws ecr-public get-login-password --region us-east-1 | helm registry login --username AWS --password-stdin public.ecr.aws
helm install ingext-aws-gp3 oci://public.ecr.aws/ingext/ingext-aws-gp3

# 7. Install the Mountpoint for Amazon S3 CSI driver
aws eks create-addon \
  --cluster-name "$CLUSTER_NAME" \
  --addon-name aws-mountpoint-s3-csi-driver \
  --resolve-conflicts OVERWRITE \
  --region "$REGION"

# 8. Setup AWS Load Balancer Controller
echo "Setting up AWS Load Balancer Controller..."

# Download and create IAM Policy
curl -sO https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json

# Check if policy already exists to avoid error on reruns
POLICY_ARN="arn:aws:iam::$ACCOUNT_ID:policy/AWSLoadBalancerControllerIAMPolicy_$CLUSTER_NAME"
if ! aws iam get-policy --policy-arn "$POLICY_ARN" > /dev/null 2>&1; then
    aws iam create-policy \
        --policy-name "AWSLoadBalancerControllerIAMPolicy_$CLUSTER_NAME" \
        --policy-document file://iam_policy.json
fi

# Create Pod Identity Association for LBC
eksctl create podidentityassociation \
  --cluster "$CLUSTER_NAME" \
  --namespace kube-system \
  --service-account-name aws-load-balancer-controller \
  --role-name "AWSLoadBalancerControllerRole_$CLUSTER_NAME" \
  --permission-policy-arns "$POLICY_ARN" \
  --region "$REGION"

# 9. Install LBC via Helm
echo "Installing Load Balancer Controller via Helm..."
helm repo add eks https://aws.github.io/eks-charts
helm repo update

VPC_ID=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$REGION" --query "cluster.resourcesVpcConfig.vpcId" --output text)

helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName="$CLUSTER_NAME" \
  --set serviceAccount.create=true \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set region="$REGION" \
  --set vpcId="$VPC_ID"
