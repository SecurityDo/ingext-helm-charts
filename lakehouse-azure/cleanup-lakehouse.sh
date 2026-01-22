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

# -------- 2. Get DNS information before cleanup --------
log "Gathering DNS information for cleanup reminder..."
ING_IP=""
ING_DOMAIN=""
# Try to get ingress IP and domain before uninstalling
if az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" >/dev/null 2>&1; then
  az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --overwrite-existing 2>/dev/null || true
  ING_IP=$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  ING_DOMAIN=$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].spec.rules[0].host}' 2>/dev/null || true)
fi

if [[ -z "$ING_DOMAIN" ]]; then
  ING_DOMAIN="$SITE_DOMAIN"
fi

log "Starting Lakehouse cleanup for resource group '$RESOURCE_GROUP'..."

echo "================ Cleanup Plan ================"
echo "Resource Group:      $RESOURCE_GROUP"
echo "AKS Cluster:         $CLUSTER_NAME"
echo "Namespace:           $NAMESPACE"
echo "DNS Domain:          $ING_DOMAIN"
echo "=============================================="
echo ""
echo "WARNING: This will delete ALL resources in the resource group."
echo ""

read -rp "Proceed with deletion? (y/N): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# -------- 3. Uninstall Helm (Optional but good practice) --------
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

if [[ -n "$ING_DOMAIN" ]] || [[ -n "$ING_IP" ]]; then
  echo ""
  echo "IMPORTANT: Remove DNS Record"
  echo "---------------------------"
  if [[ -n "$ING_DOMAIN" ]] && [[ -n "$ING_IP" ]]; then
    echo "Delete the A-record: $ING_DOMAIN -> $ING_IP"
  elif [[ -n "$ING_DOMAIN" ]]; then
    echo "Remove the DNS record for domain: $ING_DOMAIN"
  fi
  echo ""
fi
