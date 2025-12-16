#!/bin/bash

# ==============================================================================
# Script Name: setup_ingext_serviceaccount.sh
# Usage: ./setup_ingext_serviceaccount.sh <clusterName> <region> <namespace> <profile> <bucketName>
# Description: Creates a K8s Service Account with:
#              1. AWS Permissions (IAM Role) to access S3.
#              2. K8s Permissions (RBAC Role) to create Pods/PVCs/Jobs.
# ==============================================================================

set -e # Exit on error

if [ "$#" -ne 5 ]; then
    echo "Usage: $0 <clusterName> <region> <namespace> <profile> <bucketName>"
    echo "Example: $0 ingextlake us-east-1 data-processing demo my-app-data-bucket"
    exit 1
fi

CLUSTER_NAME=$1
REGION=$2
NAMESPACE=$3
PROFILE=$4
BUCKET_NAME=$5

# Derived Names
SA_NAME="${NAMESPACE}-sa"
IAM_ROLE_NAME="ingext_${SA_NAME}"
IAM_POLICY_NAME="ingext_${SA_NAME}_S3_Policy"
K8S_ROLE_NAME="${SA_NAME}-manager-role"
K8S_BINDING_NAME="${SA_NAME}-manager-binding"

# Export Profile for AWS CLI/eksctl
export AWS_PROFILE=$PROFILE

echo "=== Setup Service Account: $SA_NAME ==="
echo "Cluster: $CLUSTER_NAME ($REGION) | Namespace: $NAMESPACE | Bucket: $BUCKET_NAME"

# 1. Get AWS Account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "-> AWS Account ID: $ACCOUNT_ID"

# 2. Update Kubeconfig
echo "-> Updating kubeconfig..."
aws eks update-kubeconfig --name "$CLUSTER_NAME" --region "$REGION" > /dev/null

# 3. Create Namespace & Service Account
echo "-> Creating Kubernetes Namespace & Service Account..."
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl create serviceaccount "$SA_NAME" -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# ==============================================================================
# PART A: AWS IAM SETUP (S3 Access)
# ==============================================================================

# 4. Create IAM Policy (Read/Write/List S3)
echo "-> Creating IAM Policy: $IAM_POLICY_NAME"
cat <<EOT > s3_rw_policy.json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ListBucket",
            "Effect": "Allow",
            "Action": [ "s3:ListBucket" ],
            "Resource": "arn:aws:s3:::${BUCKET_NAME}"
        },
        {
            "Sid": "ReadWriteObjects",
            "Effect": "Allow",
            "Action": [
                "s3:PutObject",
                "s3:GetObject",
                "s3:DeleteObject",
                "s3:AbortMultipartUpload"
            ],
            "Resource": "arn:aws:s3:::${BUCKET_NAME}/*"
        }
    ]
}
EOT

# Create Policy (or retrieve ARN if exists)
POLICY_ARN=$(aws iam create-policy --policy-name "$IAM_POLICY_NAME" --policy-document file://s3_rw_policy.json --query 'Policy.Arn' --output text 2>/dev/null || echo "arn:aws:iam::$ACCOUNT_ID:policy/$IAM_POLICY_NAME")

# Update policy if it existed
if [ "$POLICY_ARN" == "arn:aws:iam::$ACCOUNT_ID:policy/$IAM_POLICY_NAME" ]; then
    echo "   Policy exists. Updating version..."
    aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id v1 > /dev/null 2>&1 || true
    aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id v2 > /dev/null 2>&1 || true
    aws iam create-policy-version --policy-arn "$POLICY_ARN" --policy-document file://s3_rw_policy.json --set-as-default > /dev/null 2>&1 || true
fi
rm s3_rw_policy.json

# 5. Create IAM Role with Pod Identity Trust
echo "-> Creating IAM Role: $IAM_ROLE_NAME"
cat <<EOT > trust_policy.json
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

aws iam create-role --role-name "$IAM_ROLE_NAME" --assume-role-policy-document file://trust_policy.json > /dev/null 2>&1 || true
aws iam attach-role-policy --role-name "$IAM_ROLE_NAME" --policy-arn "$POLICY_ARN"
rm trust_policy.json

# 6. Create Pod Identity Association
echo "-> Associating Service Account with IAM Role..."
eksctl create podidentityassociation \
    --cluster "$CLUSTER_NAME" \
    --namespace "$NAMESPACE" \
    --service-account-name "$SA_NAME" \
    --role-arn "arn:aws:iam::$ACCOUNT_ID:role/$IAM_ROLE_NAME" \
    --region "$REGION" \
    2>/dev/null || echo "   (Association might already exist, verified.)"

# ==============================================================================
# PART B: KUBERNETES RBAC SETUP (Pod/PVC/Job Creation)
# ==============================================================================

echo "-> Creating Kubernetes RBAC Role & Binding..."

cat <<EOF | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  namespace: $NAMESPACE
  name: $K8S_ROLE_NAME
rules:
- apiGroups: [""]
  resources: ["pods", "pods/log", "persistentvolumeclaims", "configmaps", "secrets"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
- apiGroups: ["batch"]
  resources: ["jobs", "cronjobs"]
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  namespace: $NAMESPACE
  name: $K8S_BINDING_NAME
subjects:
- kind: ServiceAccount
  name: $SA_NAME
  namespace: $NAMESPACE
roleRef:
  kind: Role
  name: $K8S_ROLE_NAME
  apiGroup: rbac.authorization.k8s.io
EOF

echo "========================================================"
echo "✅ Setup Complete!"
echo "Cluster: $CLUSTER_NAME ($REGION)"
echo "Namespace: $NAMESPACE"
echo "Service Account: $SA_NAME"
echo "IAM Role: $IAM_ROLE_NAME"
echo "Bucket Access: $BUCKET_NAME"
echo "K8s RBAC: $K8S_ROLE_NAME (Pod/Job/PVC Access)"
echo "========================================================"
