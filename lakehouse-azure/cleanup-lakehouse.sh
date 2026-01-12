#!/usr/bin/env bash

set -uo pipefail

###############################################################################
# Azure Lakehouse Cleanup (Tear Down Stream + Datalake)
#
# Systematically deletes:
# 1. Helm releases
# 2. Resource Group (deletes AKS, Storage, App Gateway, etc.)
###############################################################################

# -------- 1. Load Environment --------
if [[ ! -f "./lakehouse-azure.env" ]]; then
  echo "ERROR: lakehouse-azure.env not found. Manual intervention required or re-run preflight."
  exit 1
fi

source ./lakehouse-azure.env

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

log "Starting Lakehouse cleanup for resource group '$RESOURCE_GROUP'..."

if ! ask_confirm "Are you sure you want to DELETE EVERYTHING in '$RESOURCE_GROUP'? (Data will be lost)"; then
  echo "Aborted."
  exit 0
fi

# -------- 2. Uninstall Helm (Optional but good practice) --------
log "Phase 1: Uninstalling Helm Releases..."
HELM_RELEASES=(
  "ingext-ingress"
  "ingext-lake"
  "ingext-blob-lake"
  "ingext-manager-role"
  "ingext-aks-pool"
  "ingext-lake-config"
  "ingext-community"
  "ingext-community-init"
  "ingext-community-config"
  "etcd-single-cronjob"
  "etcd-single"
  "ingext-stack"
  "cert-manager"
  "ingext-community-certissuer"
)

# Try to get credentials just in case they were lost
az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --overwrite-existing 2>/dev/null || true

for rel in "${HELM_RELEASES[@]}"; do
  echo "  Deleting $rel..."
  helm uninstall "$rel" -n "$NAMESPACE" 2>/dev/null || true
  helm uninstall "$rel" -n cert-manager 2>/dev/null || true
done

# -------- 3. Delete Resource Group --------
log "Phase 2: Deleting Resource Group '$RESOURCE_GROUP' (this takes ~10-15 min)..."
az group delete --name "$RESOURCE_GROUP" --yes --no-wait

echo "Cleanup initiated in background. You can check progress with:"
echo "  az group show --name $RESOURCE_GROUP"

log "========================================================"
log "✅ Lakehouse Cleanup Initiated!"
log "========================================================"
