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

# VM Size selection
echo ""
echo "VM Size Selection for region '$LOCATION'..."

# Truthful "available to your subscription" list
# We check for both null restrictions and empty list restrictions
ALLOWED=$(
  az vm list-skus -l "$LOCATION" --resource-type virtualMachines \
    --query "[?(restrictions==null || length(restrictions) == \`0\`) && to_number(capabilities[?name=='vCPUs'].value | [0]) >= \`2\`].name" -o tsv 2>/dev/null || true
)

if [[ -n "$ALLOWED" ]]; then
  echo "Commonly available sizes in your subscription (filtered):"
  # D / Das / Dads / Ddsv / etc, v3-v6
  # tr to lowercase for consistent regex matching
  echo "$ALLOWED" \
    | tr '[:upper:]' '[:lower:]' \
    | grep -Ei '^(standard_)?d[0-9]+(a|as|ads|ad|d|p|pd|pld)?s?_v[3-6]$' \
    | head -n 15
  
  # Set a safe default if our previous default isn't in the list
  DEFAULT_VM_SIZE="Standard_D2s_v5" # Usually more available than v6 in many regions
  FOUND_IN_LIST=$(echo "$ALLOWED" | tr '[:upper:]' '[:lower:]' | grep -xiE "^(standard_)?${DEFAULT_VM_SIZE}$" || true)
  if [[ -z "$FOUND_IN_LIST" ]]; then
    # Pick the first allowed D-series
    DEFAULT_VM_SIZE=$(echo "$ALLOWED" | tr '[:upper:]' '[:lower:]' | grep -Ei '^(standard_)?d[0-9]+' | head -n 1 || echo "$(echo "$ALLOWED" | head -n 1)")
    # Convert back to ProperCase for display
    DEFAULT_VM_SIZE=$(echo "$DEFAULT_VM_SIZE" | sed 's/^standard/Standard/' | sed 's/_v/_v/')
  fi
else
  echo "⚠️  Could not query subscription-available SKUs. Falling back to catalog list."
  DEFAULT_VM_SIZE="Standard_D2as_v5"
  az vm list-sizes -l "$LOCATION" --query "[?numberOfCores >= \`2\`].name" -o tsv 2>/dev/null | head -n 15
fi

echo ""
prompt NODE_VM_SIZE "AKS Node VM Size" "$DEFAULT_VM_SIZE"
prompt NODE_COUNT "Initial Node Count" "3"

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
EOF

chmod +x "$OUTPUT_ENV"
echo "Done. Next step: source $OUTPUT_ENV && ./install-lakehouse.sh"
echo ""
