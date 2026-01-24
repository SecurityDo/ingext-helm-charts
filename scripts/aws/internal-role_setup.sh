#!/bin/bash

# ==============================================================================
# Script: internal-role_setup.sh (v3 - Enhanced Workflow)
# Purpose: Sets up IAM Role Chaining within the same AWS account.
# Usage: 
#   File: ./internal-role_setup.sh <profile> <target_role_name> <policy_file>
#   Pipe: cat policy.json | ./internal-role_setup.sh <profile> <target_role_name> -
# ==============================================================================

set -e
set -o pipefail

# 1. Input Validation
if [ "$#" -ne 3 ]; then
    echo "Usage: $0 <profile> <target_role_name> <policy_file_or_dash>"
    echo "Example: ./s3_gen.sh my-bucket | $0 default IngextS3AccessRole -"
    exit 1
fi

PROFILE=$1
TARGET_ROLE_NAME=$2
POLICY_ARG=$3

# --- 2. Validate Role Name ---
# AWS Role names must be alphanumeric, including the following common characters: _+=,.@-
if [[ ! "$TARGET_ROLE_NAME" =~ ^[a-zA-Z0-9_+=,.@-]{1,64}$ ]]; then
    echo "Error: '$TARGET_ROLE_NAME' is not a valid AWS Role name."
    echo "Allowed characters: Alphanumeric and _+=,.@-"
    exit 1
fi

# --- 3. Handle Input (File vs Pipe) ---
TEMP_POLICY_JSON="temp_policy_internal.json"

if [ "$POLICY_ARG" == "-" ]; then
    echo ">>> Reading policy from Standard Input (pipe)..."
    cat > "$TEMP_POLICY_JSON"
    if [ ! -s "$TEMP_POLICY_JSON" ]; then
        echo "Error: No input received from pipe."
        rm "$TEMP_POLICY_JSON"
        exit 1
    fi
else
    if [ ! -f "$POLICY_ARG" ]; then
        echo "Error: Policy file '$POLICY_ARG' not found."
        exit 1
    fi
    cp "$POLICY_ARG" "$TEMP_POLICY_JSON"
fi

# --- 4. Identify Context ---
POD_ROLE_NAME=$(ingext eks get-pod-role)
echo "Pod Role: $POD_ROLE_NAME"

echo ">>> Fetching AWS Account ID using profile '$PROFILE'..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$PROFILE")

if [ -z "$ACCOUNT_ID" ]; then
    echo "Error: Could not retrieve AWS Account ID. Check your credentials/profile."
    rm "$TEMP_POLICY_JSON"
    exit 1
fi
echo "    Account ID: $ACCOUNT_ID"

# --- 5. Target Role Setup ---
ROLE_WAS_CREATED=false

# Construct Trust Policy (Allowing Pod Role to assume Target Role)
TRUST_POLICY_FILE="trust-policy-temp.json"
cat > "$TRUST_POLICY_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::${ACCOUNT_ID}:role/${POD_ROLE_NAME}"
      },
      "Action": ["sts:AssumeRole","sts:TagSession"]
    }
  ]
}
EOF

echo ">>> Checking Role '$TARGET_ROLE_NAME'..."

if aws iam get-role --role-name "$TARGET_ROLE_NAME" --profile "$PROFILE" > /dev/null 2>&1; then
    echo "    Role already exists. Skipping creation."
else
    echo "    Role does not exist. Creating..."
    
    # Create with "Safe" Placeholder Policy (Trust Root)
    # This prevents errors if the referencing principal (Pod Role) has issues.
    PLACEHOLDER_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::'$ACCOUNT_ID':root"},"Action":"sts:AssumeRole"}]}'

    aws iam create-role \
        --role-name "$TARGET_ROLE_NAME" \
        --assume-role-policy-document "$PLACEHOLDER_POLICY" \
        --profile "$PROFILE" > /dev/null

    echo "    Waiting for role to propagate..."
    aws iam wait role-exists --role-name "$TARGET_ROLE_NAME" --profile "$PROFILE"
    
    ROLE_WAS_CREATED=true
fi

# Update Trust Policy to the real one (Local Pod Role)
echo "    Updating Trust Policy..."
aws iam update-assume-role-policy \
    --role-name "$TARGET_ROLE_NAME" \
    --policy-document file://"$TRUST_POLICY_FILE" \
    --profile "$PROFILE"

# Attach Permissions to the Target Role
echo "    Attaching permissions..."
aws iam put-role-policy \
    --role-name "$TARGET_ROLE_NAME" \
    --policy-name "${TARGET_ROLE_NAME}-Permissions" \
    --policy-document file://"$TEMP_POLICY_JSON" \
    --profile "$PROFILE"

# --- 6. Update Source Role (Pod Role) ---
# Authorize the Pod Role to assume the Target Role
ASSUME_POLICY_FILE="assume-policy-temp.json"
cat > "$ASSUME_POLICY_FILE" <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["sts:AssumeRole","sts:TagSession"],
            "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${TARGET_ROLE_NAME}"
        }
    ]
}
EOF

echo ">>> Updating Source Role '$POD_ROLE_NAME'..."
aws iam put-role-policy \
    --role-name "$POD_ROLE_NAME" \
    --policy-name "AllowAssume-${TARGET_ROLE_NAME}" \
    --policy-document file://"$ASSUME_POLICY_FILE" \
    --profile "$PROFILE"

# --- 7. Verification & Registration ---
TARGET_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${TARGET_ROLE_NAME}"
echo ">>> Verifying connectivity..."

sleep 5

# Verify assumption capability
TEST_RESULT=$(ingext eks test-assumed-role --roleArn "$TARGET_ROLE_ARN")

if [ "$TEST_RESULT" == "OK" ]; then
    echo "    Verification Successful: OK"
else
    echo "    Verification Failed!"
    echo "    Output: $TEST_RESULT"
    echo "    Aborting registration."
    # Cleanup before exit
    rm -f "$TRUST_POLICY_FILE" "$ASSUME_POLICY_FILE" "$TEMP_POLICY_JSON"
    exit 1
fi

# Only register if newly created
if [ "$ROLE_WAS_CREATED" = true ]; then
    echo ">>> Registering new internal role..."
    
    # Note: Using "local:" prefix as requested
    REG_OUTPUT=$(ingext eks add-assumed-role --name "${ACCOUNT_ID}:${TARGET_ROLE_NAME}" --roleArn "$TARGET_ROLE_ARN")
    
    echo "    Registration Result: $REG_OUTPUT"
else
    echo ">>> Role was pre-existing. Skipping registration step."
fi

# --- Cleanup ---
rm -f "$TRUST_POLICY_FILE" "$ASSUME_POLICY_FILE" "$TEMP_POLICY_JSON"

echo "--- Setup Complete ---"
echo "Target Role ARN: $TARGET_ROLE_ARN"