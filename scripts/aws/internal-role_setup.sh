#!/bin/bash

# ==============================================================================
# Script: internal-role_setup.sh
# Purpose: Sets up IAM Role Chaining within the same AWS account.
# Usage: ./internal-role_setup.sh <profile> <ingext-sa-role> <new_role> <iam_policy_file>
# ==============================================================================

# 1. Input Validation
if [ "$#" -ne 4 ]; then
    echo "Usage: $0 <profile> <source_role_name> <target_role_name> <iam_policy_file>"
    echo "Example: $0 default ingext-sa-role IngextS3AccessRole s3-policy.json"
    exit 1
fi

PROFILE=$1
SOURCE_ROLE_NAME=$2
TARGET_ROLE_NAME=$3
POLICY_FILE=$4

# Check if policy file exists
if [ ! -f "$POLICY_FILE" ]; then
    echo "Error: Policy file '$POLICY_FILE' not found."
    exit 1
fi

echo "--- Starting IAM Setup ---"

# 2. Get AWS Account ID
echo ">>> Fetching AWS Account ID using profile '$PROFILE'..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$PROFILE")

if [ -z "$ACCOUNT_ID" ]; then
    echo "Error: Could not retrieve AWS Account ID. Check your credentials/profile."
    exit 1
fi

echo "    Account ID: $ACCOUNT_ID"

# 3. Create Trust Policy (Temporary File)
# This policy tells the NEW role to trust the OLD role.
TRUST_POLICY_FILE="trust-policy-temp.json"

cat > "$TRUST_POLICY_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::${ACCOUNT_ID}:role/${SOURCE_ROLE_NAME}"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

echo ">>> Generated Trust Policy trusting: $SOURCE_ROLE_NAME"

# 4. Create the New Role (Target Role)
echo ">>> Creating role '$TARGET_ROLE_NAME'..."
# Use || true to suppress error if role already exists, but capturing output would be cleaner. 
# For simplicity, we attempt create. If it exists, we just update policies.
aws iam create-role \
    --role-name "$TARGET_ROLE_NAME" \
    --assume-role-policy-document file://"$TRUST_POLICY_FILE" \
    --profile "$PROFILE" > /dev/null 2>&1

if [ $? -eq 0 ]; then
    echo "    Role created successfully."
else
    echo "    Role might already exist. Updating trust policy..."
    aws iam update-assume-role-policy \
        --role-name "$TARGET_ROLE_NAME" \
        --policy-document file://"$TRUST_POLICY_FILE" \
        --profile "$PROFILE"
fi

# 5. Attach Permissions to the New Role (from file)
echo ">>> Attaching permissions from '$POLICY_FILE' to '$TARGET_ROLE_NAME'..."
aws iam put-role-policy \
    --role-name "$TARGET_ROLE_NAME" \
    --policy-name "${TARGET_ROLE_NAME}-Permissions" \
    --policy-document file://"$POLICY_FILE" \
    --profile "$PROFILE"

# 6. Update Source Role (ingext-sa-role) to allow assuming the New Role
# This creates a specific inline policy on the source role.
ASSUME_POLICY_FILE="assume-policy-temp.json"
cat > "$ASSUME_POLICY_FILE" <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": "sts:AssumeRole",
            "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${TARGET_ROLE_NAME}"
        }
    ]
}
EOF

echo ">>> Updating Source Role '$SOURCE_ROLE_NAME' to allow assuming target..."
aws iam put-role-policy \
    --role-name "$SOURCE_ROLE_NAME" \
    --policy-name "AllowAssume-${TARGET_ROLE_NAME}" \
    --policy-document file://"$ASSUME_POLICY_FILE" \
    --profile "$PROFILE"

# 7. Cleanup
rm "$TRUST_POLICY_FILE" "$ASSUME_POLICY_FILE"

echo "--- Setup Complete ---"
echo "1. Created/Updated Role: $TARGET_ROLE_NAME"
echo "2. Attached Policy: $POLICY_FILE"
echo "3. Authorized '$SOURCE_ROLE_NAME' to assume '$TARGET_ROLE_NAME'"
