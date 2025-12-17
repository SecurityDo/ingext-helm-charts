#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Ingext AKS Cleanup Script
#
# Removes Ingext installation from AKS, including Helm releases, AKS cluster,
# and optionally the resource group.
#
# Usage:
#   ./cleanup-ingext-aks.sh \
#     --resource-group ingext-rg \
#     --cluster-name ingext-aks
#
# Requirements:
#   - az (Azure CLI)
#   - kubectl
#   - helm
###############################################################################

print_help() {
  cat <<EOF
Ingext AKS Cleanup Script

Usage:
  ./cleanup-ingext-aks.sh [options]

Required options:
  --resource-group <name>          Azure resource group name
  --cluster-name <name>            AKS cluster name

Optional options:
  --namespace <name>               Kubernetes namespace (default: ingext)
  --keep-resource-group            Keep resource group after cleanup
  --env-file <path>                Path to environment file (default: ./ingext-aks.env)
  --help                           Show this help message and exit

Environment variables (optional, flags override):
  RESOURCE_GROUP
  CLUSTER_NAME
  NAMESPACE

The script will automatically load values from ./ingext-aks.env if it exists.
You can also source the file manually: source ./ingext-aks.env

Example:
  ./cleanup-ingext-aks.sh \\
    --resource-group ingext-rg \\
    --cluster-name ingext-aks
EOF
}

# -------- Load from .env file if it exists (before parsing args) --------
ENV_FILE="${ENV_FILE:-./ingext-aks.env}"
if [[ -f "$ENV_FILE" ]]; then
  echo "Loading settings from $ENV_FILE"
  # Source the env file, but don't fail if it doesn't exist
  set +u  # Temporarily allow unset variables
  source "$ENV_FILE" 2>/dev/null || true
  set -u  # Re-enable strict mode
  echo "Loaded: RESOURCE_GROUP=${RESOURCE_GROUP:-not set}, CLUSTER_NAME=${CLUSTER_NAME:-not set}, NAMESPACE=${NAMESPACE:-not set}"
  echo ""
fi

# -------- Defaults --------
NAMESPACE="${NAMESPACE:-ingext}"
KEEP_RESOURCE_GROUP=0

# -------- Parse arguments --------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --resource-group)
      RESOURCE_GROUP="$2"
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
    --keep-resource-group)
      KEEP_RESOURCE_GROUP=1
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
: "${RESOURCE_GROUP:?--resource-group is required}"
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
for bin in az kubectl helm; do
  need "$bin"
done

# -------- Check Azure login --------
if ! az account show >/dev/null 2>&1; then
  echo "ERROR: Not logged in to Azure. Run 'az login' first."
  exit 1
fi

# -------- Check if cluster exists --------
if ! az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" >/dev/null 2>&1; then
  echo "WARNING: AKS cluster '$CLUSTER_NAME' not found in resource group '$RESOURCE_GROUP'"
  echo "Skipping cluster deletion."
  SKIP_CLUSTER_DELETE=1
else
  SKIP_CLUSTER_DELETE=0
fi

# -------- Cleanup summary --------
cat <<EOF

================ Cleanup Plan ================
Resource Group:      $RESOURCE_GROUP
AKS Cluster:         $CLUSTER_NAME
Namespace:           $NAMESPACE
Keep Resource Group: $KEEP_RESOURCE_GROUP
==============================================

This will delete:
  - All Helm releases in namespace '$NAMESPACE'
  - cert-manager namespace and releases
  - AKS cluster '$CLUSTER_NAME'
EOF

if [[ "$KEEP_RESOURCE_GROUP" == "0" ]]; then
  echo "  - Resource group '$RESOURCE_GROUP'"
else
  echo "  - Resource group '$RESOURCE_GROUP' will be KEPT"
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
  az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --overwrite-existing || {
    echo "WARNING: Failed to get kubectl credentials. Some cleanup steps may be skipped."
  }
fi

# -------- Uninstall Helm releases --------
if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  log "Uninstalling Helm releases in namespace '$NAMESPACE'"
  
  # List of releases to uninstall (in reverse order of installation)
  RELEASES=(
    "ingext-community-ingress-azure"
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

# -------- Delete AKS cluster --------
if [[ "$SKIP_CLUSTER_DELETE" == "0" ]]; then
  log "Delete AKS cluster: $CLUSTER_NAME"
  az aks delete \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER_NAME" \
    --yes \
    --no-wait || {
    echo "WARNING: Failed to delete AKS cluster. It may still be deleting in the background."
  }
else
  log "Skipping AKS cluster deletion (cluster not found)"
fi

# -------- Delete resource group --------
if [[ "$KEEP_RESOURCE_GROUP" == "0" ]]; then
  log "Delete resource group: $RESOURCE_GROUP"
  read -rp "Delete resource group '$RESOURCE_GROUP'? This will delete ALL resources in the group. (y/N): " CONFIRM_RG
  if [[ "$CONFIRM_RG" =~ ^[Yy]$ ]]; then
    az group delete --name "$RESOURCE_GROUP" --yes --no-wait || {
      echo "WARNING: Failed to delete resource group. It may still be deleting in the background."
    }
    echo "Resource group deletion initiated (may take several minutes)"
  else
    echo "Resource group deletion cancelled."
  fi
else
  log "Keeping resource group '$RESOURCE_GROUP' (--keep-resource-group flag set)"
fi

echo ""
echo "=========================================="
echo "Cleanup Complete!"
echo "=========================================="
echo ""
echo "Note: AKS cluster and resource group deletions may take several minutes"
echo "to complete. You can check status with:"
echo "  az aks show --resource-group $RESOURCE_GROUP --name $CLUSTER_NAME"
echo "  az group show --name $RESOURCE_GROUP"
echo ""

