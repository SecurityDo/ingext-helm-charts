#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Ingext GKE Cleanup Script
#
# Removes Ingext installation from GKE, including Helm releases, GKE cluster,
# and optionally the project.
#
# Usage:
#   ./cleanup-ingext-gke.sh \
#     --project my-gcp-project \
#     --region us-east1 \
#     --cluster-name ingext-gke
#
# Requirements:
#   - gcloud (Google Cloud CLI)
#   - kubectl
#   - helm
###############################################################################

print_help() {
  cat <<EOF
Ingext GKE Cleanup Script

Usage:
  ./cleanup-ingext-gke.sh [options]

Required options:
  --project <project-id>          GCP project ID
  --region <region>               GCP region
  --cluster-name <name>           GKE cluster name

Optional options:
  --namespace <name>              Kubernetes namespace (default: ingext)
  --keep-project                  Keep project after cleanup
  --env-file <path>               Path to environment file (default: ./ingext-gke.env)
  --help                          Show this help message and exit

Environment variables (optional, flags override):
  PROJECT_ID
  REGION
  CLUSTER_NAME
  NAMESPACE

The script will automatically load values from ./ingext-gke.env if it exists.
You can also source the file manually: source ./ingext-gke.env

Example:
  ./cleanup-ingext-gke.sh \\
    --project my-gcp-project \\
    --region us-east1 \\
    --cluster-name ingext-gke
EOF
}

# -------- Load from .env file if it exists (before parsing args) --------
ENV_FILE="${ENV_FILE:-./ingext-gke.env}"
if [[ -f "$ENV_FILE" ]]; then
  echo "Loading settings from $ENV_FILE"
  # Source the env file, but don't fail if it doesn't exist
  set +u  # Temporarily allow unset variables
  source "$ENV_FILE" 2>/dev/null || true
  set -u  # Re-enable strict mode
  echo "Loaded: PROJECT_ID=${PROJECT_ID:-not set}, REGION=${REGION:-not set}, CLUSTER_NAME=${CLUSTER_NAME:-not set}, NAMESPACE=${NAMESPACE:-not set}"
  echo ""
fi

# -------- Defaults --------
NAMESPACE="${NAMESPACE:-ingext}"
KEEP_PROJECT=0

# -------- Parse arguments --------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
      shift 2
      ;;
    --cluster-name)
      CLUSTER_NAME="$2"
      shift 2
      ;;
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --keep-project)
      KEEP_PROJECT=1
      shift
      ;;
    --env-file)
      ENV_FILE="$2"
      if [[ -f "$ENV_FILE" ]]; then
        set +u
        source "$ENV_FILE" 2>/dev/null || true
        set -u
        echo "Reloaded settings from $ENV_FILE"
      fi
      shift 2
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1"
      echo "Run with --help for usage."
      exit 1
      ;;
  esac
done

# -------- Required arguments validation --------
: "${PROJECT_ID:?--project is required}"
: "${REGION:?--region is required}"
: "${CLUSTER_NAME:?--cluster-name is required}"

# -------- Helper functions --------
need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing dependency: $1"
    exit 1
  }
}

log() {
  echo ""
  echo "==> $*"
}

# -------- Dependency checks --------
for bin in gcloud kubectl helm; do
  need "$bin"
done

# -------- Check GCP login --------
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" >/dev/null 2>&1; then
  echo "ERROR: Not logged in to GCP. Run 'gcloud auth login' first."
  exit 1
fi

# -------- Check if cluster exists --------
if ! gcloud container clusters describe "$CLUSTER_NAME" --region="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "WARNING: GKE cluster '$CLUSTER_NAME' not found in region '$REGION' of project '$PROJECT_ID'"
  echo "Skipping cluster deletion."
  SKIP_CLUSTER_DELETE=1
else
  SKIP_CLUSTER_DELETE=0
fi

# -------- Cleanup summary --------
cat <<EOF

================ Cleanup Plan ================
Project:            $PROJECT_ID
Region:             $REGION
GKE Cluster:        $CLUSTER_NAME
Namespace:          $NAMESPACE
Keep Project:       $KEEP_PROJECT
==============================================

This will delete:
  - All Helm releases in namespace '$NAMESPACE'
  - cert-manager namespace and releases
  - GKE cluster '$CLUSTER_NAME'
EOF

if [[ "$KEEP_PROJECT" == "0" ]]; then
  echo "  - Project '$PROJECT_ID' (WARNING: This will delete ALL resources in the project)"
else
  echo "  - Project '$PROJECT_ID' will be KEPT"
fi

echo ""

read -rp "Proceed with cleanup? (y/N): " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || {
  echo "Cleanup cancelled."
  exit 2
}

# -------- Get kubectl credentials if cluster exists --------
if [[ "$SKIP_CLUSTER_DELETE" == "0" ]]; then
  log "Get kubectl credentials"
  gcloud container clusters get-credentials "$CLUSTER_NAME" --region="$REGION" --project="$PROJECT_ID" --overwrite-existing || {
    echo "WARNING: Failed to get kubectl credentials. Some cleanup steps may be skipped."
  }
fi

# -------- Get DNS information before cleanup --------
ING_IP=""
ING_DOMAIN=""
if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  # Try to get ingress IP and domain before uninstalling
  ING_IP=$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  ING_DOMAIN=$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].spec.rules[0].host}' 2>/dev/null || true)
  
  # If domain not found in ingress, try from env file
  if [[ -z "$ING_DOMAIN" ]] && [[ -n "${SITE_DOMAIN:-}" ]]; then
    ING_DOMAIN="$SITE_DOMAIN"
  fi
fi

# -------- Uninstall Helm releases --------
if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  log "Uninstalling Helm releases in namespace '$NAMESPACE'"
  
  # List of releases to uninstall (in reverse order of installation)
  RELEASES=(
    "ingext-community-ingress-gcp"
    "ingext-community-certissuer"
    "ingext-community"
    "ingext-community-init"
    "ingext-community-config"
    "etcd-single-cronjob"
    "etcd-single"
    "ingext-stack"
  )
  
  for release in "${RELEASES[@]}"; do
    if helm list -n "$NAMESPACE" -q | grep -q "^${release}$"; then
      log "Uninstalling $release"
      helm uninstall "$release" -n "$NAMESPACE" || {
        echo "WARNING: Failed to uninstall $release"
      }
    else
      log "Release $release not found, skipping"
    fi
  done
  
  log "Remaining releases in namespace '$NAMESPACE':"
  helm list -n "$NAMESPACE" || true
else
  log "Namespace '$NAMESPACE' not found, skipping Helm uninstall"
fi

# -------- Uninstall cert-manager --------
if kubectl get namespace cert-manager >/dev/null 2>&1; then
  log "Uninstalling cert-manager"
  if helm list -n cert-manager -q | grep -q "^cert-manager$"; then
    helm uninstall cert-manager -n cert-manager || {
      echo "WARNING: Failed to uninstall cert-manager"
    }
  fi
else
  log "cert-manager namespace not found, skipping"
fi

# -------- Delete GKE cluster --------
if [[ "$SKIP_CLUSTER_DELETE" == "0" ]]; then
  log "Delete GKE cluster: $CLUSTER_NAME"
  gcloud container clusters delete "$CLUSTER_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --quiet \
    --async || {
    echo "WARNING: Failed to delete GKE cluster. It may still be deleting in the background."
  }
else
  log "Skipping GKE cluster deletion (cluster not found)"
fi

# -------- Delete project --------
if [[ "$KEEP_PROJECT" == "0" ]]; then
  log "Delete project: $PROJECT_ID"
  read -rp "Delete project '$PROJECT_ID'? This will delete ALL resources in the project. (y/N): " CONFIRM_PROJECT
  if [[ "$CONFIRM_PROJECT" =~ ^[Yy]$ ]]; then
    gcloud projects delete "$PROJECT_ID" --quiet || {
      echo "WARNING: Failed to delete project. It may still be deleting in the background."
      echo "Note: Projects with billing enabled may require additional steps."
    }
    echo "Project deletion initiated (may take several minutes)"
  else
    echo "Project deletion cancelled."
  fi
else
  log "Keeping project '$PROJECT_ID' (--keep-project flag set)"
fi

echo ""
echo "=========================================="
echo "Cleanup Complete!"
echo "=========================================="
echo ""

# -------- DNS Removal Reminder --------
if [[ -n "$ING_DOMAIN" ]] || [[ -n "$ING_IP" ]]; then
  echo "=========================================="
  echo "IMPORTANT: Remove DNS Record"
  echo "=========================================="
  echo ""
  if [[ -n "$ING_DOMAIN" ]] && [[ -n "$ING_IP" ]]; then
    echo "Remove the DNS A-record you created:"
    echo "  Domain: $ING_DOMAIN"
    echo "  IP:     $ING_IP"
    echo ""
    echo "Delete the A-record: $ING_DOMAIN -> $ING_IP"
  elif [[ -n "$ING_DOMAIN" ]]; then
    echo "Remove the DNS A-record for domain: $ING_DOMAIN"
  elif [[ -n "$ING_IP" ]]; then
    echo "Remove the DNS A-record pointing to IP: $ING_IP"
  fi
  echo ""
fi

echo "Note: GKE cluster and project deletions may take several minutes"
echo "to complete. You can check status with:"
echo "  gcloud container clusters describe $CLUSTER_NAME --region=$REGION --project=$PROJECT_ID"
echo "  gcloud projects describe $PROJECT_ID"
echo ""


