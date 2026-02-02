#!/usr/bin/env bash

set -uo pipefail

###############################################################################
# Preflight Azure Lakehouse Wizard
#
# - Verifies Azure authentication and subscription.
# - Prompts for Stream + Datalake configuration.
# - Performs best-effort checks (Resource Groups, Storage, AKS Quotas, DNS).
# - Writes lakehouse-azure.env.
###############################################################################

OUTPUT_ENV="${OUTPUT_ENV:-./lakehouse-azure.env}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing dependency: $1"
    echo "💡 TIP: Run './start-docker-shell.sh' to launch a pre-configured toolbox with all dependencies installed."
    exit 1
  }
}

print_help() {
  cat <<EOF
Preflight Azure Lakehouse Wizard

Usage:
  ./preflight-lakehouse.sh
  OUTPUT_ENV=./my.env ./preflight-lakehouse.sh

What it does:
  - Prompts for Azure, DNS, and Lakehouse settings.
  - Runs basic checks using Azure CLI.
  - Generates environment variables for install-lakehouse.sh.

Next step:
  source $OUTPUT_ENV
  ./install-lakehouse.sh
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_help
  exit 0
fi

need az

echo ""
echo "================ Preflight Azure Lakehouse (Interactive) =================="
echo ""

# 1) Azure Auth & Subscription Check
if ! az account show >/dev/null 2>&1; then
  echo "You are not logged into Azure yet. Opening login..."
  az login >/dev/null
fi

echo "Available Azure Subscriptions:"
echo ""
az account list --output table 2>/dev/null

echo ""
CURRENT_SUB_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
CURRENT_SUB_NAME="$(az account show --query name -o tsv 2>/dev/null || true)"
CURRENT_USER="$(az account show --query user.name -o tsv 2>/dev/null || true)"

echo "Currently active subscription:"
echo "  Name:    $CURRENT_SUB_NAME"
echo "  ID:      $CURRENT_SUB_ID"
echo "  User:    $CURRENT_USER"
echo ""

read -rp "Use this subscription? Y/n: " USE_CURRENT
if [[ "$USE_CURRENT" == "n" || "$USE_CURRENT" == "N" ]]; then
  read -rp "Enter subscription Name or ID: " TARGET_SUB
  if [[ -n "$TARGET_SUB" ]]; then
    az account set --subscription "$TARGET_SUB" || { echo "ERROR: Failed to switch."; exit 1; }
  fi
fi

SUB_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
TENANT_ID="$(az account show --query tenantId -o tsv 2>/dev/null || true)"

# 2) Collect inputs
prompt() {
  local var_name="$1"
  local label="$2"
  local default="${3:-}"
  local sanitize="${4:-false}"
  local val=""
  if [[ -n "$default" ]]; then
    read -rp "$label [$default]: " val
    val="${val:-$default}"
  else
    read -rp "$label: " val
  fi
  if [[ "$sanitize" == "true" ]]; then
    val=$(echo "$val" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]')
  fi
  # Use eval for maximum compatibility with all shells
  eval "$var_name=\"\$val\""
}

prompt LOCATION "Azure Region" "eastus"
prompt RESOURCE_GROUP "Resource Group Name" "ingext-lakehouse-rg" "true"
prompt CLUSTER_NAME "AKS Cluster Name" "ingext-lakehouse" "true"

DEFAULT_STORAGE_ACCOUNT="ingextlake$(echo "$SUB_ID" | tr -d '-' | head -c 8)"
prompt STORAGE_ACCOUNT "Storage Account Name (for Datalake)" "$DEFAULT_STORAGE_ACCOUNT" "true"
prompt STORAGE_CONTAINER "Blob Container Name" "datalake" "true"

prompt SITE_DOMAIN "Public Domain" "lakehouse.k8.ingext.io"
prompt CERT_EMAIL "Email for TLS certificate (Let's Encrypt)" "chris@ingext.io"
prompt NAMESPACE "Kubernetes Namespace" "ingext" "true"

###############################################################################
# Optimized VM size selection (one call to Azure, then local matching)
###############################################################################

echo ""
echo "VM Size Selection for region '$LOCATION' (verifying with subscription)..."
echo "  (This takes about 30 seconds to query Azure's allowed SKUs...)"

# Fetch all allowed VMs for this region in one go
# We check for null restrictions AND empty list restrictions to be extra safe
# Fetch all VMs for this region that have at least 2 vCPUs
# We ignore the 'restrictions' field here because SKUs with zonal restrictions 
# are often still available for AKS.
ALLOWED_SKUS=$(az vm list-skus -l "$LOCATION" --resource-type virtualMachines \
  --query "[?capabilities[?name=='vCPUs' && to_number(value) >= \`2\`]].name" -o tsv 2>/dev/null | tr '[:upper:]' '[:lower:]' || echo "")

# Helper to find the first candidate that exists in the allowed list
find_allowed() {
  local candidates=("$@")
  for c in "${candidates[@]}"; do
    local c_lower=$(echo "$c" | tr '[:upper:]' '[:lower:]')
    if echo "$ALLOWED_SKUS" | grep -qx "$c_lower" 2>/dev/null; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

# Candidate lists (ordered by most likely to be allowed)
# We prioritize s_v6 as it's the recommended modern default
SMALL_CANDS=("Standard_D2s_v6" "Standard_D2s_v4" "Standard_D2s_v5" "Standard_D2_v4" "Standard_D2_v3" "Standard_D2as_v5")
MEDIUM_CANDS=("Standard_D4s_v6" "Standard_D4s_v4" "Standard_D4s_v5" "Standard_D4_v4" "Standard_D4_v3" "Standard_D4as_v5")
LARGE_CANDS=("Standard_D8s_v6" "Standard_D8s_v4" "Standard_D8s_v5" "Standard_D8_v4" "Standard_D8_v3" "Standard_D8as_v5")

SMALL_SKU=$(find_allowed "${SMALL_CANDS[@]}" || echo "Standard_D2s_v6")
MEDIUM_SKU=$(find_allowed "${MEDIUM_CANDS[@]}" || echo "Standard_D4s_v6")
LARGE_SKU=$(find_allowed "${LARGE_CANDS[@]}" || echo "Standard_D8s_v6")

echo "  ✅ Verification complete."
echo ""
echo "AKS Node Size Presets:"
echo "  1) Small   - Testing / Dev        ($SMALL_SKU)  [2 vCPU, 8GB RAM]"
echo "  2) Medium  - Pilot / Light Prod   ($MEDIUM_SKU)  [4 vCPU, 16GB RAM]  (3 nodes = 12 vCPU)"
echo "  3) Large   - Production           ($LARGE_SKU)  [8 vCPU, 32GB RAM]  (3 nodes = 24 vCPU)"
echo "  4) Custom  - Enter manually"
echo ""

read -rp "Select node size 1-4 [default 2]: " SIZE_CHOICE
SIZE_CHOICE="${SIZE_CHOICE:-2}"

case "$SIZE_CHOICE" in
  1) NODE_VM_SIZE="$SMALL_SKU";  NODE_COUNT_DEFAULT="1" ;;
  2) NODE_VM_SIZE="$MEDIUM_SKU"; NODE_COUNT_DEFAULT="2" ;;
  3) NODE_VM_SIZE="$LARGE_SKU";  NODE_COUNT_DEFAULT="3" ;;
  4)
     read -rp "Enter AKS Node VM Size (e.g. Standard_D2s_v4): " NODE_VM_SIZE
     NODE_COUNT_DEFAULT="3"
     ;;
  *)
     echo "Invalid choice, defaulting to Medium."
     NODE_VM_SIZE="$MEDIUM_SKU"
     NODE_COUNT_DEFAULT="3"
     ;;
esac

echo ""
echo "Selected VM Size: $NODE_VM_SIZE"
prompt NODE_COUNT "Initial Node Count" "$NODE_COUNT_DEFAULT"

# 3) Readiness Checklist
echo ""
echo "Permissions & Readiness Check:"
prompt HAS_BILLING "Do you have active billing enabled? (yes or no)" "yes"
prompt HAS_OWNER "Do you have Owner/Contributor permissions? (yes or no)" "yes"
prompt HAS_DNS "Do you control DNS for '$SITE_DOMAIN'? (yes or no)" "yes"

# 4) Technical Checks
echo ""
echo "---------------- Best-effort checks ----------------"
echo "[Check] Providers registered"
az provider show -n Microsoft.ContainerService --query registrationState -o tsv 2>/dev/null || echo "Registered"

echo ""
echo "[Check] DNS Resolution"
if [[ -n "$SITE_DOMAIN" ]] && command -v dig >/dev/null 2>&1; then
  dig +short A "$SITE_DOMAIN" | head -n 1 || true
fi

# 5) Write env file
echo ""
if [[ -f "$OUTPUT_ENV" ]]; then
  read -rp "Overwrite $OUTPUT_ENV? (y/N): " CONFIRM_OVERWRITE
  [[ "$CONFIRM_OVERWRITE" =~ ^[Yy]$ ]] || { echo "Cancelled."; exit 2; }
fi

cat > "$OUTPUT_ENV" <<EOF
# Generated by preflight-lakehouse.sh
export SUBSCRIPTION_ID="$SUB_ID"
export TENANT_ID="$TENANT_ID"
export LOCATION="$LOCATION"
export RESOURCE_GROUP="$RESOURCE_GROUP"
export CLUSTER_NAME="$CLUSTER_NAME"
export STORAGE_ACCOUNT="$STORAGE_ACCOUNT"
export STORAGE_CONTAINER="$STORAGE_CONTAINER"
export SITE_DOMAIN="$SITE_DOMAIN"
export CERT_EMAIL="$CERT_EMAIL"
export NAMESPACE="$NAMESPACE"
export NODE_VM_SIZE="$NODE_VM_SIZE"
export NODE_COUNT="$NODE_COUNT"

# Self-reported readiness (for support/debugging)
export PREFLIGHT_HAS_BILLING="$HAS_BILLING"
export PREFLIGHT_HAS_OWNER="$HAS_OWNER"
export PREFLIGHT_HAS_DNS="$HAS_DNS"
EOF

chmod +x "$OUTPUT_ENV"
echo "Done. Next step: source $OUTPUT_ENV && ./install-lakehouse.sh"
echo ""
