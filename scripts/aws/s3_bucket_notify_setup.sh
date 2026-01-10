#!/bin/bash

# ==============================================================================
# Script: s3_bucket_notify_setup.sh
# Purpose: Sets up SQS, wires S3 notifications, and generates consumer IAM policy.
# Usage: ./s3_bucket_notify_setup.sh <profile> <region> <bucket> <prefix> <queue_name>
# ==============================================================================

set -e
set -o pipefail

if [ "$#" -ne 5 ]; then
    echo "Usage: $0 <profile> <region> <bucket> <prefix> <queue_name>" >&2
    exit 1
fi

PROFILE=$1
REGION=$2
BUCKET=$3
PREFIX=$4
QUEUE_NAME=$5

# Temp file cleanup
TEMP_SQS_POLICY="temp_sqs_policy.json"
TEMP_ATTRIBUTES="temp_attributes.json"
TEMP_NOTIFY_CONFIG="temp_notify_config.json"

cleanup() {
    rm -f "$TEMP_SQS_POLICY" "$TEMP_ATTRIBUTES" "$TEMP_NOTIFY_CONFIG"
}
trap cleanup EXIT

# Clean prefix
CLEAN_PREFIX=$(echo "$PREFIX" | sed 's/^\///') 

echo ">>> [Setup] Using Profile: $PROFILE | Region: $REGION" >&2

# 1. Get Account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$PROFILE")

# 2. Create SQS Queue
echo ">>> [SQS] Creating Queue: $QUEUE_NAME..." >&2
QUEUE_URL=$(aws sqs create-queue --queue-name "$QUEUE_NAME" --region "$REGION" --profile "$PROFILE" --query QueueUrl --output text)
QUEUE_ARN=$(aws sqs get-queue-attributes --queue-url "$QUEUE_URL" --attribute-names QueueArn --region "$REGION" --profile "$PROFILE" --query Attributes.QueueArn --output text)

echo "    URL: $QUEUE_URL" >&2
echo "    ARN: $QUEUE_ARN" >&2

# 3. Set SQS Access Policy (Using the 'Escape & Embed' Strategy)
echo ">>> [SQS] Attaching S3 access policy to Queue..." >&2

# A. Create the raw policy JSON
cat > "$TEMP_SQS_POLICY" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "s3.amazonaws.com" },
      "Action": "sqs:SendMessage",
      "Resource": "$QUEUE_ARN",
      "Condition": {
        "ArnEquals": { "aws:SourceArn": "arn:aws:s3:::$BUCKET" }
      }
    }
  ]
}
EOF

# B. Escape quotes and remove newlines from the policy so it can be a JSON string
ESCAPED_POLICY=$(cat "$TEMP_SQS_POLICY" | tr -d '\n' | sed 's/"/\\"/g')

# C. Create the Attributes JSON file expected by AWS CLI
#    The structure must be: { "Policy": "{\"Version\":...}" }
echo "{\"Policy\": \"$ESCAPED_POLICY\"}" > "$TEMP_ATTRIBUTES"

# D. Apply attributes using file:// (Bypasses shell quoting issues)
aws sqs set-queue-attributes \
    --queue-url "$QUEUE_URL" \
    --attributes file://"$TEMP_ATTRIBUTES" \
    --region "$REGION" \
    --profile "$PROFILE"

# 4. Configure S3 Bucket Notifications
echo ">>> [S3] Configuring Bucket Notifications for '$BUCKET'..." >&2

if [ -z "$CLEAN_PREFIX" ]; then
    cat > "$TEMP_NOTIFY_CONFIG" <<EOF
{
    "QueueConfigurations": [
        {
            "QueueArn": "$QUEUE_ARN",
            "Events": ["s3:ObjectCreated:*"]
        }
    ]
}
EOF
else
    cat > "$TEMP_NOTIFY_CONFIG" <<EOF
{
    "QueueConfigurations": [
        {
            "QueueArn": "$QUEUE_ARN",
            "Events": ["s3:ObjectCreated:*"],
            "Filter": {
                "Key": {
                    "FilterRules": [
                        {
                            "Name": "prefix",
                            "Value": "$CLEAN_PREFIX"
                        }
                    ]
                }
            }
        }
    ]
}
EOF
fi

aws s3api put-bucket-notification-configuration \
    --bucket "$BUCKET" \
    --notification-configuration file://"$TEMP_NOTIFY_CONFIG" \
    --region "$REGION" \
    --profile "$PROFILE"

echo "    Notification configuration applied." >&2

# 5. Generate Consumer IAM Policy (stdout)
echo ">>> [Policy] Generating IAM Policy for Ingext Application..." >&2

if [ -z "$CLEAN_PREFIX" ]; then
    S3_RESOURCE="arn:aws:s3:::${BUCKET}/*"
else
    S3_RESOURCE="arn:aws:s3:::${BUCKET}/${CLEAN_PREFIX}*"
fi

cat <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "S3Access",
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:ListBucket"
            ],
            "Resource": [
                "arn:aws:s3:::${BUCKET}",
                "${S3_RESOURCE}"
            ]
        },
        {
            "Sid": "SQSAccess",
            "Effect": "Allow",
            "Action": [
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:GetQueueUrl",
                "sqs:GetQueueAttributes"
            ],
            "Resource": "${QUEUE_ARN}"
        }
    ]
}
EOF
