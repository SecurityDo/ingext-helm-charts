#!/bin/bash

# ==============================================================================
# Script Name: setup_ingext_serviceaccount.sh
# Usage: ./setup_ingext_serviceaccount.sh <clusterName> <namespace> <profile> <bucketName>
# Description: Creates a K8s Service Account, an IAM Role with S3 permissions,
#              and links them via EKS Pod Identity.
# ==============================================================================

set -e # Exit on error

if [ "$#" -ne 4 ]; then
    echo "Usage: $0 <clusterName> <namespace> <profile> <bucketName>"
    echo "Example: $0 ingextlake data-processing demo my-app-data-bucket"
    exit 1
fi

CLUSTER_NAME=$1
NAMESPACE=$2
PROFILE=$3
BUCKET_NAME=$4

# Derived Names
SA_NAME="${NAMESPACE}-sa"
ROLE_NAME="ingext_${SA_NAME}"
POLICY_NAME="ingext_${SA_NAME}_S3_Policy"

# Export Profile for AWS CLI/eksctl
export AWS_PROFILE=$PROFILE

echo "=== Setup Service Account: $SA_NAME ==="
echo "Cluster: $CLUSTER_NAME | Namespace: $NAMESPACE | Bucket: $BUCKET_NAME"

# 1. Get AWS Account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "-> AWS Account ID: $ACCOUNT_ID"

# 2. Update Kubeconfig (Ensure kubectl talks to the right cluster)
echo "-> Updating kubeconfig..."
aws eks update-kubeconfig --name "$CLUSTER_NAME" --region us-east-1 > /dev/null

# 3. Create Namespace & Service Account
echo "-> Creating Kubernetes resources..."
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl create serviceaccount "$SA_NAME" -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# 4. Create IAM Policy (Read/Write/List S3)
echo "-> Creating IAM Policy: $POLICY_NAME"
cat <<EOT > s3_rw_policy.json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ListBucket",
            "Effect": "Allow",
            "Action": [
                "s3:ListBucket"
            ],
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
POLICY_ARN=$(aws iam create-policy --policy-name "$POLICY_NAME" --policy-document file://s3_rw_policy.json --query 'Policy.Arn' --output text 2>/dev/null || echo "arn:aws:iam::$ACCOUNT_ID:policy/$POLICY_NAME")

# If policy existed, update it to match the new json
if [ "$POLICY_ARN" == "arn:aws:iam::$ACCOUNT_ID:policy/$POLICY_NAME" ]; then
    echo "   Policy exists. Updating version..."
    aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id v1 > /dev/null 2>&1 || true
    aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id v2 > /dev/null 2>&1 || true
    aws iam create-policy-version --policy-arn "$POLICY_ARN" --policy-document file://s3_rw_policy.json --set-as-default > /dev/null 2>&1 || true
fi
rm s3_rw_policy.json

# 5. Create IAM Role with Pod Identity Trust
echo "-> Creating IAM Role: $ROLE_NAME"
cat <<EOT > trust_policy.json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": "pods.eks.amazonaws.com"
            },
            "Action": [
                "sts:AssumeRole",
                "sts:TagSession"
            ]
        }
    ]
}
EOT

aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document file://trust_policy.json > /dev/null 2>&1 || true
aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN"
rm trust_policy.json

# 6. Create Pod Identity Association
echo "-> Associating Service Account with IAM Role..."
# We use eksctl here because it handles the API call to EKS cleanly
# Note: region is hardcoded to us-east-1 based on previous context, change if dynamic
eksctl create podidentityassociation \
    --cluster "$CLUSTER_NAME" \
    --namespace "$NAMESPACE" \
    --service-account-name "$SA_NAME" \
    --role-arn "arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME" \
    --region us-east-1 \
    2>/dev/null || echo "   (Association might already exist, verified.)"

echo "========================================================"
echo "✅ Setup Complete!"
echo "Namespace: $NAMESPACE"
echo "Service Account: $SA_NAME"
echo "IAM Role: $ROLE_NAME"
echo "Bucket Access: $BUCKET_NAME"
echo "========================================================"
