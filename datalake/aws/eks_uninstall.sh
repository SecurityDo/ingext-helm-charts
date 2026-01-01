#!/bin/bash

# ==============================================================================
# EKS Cluster Cleanup Script (v5)
# Usage: ./eks_uninstall.sh <profile> <awsRegion> <clusterName> <namespace> <bucketName>
# ==============================================================================

# 1. Validate Arguments
if [ "$#" -ne 5 ]; then
    echo "Usage: $0 <profile> <awsRegion> <clusterName> <namespace> <bucketName>"
    exit 1
fi

PROFILE=$1
REGION=$2
CLUSTER_NAME=$3
NAMESPACE=$4
BUCKET_NAME=$5

# Colors for formatting
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

err() {
    echo -e "${RED}[ERROR]${NC} $1"
}

ask_confirm() {
    read -p "$1 [y/N]: " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        return 1 # False/No
    fi
    return 0 # True/Yes
}

# Get AWS Account ID
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text --profile "$PROFILE")
if [ -z "$ACCOUNT_ID" ]; then
    err "Could not fetch Account ID. Check your profile credentials."
    exit 1
fi

# ==============================================================================
# Helper Functions
# ==============================================================================

delete_iam_role() {
    local ROLE_NAME=$1
    # Check if role exists
    aws iam get-role --role-name "$ROLE_NAME" --profile "$PROFILE" >/dev/null 2>&1
    if [ $? -ne 0 ]; then
        warn "Role $ROLE_NAME does not exist or already deleted. Skipping."
        return
    fi
    log "Cleaning up Role: $ROLE_NAME"
    
    # Detach policies
    local POLICIES=$(aws iam list-attached-role-policies --role-name "$ROLE_NAME" --query 'AttachedPolicies[*].PolicyArn' --output text --profile "$PROFILE")
    for POLICY_ARN in $POLICIES; do
        log "  Detaching policy: $POLICY_ARN"
        aws iam detach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN" --profile "$PROFILE"
    done

    # Remove instance profiles
    local INSTANCE_PROFILES=$(aws iam list-instance-profiles-for-role --role-name "$ROLE_NAME" --query 'InstanceProfiles[*].InstanceProfileName' --output text --profile "$PROFILE")
    for IP in $INSTANCE_PROFILES; do
        log "  Removing role from Instance Profile: $IP"
        aws iam remove-role-from-instance-profile --instance-profile-name "$IP" --role-name "$ROLE_NAME" --profile "$PROFILE"
    done

    aws iam delete-role --role-name "$ROLE_NAME" --profile "$PROFILE"
}

delete_iam_policy() {
    local POLICY_NAME=$1
    local POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"

    log "Processing Policy: $POLICY_NAME"
    aws iam get-policy --policy-arn "$POLICY_ARN" --profile "$PROFILE" >/dev/null 2>&1
    if [ $? -ne 0 ]; then
        warn "  Policy does not exist or already deleted. Skipping."
        return
    fi

    # Prune Policy Versions
    local VERSION_IDS=$(aws iam list-policy-versions --policy-arn "$POLICY_ARN" --profile "$PROFILE" --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text)
    if [ -n "$VERSION_IDS" ] && [ "$VERSION_IDS" != "None" ]; then
        for VID in $VERSION_IDS; do
            aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$VID" --profile "$PROFILE" >/dev/null
        done
    fi

    aws iam delete-policy --policy-arn "$POLICY_ARN" --profile "$PROFILE"
}

# ==============================================================================
# Main Execution
# ==============================================================================

# 1. Delete EKS Cluster
log "Starting EKS Cluster deletion: $CLUSTER_NAME (Region: $REGION)"
eksctl delete cluster --name "$CLUSTER_NAME" --region "$REGION" --profile "$PROFILE"

# 2. Delete S3 Bucket
log "Deleting S3 Bucket: $BUCKET_NAME"
aws s3 rb "s3://$BUCKET_NAME" --region "$REGION" --profile "$PROFILE" --force

# 3. Delete IAM Roles
log "--- Starting IAM Role Cleanup ---"
delete_iam_role "ingext_${NAMESPACE}-sa"
delete_iam_role "KarpenterControllerRole-${CLUSTER_NAME}"
delete_iam_role "KarpenterNodeRole-${CLUSTER_NAME}"

# 4. Delete IAM Policies
log "--- Starting IAM Policy Cleanup ---"
delete_iam_policy "AWSLoadBalancerControllerIAMPolicy_${CLUSTER_NAME}"
delete_iam_policy "ingext_${NAMESPACE}-sa_S3_Policy"
delete_iam_policy "KarpenterControllerPolicy-${CLUSTER_NAME}"

# 5. Cleanup Karpenter Nodes
log "--- Starting Karpenter Node Cleanup ---"
log "Searching for EC2 instances in pools 'pool-merge' or 'pool-search' for cluster '$CLUSTER_NAME'..."

# We search for instances that belong to the cluster AND match the provisioner/nodepool tags
# Using both 'karpenter.sh/nodepool' (new) and 'karpenter.sh/provisioner-name' (legacy)
INSTANCE_IDS=$(aws ec2 describe-instances \
    --region "$REGION" \
    --profile "$PROFILE" \
    --filters "Name=tag:aws:eks:cluster-name,Values=$CLUSTER_NAME" \
              "Name=instance-state-name,Values=running,stopped" \
    --query "Reservations[*].Instances[?Tags[?Key=='karpenter.sh/nodepool' && (Value=='pool-merge' || Value=='pool-search')] || Tags[?Key=='karpenter.sh/provisioner-name' && (Value=='pool-merge' || Value=='pool-search')]].InstanceId" \
    --output text)

if [ -n "$INSTANCE_IDS" ]; then
    echo -e "${YELLOW}Found the following Karpenter instances to terminate:${NC}"
    for ID in $INSTANCE_IDS; do echo "  - $ID"; done
    
    if ask_confirm "Are you sure you want to TERMINATE these instances?"; then
        log "Terminating instances..."
        aws ec2 terminate-instances --instance-ids $INSTANCE_IDS --region "$REGION" --profile "$PROFILE" >/dev/null
        log "Termination signal sent."
    else
        warn "Skipping instance termination."
    fi
else
    log "No lingering Karpenter instances found for pools 'pool-merge/pool-search'."
fi

# 6. Cleanup EBS Volumes
log "--- Starting EBS Volume Cleanup ---"
log "Searching for EBS volumes tagged for namespace: $NAMESPACE..."

VOLUME_IDS=$(aws ec2 describe-volumes \
    --region "$REGION" \
    --profile "$PROFILE" \
    --filters "Name=tag:kubernetes.io/created-for/pvc/namespace,Values=$NAMESPACE" \
    --query "Volumes[*].{ID:VolumeId, State:State, Size:Size}" \
    --output text)

if [ -n "$VOLUME_IDS" ]; then
    echo -e "${YELLOW}Found the following EBS Volumes:${NC}"
    echo "$VOLUME_IDS"
    
    # Extract just the IDs for the delete command
    CLEAN_VOL_IDS=$(echo "$VOLUME_IDS" | awk '{print $1}')
    
    if ask_confirm "Are you sure you want to DELETE these volumes? (Data will be lost)"; then
        for VOL_ID in $CLEAN_VOL_IDS; do
            log "Deleting volume: $VOL_ID"
            aws ec2 delete-volume --volume-id "$VOL_ID" --region "$REGION" --profile "$PROFILE" >/dev/null 2>&1
            if [ $? -ne 0 ]; then
                err "Failed to delete $VOL_ID (It might still be in use or deleting)."
            fi
        done
    else
        warn "Skipping volume deletion."
    fi
else
    log "No EBS volumes found for namespace '$NAMESPACE'."
fi

# 7. Cleanup Local Kubeconfig
log "--- Cleaning up Local Kubeconfig ---"
EXACT_CONTEXT="arn:aws:eks:${REGION}:${ACCOUNT_ID}:cluster/${CLUSTER_NAME}"
log "Attempting to remove context: $EXACT_CONTEXT"

if kubectl config get-contexts "$EXACT_CONTEXT" >/dev/null 2>&1; then
    kubectl config delete-context "$EXACT_CONTEXT"
    log "  Successfully deleted context."
else
    warn "  Context '$EXACT_CONTEXT' not found in local config. Skipping."
fi

log "Cleanup Complete!"
