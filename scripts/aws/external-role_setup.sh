#!/bin/bash

# ==============================================================================
# Script: external-role_setup.sh (v2 - Pipe Support)
# Purpose: Sets up Cross-Account IAM Role Chaining.
# Usage: 
#   File: ./external-role_setup.sh <local_profile> <ingext-sa-role> <remote_profile> <remote_role> <iam_policy_file>
#   OR Pipe: ./s3_gen.sh ... | ./external-role_setup.sh external-role_setup.sh <local_profile> <ingext-sa-role> <remote_profile> <remote_role> -
# ==============================================================================

# 1. FAIL-FAST CONFIGURATION
# set -e: Exit immediately if a command exits with a non-zero status.
# set -o pipefail: specific for pipelines (optional but good practice)
set -e
set -o pipefail

if [ "$#" -ne 5 ]; then
    echo "Usage: $0 <local_profile> <ingext-sa-role> <remote_profile> <remote_role> <policy_file_or_dash>"
    echo "Example: $0 ingext-prod ingext-sa-role customer-dev IngextS3AccessRole s3-policy.json"
    echo "        policy_gen.sh ... | $0 ingext-prod ingext-sa-role customer-dev IngextS3AccessRole -" 
    exit 1
fi

LOCAL_PROFILE=$1
SOURCE_ROLE_NAME=$2
REMOTE_PROFILE=$3
TARGET_ROLE_NAME=$4
POLICY_ARG=$5

# --- NEW LOGIC: Handle Pipe Input ---
TEMP_POLICY_JSON="temp_policy_input.json"

if [ "$POLICY_ARG" == "-" ]; then
    # Read from Stdin into a temp file
    echo ">>> Reading policy from Standard Input (pipe)..."
    cat > "$TEMP_POLICY_JSON"
    # Validate that we actually got data
    if [ ! -s "$TEMP_POLICY_JSON" ]; then
        echo "Error: No input received from pipe."
        rm "$TEMP_POLICY_JSON"
        exit 1
    fi
else
    # It's a file path
    if [ ! -f "$POLICY_ARG" ]; then
        echo "Error: Policy file '$POLICY_ARG' not found."
        exit 1
    fi
    # Copy to temp file to standardize processing
    cp "$POLICY_ARG" "$TEMP_POLICY_JSON"
fi
# -------------------------------------

echo "--- Starting Cross-Account IAM Setup ---"

# (Logic to get Account IDs remains the same - abbreviated for brevity)
# ... [Get LOCAL_ACCOUNT_ID and REMOTE_ACCOUNT_ID] ...
LOCAL_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$LOCAL_PROFILE")
REMOTE_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$REMOTE_PROFILE")

# Create Trust Policy
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

echo ">>> [Remote Account] Configuring Role '$TARGET_ROLE_NAME'..."
aws iam create-role --role-name "$TARGET_ROLE_NAME" --assume-role-policy-document file://"$TRUST_POLICY_FILE" --profile "$REMOTE_PROFILE" > /dev/null 2>&1 || \
aws iam update-assume-role-policy --role-name "$TARGET_ROLE_NAME" --policy-document file://"$TRUST_POLICY_FILE" --profile "$REMOTE_PROFILE"

# --- UPDATED: Use the TEMP_POLICY_JSON ---
echo ">>> [Remote Account] Attaching permissions..."
aws iam put-role-policy \
    --role-name "$TARGET_ROLE_NAME" \
    --policy-name "${TARGET_ROLE_NAME}-Permissions" \
    --policy-document file://"$TEMP_POLICY_JSON" \
    --profile "$REMOTE_PROFILE"

# Update Source Role (Assume Policy)
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

# Cleanup
rm "$TRUST_POLICY_FILE" "$ASSUME_POLICY_FILE" "$TEMP_POLICY_JSON"

echo "--- Setup Complete ---"
echo "1. Source: arn:aws:iam::${LOCAL_ACCOUNT_ID}:role/${SOURCE_ROLE_NAME}"
echo "2. Target: arn:aws:iam::${REMOTE_ACCOUNT_ID}:role/${TARGET_ROLE_NAME}"
echo "3. Trust established successfully."

