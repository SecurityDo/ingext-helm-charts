#!/usr/bin/env bash

set -uo pipefail

###############################################################################
# AWS Lakehouse Cleanup (Tear Down Stream + Datalake)
#
# Systematically deletes:
# 1. Helm releases
# 2. EKS cluster
# 3. S3 bucket
# 4. IAM roles/policies
# 5. EC2/EBS remnants
###############################################################################

# -------- 1. Load Environment --------
if [[ ! -f "./lakehouse-aws.env" ]]; then
  echo "ERROR: lakehouse-aws.env not found. Manual intervention required or re-run preflight."
  exit 1
fi

source ./lakehouse-aws.env
export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_DEFAULT_REGION="$AWS_REGION"

log() {
  echo ""
  echo "==> $*"
}

ask_confirm() {
  read -p "$1 [y/N]: " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    return 1
  fi
  return 0
}

log "Starting Lakehouse cleanup for cluster '$CLUSTER_NAME' in '$AWS_REGION'..."

if ! ask_confirm "Are you sure you want to DELETE EVERYTHING? (Data will be lost)"; then
  echo "Aborted."
  exit 0
fi

# -------- 2. Uninstall Helm --------
log "Phase 1: Uninstalling Helm Releases..."
HELM_RELEASES=(
  "ingext-ingress"
  "ingext-lake"
  "ingext-s3-lake"
  "ingext-manager-role"
  "ingext-search-pool"
  "ingext-merge-pool"
  "ingext-lake-config"
  "ingext-community"
  "ingext-community-init"
  "ingext-community-config"
  "etcd-single-cronjob"
  "etcd-single"
  "ingext-stack"
  "aws-load-balancer-controller"
  "karpenter"
  "ingext-aws-gp3"
)

for rel in "${HELM_RELEASES[@]}"; do
  echo "  Deleting $rel..."
  helm uninstall "$rel" -n "$NAMESPACE" 2>/dev/null || true
  helm uninstall "$rel" -n kube-system 2>/dev/null || true
done

# -------- 3. Delete Cluster --------
log "Phase 2: Deleting EKS Cluster '$CLUSTER_NAME' (this takes ~15 min)..."
eksctl delete cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" --wait || true

# -------- 4. Delete Storage --------
log "Phase 3: Deleting S3 Bucket '$S3_BUCKET'..."
aws s3 rb "s3://$S3_BUCKET" --force --region "$AWS_REGION" || true

# -------- 5. Delete IAM Remnants --------
log "Phase 4: Cleaning up IAM Roles and Policies..."

delete_role() {
  local role="$1"
  echo "  Deleting role: $role..."
  local policies=$(aws iam list-attached-role-policies --role-name "$role" --query 'AttachedPolicies[*].PolicyArn' --output text 2>/dev/null || echo "")
  for p in $policies; do
    aws iam detach-role-policy --role-name "$role" --policy-arn "$p" || true
  done
  aws iam delete-role --role-name "$role" || true
}

delete_policy() {
  local name="$1"
  local arn="arn:aws:iam::$ACCOUNT_ID:policy/$name"
  echo "  Deleting policy: $name..."
  aws iam delete-policy --policy-arn "$arn" 2>/dev/null || true
}

delete_role "ingext_${NAMESPACE}-sa"
delete_role "KarpenterControllerRole-${CLUSTER_NAME}"
delete_role "KarpenterNodeRole-${CLUSTER_NAME}"
delete_role "AWSLoadBalancerControllerRole_${CLUSTER_NAME}"

delete_policy "ingext_${NAMESPACE}-sa_S3_Policy"
delete_policy "KarpenterControllerPolicy-${CLUSTER_NAME}"
delete_policy "AWSLoadBalancerControllerIAMPolicy_${CLUSTER_NAME}"

# -------- 6. Final Sweep --------
log "Phase 5: Cleaning up EBS Volumes and EC2 remnants..."
# Search for volumes tagged for the namespace
VOLUME_IDS=$(aws ec2 describe-volumes --region "$AWS_REGION" --filters "Name=tag:kubernetes.io/created-for/pvc/namespace,Values=$NAMESPACE" --query "Volumes[*].VolumeId" --output text)
if [[ -n "$VOLUME_IDS" ]]; then
  for v in $VOLUME_IDS; do
    echo "  Deleting volume: $v..."
    aws ec2 delete-volume --volume-id "$v" || true
  done
fi

log "========================================================"
log "✅ Lakehouse Cleanup Complete!"
log "========================================================"

