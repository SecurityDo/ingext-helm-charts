#!/bin/bash
# Usage: ./s3_policy_gen.sh <bucket_name> [prefix]

BUCKET=$1
PREFIX=$2

if [ -z "$BUCKET" ]; then
    echo "Error: Bucket name is required." >&2
    echo "Usage: $0 <bucket_name> [prefix]" >&2
    exit 1
fi

# If prefix is provided, ensure it doesn't start with / and ends with /*
# If no prefix, default to wildcard for whole bucket
if [ -n "$PREFIX" ]; then
    # Remove leading slash if present
    CLEAN_PREFIX="${PREFIX#/}"
    RESOURCE_PATH="$CLEAN_PREFIX*"
else
    RESOURCE_PATH="*"
fi

cat <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:PutObject",
                "s3:ListBucket"
            ],
            "Resource": [
                "arn:aws:s3:::${BUCKET}",
                "arn:aws:s3:::${BUCKET}/${RESOURCE_PATH}"
            ]
        }
    ]
}
EOF
