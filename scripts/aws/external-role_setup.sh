#!/bin/bash

# ==============================================================================
# Script: external-role_setup.sh
# Purpose: Sets up Cross-Account IAM Role Chaining.
# Usage: ./external-role_setup.sh <local_profile> <ingext-sa-role> <remote_profile> <remote_role> <iam_policy_file>
# ==============================================================================

# 1. Input Validation
if [ "$#" -ne 5 ]; then
    echo "Usage: $0 <local_profile> <ingext-sa-role> <remote_profile> <remote_role> <iam_policy_file>"
    echo "Example: $0 ingext-prod ingext-sa-role customer-dev IngextS3AccessRole s3-policy.json"
    exit 1
fi

LOCAL_PROFILE=$1
SOURCE_ROLE_NAME=$2
REMOTE_PROFILE=$3
TARGET_ROLE_NAME=$4
POLICY_FILE=$5

# Check if policy file exists
if [ ! -f "$POLICY_FILE" ]; then
    echo "Error: Policy file '$POLICY_FILE' not found."
    exit 1
fi

echo "--- Starting Cross-Account IAM Setup ---"

# 2. Get AWS Account IDs
echo ">>> Fetching Account IDs..."

LOCAL_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$LOCAL_PROFILE")
if [ -z "$LOCAL_ACCOUNT_ID" ]; then
    echo "Error: Could not retrieve Local Account ID via profile '$LOCAL_PROFILE'."
    exit 1
fi
echo "    Local Account (Source):  $LOCAL_ACCOUNT_ID"

REMOTE_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$REMOTE_PROFILE")
if [ -z "$REMOTE_ACCOUNT_ID" ]; then
    echo "Error: Could not retrieve Remote Account ID via profile '$REMOTE_PROFILE'."
    exit 1
fi
echo "    Remote Account (Target): $REMOTE_ACCOUNT_ID"

# 3. Create Trust Policy (Target Account Side)
# This allows the LOCAL role to assume the REMOTE role
TRUST_POLICY_FILE="trust-policy-cross-temp.json"

cat > "$TRUST_POLICY_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::${LOCAL_ACCOUNT_ID}:role/${SOURCE_ROLE_NAME}"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# 4. Create/Update Remote Role (Target Account)
echo ">>> [Remote Account] Configuring Role '$TARGET_ROLE_NAME'..."

aws iam create-role \
    --role-name "$TARGET_ROLE_NAME" \
    --assume-role-policy-document file://"$TRUST_POLICY_FILE" \
    --profile "$REMOTE_PROFILE" > /dev/null 2>&1

if [ $? -eq 0 ]; then
    echo "    Role created successfully."
else
    echo "    Role might already exist. Updating trust policy..."
    aws iam update-assume-role-policy \
        --role-name "$TARGET_ROLE_NAME" \
        --policy-document file://"$TRUST_POLICY_FILE" \
        --profile "$REMOTE_PROFILE"
fi

# 5. Attach Permissions to Remote Role (Target Account)
echo ">>> [Remote Account] Attaching permissions from '$POLICY_FILE'..."
aws iam put-role-policy \
    --role-name "$TARGET_ROLE_NAME" \
    --policy-name "${TARGET_ROLE_NAME}-Permissions" \
    --policy-document file://"$POLICY_FILE" \
    --profile "$REMOTE_PROFILE"

# 6. Update Source Role (Local Account)
# We need to tell the source role: "You are allowed to jump into the Remote Account"
ASSUME_POLICY_FILE="assume-policy-cross-temp.json"
cat > "$ASSUME_POLICY_FILE" <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": "sts:AssumeRole",
            "Resource": "arn:aws:iam::${REMOTE_ACCOUNT_ID}:role/${TARGET_ROLE_NAME}"
        }
    ]
}
EOF

echo ">>> [Local Account] Authorizing '$SOURCE_ROLE_NAME' to assume remote role..."
aws iam put-role-policy \
    --role-name "$SOURCE_ROLE_NAME" \
    --policy-name "AllowAssume-${TARGET_ROLE_NAME}" \
    --policy-document file://"$ASSUME_POLICY_FILE" \
    --profile "$LOCAL_PROFILE"

# 7. Cleanup
rm "$TRUST_POLICY_FILE" "$ASSUME_POLICY_FILE"

echo "--- Setup Complete ---"
echo "1. Source: arn:aws:iam::${LOCAL_ACCOUNT_ID}:role/${SOURCE_ROLE_NAME}"
echo "2. Target: arn:aws:iam::${REMOTE_ACCOUNT_ID}:role/${TARGET_ROLE_NAME}"
echo "3. Trust established successfully."
