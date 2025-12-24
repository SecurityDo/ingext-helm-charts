#!/bin/bash

# ==============================================================================
# Script Name: create_s3_bucket.sh
# Usage: ./create_s3_bucket.sh <profile> <region> <bucket-name> <expireDays>
# Description: Automates S3 Bucket creation
# ==============================================================================

# 1. Input Validation
if [ "$#" -ne 4 ]; then
    echo "Usage: $0 <profile> <region> <bucket-name> <expireDays>"
    echo "Example: $0 demo us-east-1 my-eks-data-bucket 30"
    exit 1
fi


PROFILE=$1
REGION=$2
BUCKET_NAME=$3
EXPIRE_DAYS=$4

# Export Profile globally so eksctl/aws/helm/kubectl all use it automatically
export AWS_PROFILE=$PROFILE

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


echo "========================================================"
echo "✅ Setup Complete!"
echo "========================================================"
