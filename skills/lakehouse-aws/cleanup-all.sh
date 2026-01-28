#!/usr/bin/env bash

set -uo pipefail

###############################################################################
# Comprehensive AWS Lakehouse Cleanup
#
# Deletes all EKS clusters, S3 buckets, and related resources
# Works with namespace-scoped env files (lakehouse_{namespace}.env)
###############################################################################

export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_REGION="${AWS_REGION:-us-east-2}"

log() {
  echo ""
  echo "==> $*"
}

error() {
  echo "❌ ERROR: $*" >&2
}

# Get AWS account ID
ACCOUNT_ID=$(aws sts get-caller-identity --profile "$AWS_PROFILE" --query Account --output text 2>/dev/null)
if [[ -z "$ACCOUNT_ID" ]]; then
  error "Failed to get AWS account ID. Check your AWS credentials."
  exit 1
fi

log "AWS Account: $ACCOUNT_ID"
log "Region: $AWS_REGION"
log "Profile: $AWS_PROFILE"

# Confirmation
echo ""
echo "⚠️  WARNING: This will DELETE ALL EKS clusters and S3 buckets related to lakehouse installs!"
echo ""
read -p "Are you sure you want to continue? Type 'DELETE' to confirm: " -r
if [[ ! $REPLY == "DELETE" ]]; then
  echo "Aborted."
  exit 0
fi

# -------- 1. List and Delete EKS Clusters --------
log "Phase 1: Deleting EKS Clusters..."

CLUSTERS=$(aws eks list-clusters --region "$AWS_REGION" --profile "$AWS_PROFILE" --output json 2>/dev/null | jq -r '.clusters[]' 2>/dev/null || echo "")

if [[ -z "$CLUSTERS" ]]; then
  log "No EKS clusters found."
else
  for cluster in $CLUSTERS; do
    log "Deleting cluster: $cluster"
    eksctl delete cluster --name "$cluster" --region "$AWS_REGION" --profile "$AWS_PROFILE" --wait || {
      error "Failed to delete cluster $cluster (may already be deleted)"
    }
  done
fi

# -------- 2. Delete S3 Buckets --------
log "Phase 2: Deleting S3 Buckets..."

# List all buckets
BUCKETS=$(aws s3 ls --region "$AWS_REGION" --profile "$AWS_PROFILE" 2>/dev/null | awk '{print $3}' || echo "")

# Delete buckets that match our patterns
for bucket in $BUCKETS; do
  if [[ "$bucket" =~ ^ingext.*lakehouse.*[0-9]+$ ]] || \
     [[ "$bucket" =~ ^ingext.*datalake.*[0-9]+$ ]] || \
     [[ "$bucket" == "ingextlakehouse"* ]]; then
    log "Deleting S3 bucket: $bucket"
    aws s3 rb "s3://$bucket" --force --region "$AWS_REGION" --profile "$AWS_PROFILE" 2>/dev/null || {
      error "Failed to delete bucket $bucket (may not be empty or already deleted)"
    }
  fi
done

# Also try to delete the specific bucket we know about
if aws s3 ls "s3://ingextlakehouse${ACCOUNT_ID}" --region "$AWS_REGION" --profile "$AWS_PROFILE" &>/dev/null; then
  log "Deleting S3 bucket: ingextlakehouse${ACCOUNT_ID}"
  aws s3 rb "s3://ingextlakehouse${ACCOUNT_ID}" --force --region "$AWS_REGION" --profile "$AWS_PROFILE" || true
fi

# -------- 3. Clean up IAM Roles and Policies --------
log "Phase 3: Cleaning up IAM Roles and Policies..."

delete_iam_role() {
  local role="$1"
  if aws iam get-role --role-name "$role" --profile "$AWS_PROFILE" &>/dev/null; then
    log "  Deleting IAM role: $role"
    # Detach all policies
    local policies=$(aws iam list-attached-role-policies --role-name "$role" --profile "$AWS_PROFILE" --query 'AttachedPolicies[*].PolicyArn' --output text 2>/dev/null || echo "")
    for p in $policies; do
      [[ -n "$p" ]] && aws iam detach-role-policy --role-name "$role" --policy-arn "$p" --profile "$AWS_PROFILE" 2>/dev/null || true
    done
    # Delete inline policies
    local inline_policies=$(aws iam list-role-policies --role-name "$role" --profile "$AWS_PROFILE" --query 'PolicyNames[]' --output text 2>/dev/null || echo "")
    for p in $inline_policies; do
      [[ -n "$p" ]] && aws iam delete-role-policy --role-name "$role" --policy-name "$p" --profile "$AWS_PROFILE" 2>/dev/null || true
    done
    # Delete the role
    aws iam delete-role --role-name "$role" --profile "$AWS_PROFILE" 2>/dev/null || true
  fi
}

delete_iam_policy() {
  local policy_name="$1"
  local policy_arn="arn:aws:iam::${ACCOUNT_ID}:policy/${policy_name}"
  if aws iam get-policy --policy-arn "$policy_arn" --profile "$AWS_PROFILE" &>/dev/null; then
    log "  Deleting IAM policy: $policy_name"
    # Delete all non-default policy versions
    local versions=$(aws iam list-policy-versions --policy-arn "$policy_arn" --profile "$AWS_PROFILE" --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text 2>/dev/null || echo "")
    for v in $versions; do
      [[ -n "$v" ]] && aws iam delete-policy-version --policy-arn "$policy_arn" --version-id "$v" --profile "$AWS_PROFILE" 2>/dev/null || true
    done
    # Delete the policy
    aws iam delete-policy --policy-arn "$policy_arn" --profile "$AWS_PROFILE" 2>/dev/null || true
  fi
}

# Delete roles for common cluster names
for cluster in ingextlakehouse testskillcluster; do
  delete_iam_role "KarpenterControllerRole-${cluster}"
  delete_iam_role "KarpenterNodeRole-${cluster}"
  delete_iam_role "AWSLoadBalancerControllerRole_${cluster}"
  
  delete_iam_policy "KarpenterControllerPolicy-${cluster}"
  delete_iam_policy "AWSLoadBalancerControllerIAMPolicy_${cluster}"
done

# Delete service account roles (try common namespaces)
for ns in ingext ingext-dev ingext-prod; do
  delete_iam_role "ingext_${ns}-sa"
  delete_iam_policy "ingext_${ns}-sa_S3_Policy"
done

# -------- 4. Clean up EBS Volumes --------
log "Phase 4: Cleaning up EBS Volumes..."

VOLUMES=$(aws ec2 describe-volumes --region "$AWS_REGION" --profile "$AWS_PROFILE" \
  --filters "Name=status,Values=available" \
  --query "Volumes[?contains(Tags[?Key=='kubernetes.io/created-for/pvc/namespace'].Value, 'ingext') || contains(Tags[?Key=='Name'].Value, 'ingext')].VolumeId" \
  --output text 2>/dev/null || echo "")

if [[ -n "$VOLUMES" ]]; then
  for vol in $VOLUMES; do
    log "  Deleting EBS volume: $vol"
    aws ec2 delete-volume --volume-id "$vol" --region "$AWS_REGION" --profile "$AWS_PROFILE" 2>/dev/null || true
  done
else
  log "No orphaned EBS volumes found."
fi

# -------- 5. Clean up Local Env Files --------
log "Phase 5: Cleaning up local env files..."

cd /Users/chris/Projects/ingext-helm-charts || exit 1

ENV_FILES=$(find . -name "lakehouse_*.env" -type f 2>/dev/null || echo "")

if [[ -n "$ENV_FILES" ]]; then
  for env_file in $ENV_FILES; do
    log "  Removing: $env_file"
    rm -f "$env_file" || true
  done
else
  log "No local env files found."
fi

# Also remove old format
if [[ -f "./lakehouse-aws.env" ]]; then
  log "  Removing old format: ./lakehouse-aws.env"
  rm -f "./lakehouse-aws.env" || true
fi

# -------- 6. Clean up kubeconfig entries --------
log "Phase 6: Cleaning up kubeconfig entries..."

if command -v kubectl &>/dev/null; then
  for cluster in ingextlakehouse testskillcluster; do
    kubectl config delete-cluster "${cluster}" 2>/dev/null || true
    kubectl config delete-context "${cluster}" 2>/dev/null || true
    kubectl config unset "users.${cluster}" 2>/dev/null || true
  done
  log "Kubeconfig cleaned."
else
  log "kubectl not found, skipping kubeconfig cleanup."
fi

log "========================================================"
log "✅ Cleanup Complete!"
log "========================================================"
log ""
log "Deleted:"
log "  - EKS Clusters: $(echo $CLUSTERS | wc -w | tr -d ' ') clusters"
log "  - S3 Buckets: (check above for details)"
log "  - IAM Roles and Policies"
log "  - EBS Volumes"
log "  - Local env files"
log ""
log "You can now start fresh with a new installation."
