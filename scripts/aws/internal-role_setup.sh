#!/bin/bash

# ==============================================================================
# Script: internal-role_setup.sh
# Purpose: Sets up IAM Role Chaining within the same AWS account.
# Usage: 
#   File: ./internal-role_setup.sh <profile> <src_role> <tgt_role> <policy_file>
#   Pipe: ./s3_gen.sh ... | ./internal-role_setup.sh <profile> <src_role> <tgt_role> -
# ==============================================================================

# 1. Input Validation
if [ "$#" -ne 4 ]; then
    echo "Usage: $0 <profile> <source_role_name> <target_role_name> <policy_file_or_dash>"
    echo "Example: ./s3_gen.sh my-bucket | $0 default ingext-sa-role IngextS3AccessRole -"
    exit 1
fi

PROFILE=$1
SOURCE_ROLE_NAME=$2
TARGET_ROLE_NAME=$3
POLICY_ARG=$4

# --- NEW LOGIC: Handle Pipe Input ---
TEMP_POLICY_JSON="temp_policy_internal.json"

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
    # Copy to temp file for consistent processing
    cp "$POLICY_ARG" "$TEMP_POLICY_JSON"
fi
# -------------------------------------

echo "--- Starting IAM Setup ---"

# 2. Get AWS Account ID
echo ">>> Fetching AWS Account ID using profile '$PROFILE'..."
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$PROFILE")

if [ -z "$ACCOUNT_ID" ]; then
    echo "Error: Could not retrieve AWS Account ID. Check your credentials/profile."
    rm "$TEMP_POLICY_JSON"
    exit 1
fi

echo "    Account ID: $ACCOUNT_ID"

# 3. Create Trust Policy (Temporary File)
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

# 4. Create the New Role (Target Role)
echo ">>> Creating role '$TARGET_ROLE_NAME'..."
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

# 5. Attach Permissions to the New Role (Using TEMP_POLICY_JSON)
echo ">>> Attaching permissions to '$TARGET_ROLE_NAME'..."
aws iam put-role-policy \
    --role-name "$TARGET_ROLE_NAME" \
    --policy-name "${TARGET_ROLE_NAME}-Permissions" \
    --policy-document file://"$TEMP_POLICY_JSON" \
    --profile "$PROFILE"

# 6. Update Source Role (ingext-sa-role) to allow assuming the New Role
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

echo ">>> Updating Source Role '$SOURCE_ROLE_NAME'..."
aws iam put-role-policy \
    --role-name "$SOURCE_ROLE_NAME" \
    --policy-name "AllowAssume-${TARGET_ROLE_NAME}" \
    --policy-document file://"$ASSUME_POLICY_FILE" \
    --profile "$PROFILE"

# 7. Cleanup
rm "$TRUST_POLICY_FILE" "$ASSUME_POLICY_FILE" "$TEMP_POLICY_JSON"

echo "--- Setup Complete ---"
echo "1. Created/Updated Role: $TARGET_ROLE_NAME"
echo "2. Attached Policy (from input)"
echo "3. Authorized '$SOURCE_ROLE_NAME' to assume '$TARGET_ROLE_NAME'"
