#!/bin/bash

# ==============================================================================
# Script: external-role_setup.sh (v3 - Enhanced Workflow)
# Purpose: Sets up Cross-Account IAM Role Chaining with Validation & Registration.
# Usage: 
#   File: ./external-role_setup.sh <local_profile> <remote_profile> <remote_role> <iam_policy_file>
#   Pipe: cat policy.json | ./external-role_setup.sh <local_profile> <remote_profile> <remote_role> -
# ==============================================================================

set -e
set -o pipefail

if [ "$#" -ne 4 ]; then
    echo "Usage: $0 <local_profile> <remote_profile> <remote_role> <policy_file_or_dash>"
    echo "Example: $0 ingext-prod customer-dev IngextS3AccessRole s3-policy.json"
    exit 1
fi

LOCAL_PROFILE=$1
REMOTE_PROFILE=$2
TARGET_ROLE_NAME=$3
POLICY_ARG=$4

# --- 1. Validate Input Role Name ---
# AWS Role names must be alphanumeric, including the following common characters: _+=,.@-
if [[ ! "$TARGET_ROLE_NAME" =~ ^[a-zA-Z0-9_+=,.@-]{1,64}$ ]]; then
    echo "Error: '$TARGET_ROLE_NAME' is not a valid AWS Role name."
    echo "Allowed characters: Alphanumeric and _+=,.@-"
    exit 1
fi

# --- 2. Handle Input (File vs Pipe) ---
TEMP_POLICY_JSON="temp_policy_input.json"

if [ "$POLICY_ARG" == "-" ]; then
    echo ">>> Reading policy from Standard Input..."
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

# --- 3. Identify Context ---
POD_ROLE_NAME=$(ingext eks get-pod-role)
echo "Pod Role: $POD_ROLE_NAME"

LOCAL_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$LOCAL_PROFILE")
REMOTE_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$REMOTE_PROFILE")

# --- 4. Remote Role Setup ---
ROLE_WAS_CREATED=false

# Construct the Trust Policy (Allowing the Local Pod Role to assume this Remote Role)
TRUST_POLICY_FILE="trust-policy-cross-temp.json"
cat > "$TRUST_POLICY_FILE" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::${LOCAL_ACCOUNT_ID}:role/${POD_ROLE_NAME}"
      },
      "Action": ["sts:AssumeRole","sts:TagSession"]
    }
  ]
}
EOF

echo ">>> [Remote Account] Checking Role '$TARGET_ROLE_NAME'..."

if aws iam get-role --role-name "$TARGET_ROLE_NAME" --profile "$REMOTE_PROFILE" > /dev/null 2>&1; then
    echo "   Role already exists. Skipping creation."
else
    echo "   Role does not exist. Creating..."
    
    # Create with a safe placeholder policy first to avoid potential Principal errors
    PLACEHOLDER_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"AWS":"arn:aws:iam::'$REMOTE_ACCOUNT_ID':root"},"Action":"sts:AssumeRole"}]}'
    
    aws iam create-role \
        --role-name "$TARGET_ROLE_NAME" \
        --assume-role-policy-document "$PLACEHOLDER_POLICY" \
        --profile "$REMOTE_PROFILE" > /dev/null
    
    echo "   Waiting for role to propagate..."
    aws iam wait role-exists --role-name "$TARGET_ROLE_NAME" --profile "$REMOTE_PROFILE"
    
    ROLE_WAS_CREATED=true
fi

# Update Trust Policy to the real one (Local Pod Role)
echo "   Updating Trust Policy..."
aws iam update-assume-role-policy \
    --role-name "$TARGET_ROLE_NAME" \
    --policy-document file://"$TRUST_POLICY_FILE" \
    --profile "$REMOTE_PROFILE"

# Attach the Input IAM Policy (Permissions)
echo "   Attaching permission policy..."
aws iam put-role-policy \
    --role-name "$TARGET_ROLE_NAME" \
    --policy-name "${TARGET_ROLE_NAME}-Permissions" \
    --policy-document file://"$TEMP_POLICY_JSON" \
    --profile "$REMOTE_PROFILE"

# --- 5. Local Account Setup ---
# Allow the Pod Role to assume the Remote Role
ASSUME_POLICY_FILE="assume-policy-cross-temp.json"
cat > "$ASSUME_POLICY_FILE" <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["sts:AssumeRole","sts:TagSession"],
            "Resource": "arn:aws:iam::${REMOTE_ACCOUNT_ID}:role/${TARGET_ROLE_NAME}"
        }
    ]
}
EOF

echo ">>> [Local Account] Authorizing '$POD_ROLE_NAME' to assume remote role..."
aws iam put-role-policy \
    --role-name "$POD_ROLE_NAME" \
    --policy-name "AllowAssume-${TARGET_ROLE_NAME}" \
    --policy-document file://"$ASSUME_POLICY_FILE" \
    --profile "$LOCAL_PROFILE"

# --- 6. Verification & Registration ---
REMOTE_ROLE_ARN="arn:aws:iam::${REMOTE_ACCOUNT_ID}:role/${TARGET_ROLE_NAME}"
echo ">>> Verifying connectivity..."

# Capture the output of the test command
TEST_RESULT=$(ingext eks test-assumed-role --roleArn "$REMOTE_ROLE_ARN")

if [ "$TEST_RESULT" == "OK" ]; then
    echo "   Verification Successful: OK"
else
    echo "   Verification Failed!"
    echo "   Output: $TEST_RESULT"
    echo "   Aborting registration."
    # Clean up temp files before exiting
    rm -f "$TRUST_POLICY_FILE" "$ASSUME_POLICY_FILE" "$TEMP_POLICY_JSON"
    exit 1
fi

# Only register if the role was newly created
if [ "$ROLE_WAS_CREATED" = true ]; then
    echo ">>> Registering new role with internal system..."
    
    # Execute registration and capture output
    REG_OUTPUT=$(ingext eks add-assumed-role --name "${REMOTE_ACCOUNT_ID}:${TARGET_ROLE_NAME}" --roleArn "$REMOTE_ROLE_ARN")
    
    echo "   Registration Result: $REG_OUTPUT"
else
    echo ">>> Role was pre-existing. Skipping registration step."
fi

# --- Cleanup ---
rm -f "$TRUST_POLICY_FILE" "$ASSUME_POLICY_FILE" "$TEMP_POLICY_JSON"

echo "--- Setup Complete ---"
echo "Target Role ARN: $REMOTE_ROLE_ARN"
