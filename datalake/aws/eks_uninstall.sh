#!/bin/bash

# ==============================================================================
# EKS Cluster Cleanup Script
# Usage: ./eks_uninstall.sh <profile> <awsRegion> <clusterName> <namespace> <bucketName>
# ==============================================================================

# 1. Validate Arguments
if [ "$#" -ne 5 ]; then
    echo "Usage: $0 <profile> <awsRegion> <namespace> <clusterName> <bucketName>"
    exit 1
fi

PROFILE=$1
REGION=$2
NAMESPACE=$3
CLUSTER_NAME=$4
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

    # Detach all managed policies first
    local POLICIES=$(aws iam list-attached-role-policies --role-name "$ROLE_NAME" --query 'AttachedPolicies[*].PolicyArn' --output text --profile "$PROFILE")
    
    for POLICY_ARN in $POLICIES; do
        log "  Detaching policy: $POLICY_ARN"
        aws iam detach-role-policy --role-name "$ROLE_NAME" --policy-arn "$POLICY_ARN" --profile "$PROFILE"
    done

    # Remove from instance profiles if exists
    local INSTANCE_PROFILES=$(aws iam list-instance-profiles-for-role --role-name "$ROLE_NAME" --query 'InstanceProfiles[*].InstanceProfileName' --output text --profile "$PROFILE")
    for IP in $INSTANCE_PROFILES; do
        log "  Removing role from Instance Profile: $IP"
        aws iam remove-role-from-instance-profile --instance-profile-name "$IP" --role-name "$ROLE_NAME" --profile "$PROFILE"
    done

    # Delete the role
    aws iam delete-role --role-name "$ROLE_NAME" --profile "$PROFILE"
    if [ $? -eq 0 ]; then
        log "  Successfully deleted role: $ROLE_NAME"
    else
        err "  Failed to delete role: $ROLE_NAME"
    fi
}

delete_iam_policy() {
    local POLICY_NAME=$1
    local POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"

    log "Processing Policy: $POLICY_NAME"
    
    # Check if policy exists
    aws iam get-policy --policy-arn "$POLICY_ARN" --profile "$PROFILE" >/dev/null 2>&1
    if [ $? -ne 0 ]; then
        warn "  Policy does not exist or already deleted. Skipping."
        return
    fi

    # 1. Prune Policy Versions (Required to delete the policy)
    log "  Checking for old policy versions..."
    # List all versions that are NOT the default version
    local VERSION_IDS=$(aws iam list-policy-versions --policy-arn "$POLICY_ARN" --profile "$PROFILE" --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text)
    
    if [ -n "$VERSION_IDS" ] && [ "$VERSION_IDS" != "None" ]; then
        for VID in $VERSION_IDS; do
            log "  Deleting policy version: $VID"
            aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "$VID" --profile "$PROFILE"
        done
    fi

    # 2. Delete the Policy
    log "  Deleting Policy Entity..."
    aws iam delete-policy --policy-arn "$POLICY_ARN" --profile "$PROFILE"
    if [ $? -eq 0 ]; then
        log "  Successfully deleted policy: $POLICY_NAME"
    else
        err "  Failed to delete policy: $POLICY_NAME (Check for attached entities)"
    fi
}

# ==============================================================================
# Main Execution
# ==============================================================================

# 1. Delete EKS Cluster
log "Starting EKS Cluster deletion: $CLUSTER_NAME (Region: $REGION)"
# Note: eksctl delete usually handles basic cleanup, but may leave roles behind if created manually
eksctl delete cluster --name "$CLUSTER_NAME" --region "$REGION" --profile "$PROFILE"

# 2. Delete S3 Bucket
log "Deleting S3 Bucket: $BUCKET_NAME"
aws s3 rb "s3://$BUCKET_NAME" --region "$REGION" --profile "$PROFILE" --force

# 3. Delete IAM Roles
log "--- Starting IAM Role Cleanup ---"

# (Removed eksctl-*-ServiceRole-* deletion as requested)

delete_iam_role "ingext_${NAMESPACE}-sa"
delete_iam_role "KarpenterControllerRole-${CLUSTER_NAME}"
delete_iam_role "KarpenterNodeRole-${CLUSTER_NAME}"


# 4. Delete IAM Policies
log "--- Starting IAM Policy Cleanup ---"

delete_iam_policy "AWSLoadBalancerControllerIAMPolicy_${CLUSTER_NAME}"
delete_iam_policy "ingext_${NAMESPACE}-sa_S3_Policy"
delete_iam_policy "KarpenterControllerPolicy-${CLUSTER_NAME}"


# 5. Cleanup Local Kubeconfig
log "--- Cleaning up Local Kubeconfig ---"

# Construct the exact ARN-based context name
# Format: arn:aws:eks:<region>:<account-id>:cluster/<cluster-name>
EXACT_CONTEXT="arn:aws:eks:${REGION}:${ACCOUNT_ID}:cluster/${CLUSTER_NAME}"

log "Attempting to remove context: $EXACT_CONTEXT"

# Check if this specific context exists in kubectl config
if kubectl config get-contexts "$EXACT_CONTEXT" >/dev/null 2>&1; then
    kubectl config delete-context "$EXACT_CONTEXT"
    log "  Successfully deleted context."
else
    warn "  Context '$EXACT_CONTEXT' not found in local config. Skipping."
fi


log "Cleanup Complete!"
