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


# --- S3 Bucket Name Validation Logic ---
validate_bucket_name() {
    local name="$1"

    # Rule 1: Length must be between 3 and 63 characters
    if [[ ${#name} -lt 3 || ${#name} -gt 63 ]]; then
        echo "Error: Bucket name must be between 3 and 63 characters long."
        return 1
    fi

    # Rule 2: Must consist only of lowercase letters, numbers, dots (.), and hyphens (-)
    if [[ ! "$name" =~ ^[a-z0-9.-]+$ ]]; then
        echo "Error: Bucket name can only contain lowercase letters, numbers, dots (.), and hyphens (-)."
        return 1
    fi

    # Rule 3: Must begin and end with a letter or number
    if [[ ! "$name" =~ ^[a-z0-9] ]] || [[ ! "$name" =~ [a-z0-9]$ ]]; then
        echo "Error: Bucket name must begin and end with a letter or number."
        return 1
    fi

    # Rule 4: Must not contain two adjacent periods
    if [[ "$name" =~ \.\. ]]; then
        echo "Error: Bucket name cannot contain two adjacent periods (..)."
        return 1
    fi

    # Rule 5: Must not be formatted as an IP address (e.g., 192.168.5.4)
    if [[ "$name" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
        echo "Error: Bucket name cannot be formatted as an IP address."
        return 1
    fi

    # Rule 6: Should not start with xn-- (compatibility mode)
    if [[ "$name" =~ ^xn-- ]]; then
        echo "Error: Bucket name should not start with 'xn--'."
        return 1
    fi

    # Rule 7: Should not end with -s3alias
    if [[ "$name" =~ -s3alias$ ]]; then
        echo "Error: Bucket name should not end with '-s3alias'."
        return 1
    fi

    return 0
}

# Execute Validation
if ! validate_bucket_name "$BUCKET_NAME"; then
    echo "Validation Failed. Exiting."
    exit 1
fi

echo "Bucket name '$BUCKET_NAME' is valid. Proceeding..."

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
