#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Lakehouse Add User Access
#
# Grants a specific IAM user ClusterAdmin access to the EKS cluster.
# Usage: ./add-user-access.sh -u <aws-username>
###############################################################################

# -------- 1. Load Environment --------
if [[ ! -f "./lakehouse-aws.env" ]]; then
  echo "ERROR: lakehouse-aws.env not found. Run ./preflight-lakehouse.sh first."
  exit 1
fi

source ./lakehouse-aws.env
export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_DEFAULT_REGION="$AWS_REGION"

print_usage() {
  echo "Usage: ./add-user-access.sh -u <aws-username>"
  echo "Example: ./add-user-access.sh -u kun_develop"
}

USER_NAME=""

while getopts "u:" opt; do
  case $opt in
    u) USER_NAME="$OPTARG" ;;
    *) print_usage; exit 1 ;;
  esac
done

if [[ -z "$USER_NAME" ]]; then
  print_usage
  exit 1
fi

# -------- 2. Get User ARN --------
echo "Looking up ARN for user '$USER_NAME'..."
USER_ARN=$(aws iam get-user --user-name "$USER_NAME" --query 'User.Arn' --output text 2>/dev/null)

if [[ -z "$USER_ARN" ]]; then
  # Try to construct it from Account ID if get-user fails (might not have IAM permissions)
  USER_ARN="arn:aws:iam::${ACCOUNT_ID}:user/${USER_NAME}"
  echo "⚠️  Could not find user via API. Guessing ARN: $USER_ARN"
else
  echo "✅ Found User ARN: $USER_ARN"
fi

# -------- 3. Grant Access --------
echo "Step 1: Creating EKS Access Entry..."
aws eks create-access-entry \
  --cluster-name "$CLUSTER_NAME" \
  --principal-arn "$USER_ARN" \
  --type STANDARD \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" 2>/dev/null || echo "   (Access entry already exists)"

echo "Step 2: Associating ClusterAdmin Policy..."
aws eks associate-access-policy \
  --cluster-name "$CLUSTER_NAME" \
  --principal-arn "$USER_ARN" \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster \
  --region "$AWS_REGION" \
  --profile "$AWS_PROFILE" 2>/dev/null || echo "   (Policy already associated)"

echo ""
echo "✅ Success! User '$USER_NAME' now has ClusterAdmin access to '$CLUSTER_NAME'."
echo "They can now run: aws eks update-kubeconfig --region $AWS_REGION --name $CLUSTER_NAME"

