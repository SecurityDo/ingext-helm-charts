#!/bin/bash

# ==============================================================================
# Script Name: setup_eks_s3.sh
# Usage: ./setup_eks_s3.sh <profile> <region> <bucket-name> <expireDays>
# Description: Automates S3 Bucket creation, IAM Policy setup, and EKS Add-on
#              installation for the Mountpoint S3 CSI Driver.
# ==============================================================================

# 1. Input Validation
if [ "$#" -ne 5 ]; then
    echo "Usage: $0 <cluster> <profile> <region> <bucket-name> <expireDays>"
    echo "Example: $0 my-cluster demo us-east-1 my-eks-data-bucket 30"
    exit 1
fi

CLUSTER_NAME=$1
PROFILE=$2
REGION=$3
BUCKET_NAME=$4
EXPIRE_DAYS=$5
POLICY_NAME="MountpointS3-${BUCKET_NAME}-Policy"

# Export Profile globally so eksctl/aws/helm/kubectl all use it automatically
export AWS_PROFILE=$PROFILE

echo "=== Starting Setup for Cluster: $CLUSTER_NAME ==="
echo "Profile: $PROFILE | Region: $REGION | Bucket: $BUCKET_NAME"

# 2. Get Account ID (Needed for ARN construction)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
if [ -z "$ACCOUNT_ID" ]; then
    echo "Error: Could not retrieve AWS Account ID. Check your profile credentials."
    exit 1
fi
echo "-> AWS Account ID: $ACCOUNT_ID"

# 3. Create S3 Bucket
echo "-> Creating S3 Bucket '$BUCKET_NAME'..."
if [ "$REGION" == "us-east-1" ]; then
    # us-east-1 does not accept LocationConstraint
    aws s3api create-bucket \
        --bucket "$BUCKET_NAME" \
        --region "$REGION" > /dev/null 2>&1
else
    aws s3api create-bucket \
        --bucket "$BUCKET_NAME" \
        --region "$REGION" \
        --create-bucket-configuration LocationConstraint="$REGION" > /dev/null 2>&1
fi

if [ $? -eq 0 ]; then
    echo "   Success: Bucket created (or already owned)."
else
    echo "   Error: Failed to create bucket. It might already exist globally."
    exit 1
fi

# 4. Set Lifecycle Policy (Expiration)
echo "-> Setting object expiration to $EXPIRE_DAYS days..."
cat <<EOT > lifecycle.json
{
    "Rules": [
        {
            "ID": "ExpireObjects",
            "Status": "Enabled",
            "Filter": { "Prefix": "" },
            "Expiration": { "Days": $EXPIRE_DAYS }
        }
    ]
}
EOT

aws s3api put-bucket-lifecycle-configuration \
    --bucket "$BUCKET_NAME" \
    --lifecycle-configuration file://lifecycle.json

rm lifecycle.json
echo "   Success: Lifecycle policy applied."

# 5. Create IAM Policy
echo "-> Creating IAM Policy '$POLICY_NAME'..."
cat <<EOT > s3-driver-policy.json
{
   "Version": "2012-10-17",
   "Statement": [
       {
           "Sid": "MountpointFullBucketAccess",
           "Effect": "Allow",
           "Action": [ "s3:ListBucket" ],
           "Resource": [ "arn:aws:s3:::$BUCKET_NAME" ]
       },
       {
           "Sid": "MountpointFullObjectAccess",
           "Effect": "Allow",
           "Action": [ "s3:GetObject", "s3:PutObject", "s3:AbortMultipartUpload", "s3:DeleteObject" ],
           "Resource": [ "arn:aws:s3:::$BUCKET_NAME/*" ]
       }
   ]
}
EOT

# Create policy and capture ARN. If it exists, construct the ARN manually.
POLICY_ARN=$(aws iam create-policy \
    --policy-name "$POLICY_NAME" \
    --policy-document file://s3-driver-policy.json \
    --query 'Policy.Arn' --output text 2>/dev/null)

if [ -z "$POLICY_ARN" ]; then
    echo "   Policy might already exist. Constructing ARN manually..."
    POLICY_ARN="arn:aws:iam::$ACCOUNT_ID:policy/$POLICY_NAME"
fi

rm s3-driver-policy.json
echo "   Policy ARN: $POLICY_ARN"

# 6. Create Pod Identity Association
echo "-> Creating EKS Pod Identity Association..."
eksctl create podidentityassociation \
  --cluster "$CLUSTER_NAME" \
  --namespace kube-system \
  --service-account-name s3-csi-driver-sa \
  --role-name "AmazonEKS_S3_CSI_DriverRole-$BUCKET_NAME" \
  --permission-policy-arns "$POLICY_ARN" \
  --region "$REGION"

# 7. Install Add-on
echo "-> Installing AWS Mountpoint S3 CSI Driver Add-on..."
# We use --force to overwrite if it was partially installed or failed previously
eksctl create addon \
  --cluster "$CLUSTER_NAME" \
  --name aws-mountpoint-s3-csi-driver \
  --region "$REGION" \
  --force

echo "========================================================"
echo "✅ Setup Complete!"
echo "To verify, run: kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-mountpoint-s3-csi-driver"
echo "========================================================"
