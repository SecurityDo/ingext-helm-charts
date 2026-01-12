#!/usr/bin/env bash

set -euo pipefail

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
echo "================ Preflight Azure Lakehouse (Interactive) ================"
echo ""

# 1) Azure Auth Check
if ! az account show >/dev/null 2>&1; then
  echo "You are not logged into Azure yet."
  echo "Opening Azure login now."
  az login >/dev/null
fi

# Show available subscriptions
echo "Available Azure Subscriptions:"
SUBSCRIPTIONS=$(az account list --output table 2>/dev/null || echo "")
if [[ -z "$SUBSCRIPTIONS" ]]; then
    echo "ERROR: Could not list subscriptions. Please check your Azure access."
    exit 1
fi
echo "$SUBSCRIPTIONS"
echo ""

CURRENT_SUB_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
CURRENT_SUB_NAME="$(az account show --query name -o tsv 2>/dev/null || true)"

echo "Currently active subscription: $CURRENT_SUB_NAME ($CURRENT_SUB_ID)"
read -rp "Use this subscription? (Y/n): " USE_CURRENT
if [[ "${USE_CURRENT,,}" == "n" ]]; then
  read -rp "Enter subscription name or ID to switch to: " TARGET_SUB
  if [[ -n "$TARGET_SUB" ]]; then
    az account set --subscription "$TARGET_SUB" || { echo "ERROR: Failed to set subscription."; exit 1; }
  fi
fi

SUB_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
TENANT_ID="$(az account show --query tenantId -o tsv 2>/dev/null || true)"

# 2) Prompt for remaining inputs
prompt() {
  local var_name="$1"
  local label="$2"
  local default="${3:-}"
  local val=""
  if [[ -n "$default" ]]; then
    read -rp "$label [$default]: " val
    val="${val:-$default}"
  else
    read -rp "$label: " val
  fi
  printf -v "$var_name" "%s" "$val"
}

prompt LOCATION "Azure Region" "eastus"
prompt RESOURCE_GROUP "Resource Group Name" "ingext-lakehouse-rg"
prompt CLUSTER_NAME "AKS Cluster Name" "ingext-lakehouse"

# Storage Account naming: 3-24 characters, lowercase letters and numbers only.
DEFAULT_STORAGE_ACCOUNT="ingextlake$(echo "$SUB_ID" | tr -d '-' | head -c 8)"
prompt STORAGE_ACCOUNT "Storage Account Name (for Datalake)" "$DEFAULT_STORAGE_ACCOUNT"
prompt STORAGE_CONTAINER "Blob Container Name" "datalake"

prompt SITE_DOMAIN "Public Domain (e.g. ingext.example.com)" ""
prompt CERT_EMAIL "Email for TLS certificate (Let's Encrypt)" ""
prompt NAMESPACE "Kubernetes Namespace" "ingext"

# Node preferences
echo ""
echo "Instance Recommendations:"
echo "  - Standard_D4as_v5 (AMD EPYC, 4 vCPU, 16GB) - Recommended"
echo "  - Standard_D2as_v5 (AMD EPYC, 2 vCPU, 8GB)  - Cost-effective"
prompt NODE_VM_SIZE "AKS Node VM Size" "Standard_D4as_v5"
prompt NODE_COUNT "Initial Node Count" "3"

# 3) Technical Checks
echo ""
echo "---------------- Best-effort checks ----------------"

echo "[Check] Resource Group Availability"
if az group show --name "$RESOURCE_GROUP" 2>/dev/null; then
  echo "  Resource Group '$RESOURCE_GROUP' already exists."
else
  echo "  Resource Group '$RESOURCE_GROUP' will be created."
fi

echo ""
echo "[Check] Storage Account Name Availability"
CHECK_STORAGE=$(az storage account check-name -n "$STORAGE_ACCOUNT" --query "nameAvailable" -o tsv 2>/dev/null || echo "true")
if [[ "$CHECK_STORAGE" == "false" ]]; then
    if az storage account show -n "$STORAGE_ACCOUNT" -g "$RESOURCE_GROUP" 2>/dev/null; then
        echo "  Storage Account '$STORAGE_ACCOUNT' already exists in your RG."
    else
        echo "  WARNING: Storage Account Name '$STORAGE_ACCOUNT' is already taken globally."
    fi
else
    echo "  Storage Account Name '$STORAGE_ACCOUNT' is available."
fi

echo ""
echo "[Check] DNS resolution status"
if command -v dig >/dev/null 2>&1; then
  A_REC="$(dig +short A "$SITE_DOMAIN" | head -n 1 || true)"
  if [[ -n "$A_REC" ]]; then
    echo "  Current A record for $SITE_DOMAIN: $A_REC"
  else
    echo "  No A record found for $SITE_DOMAIN (expected for new setup)."
  fi
fi

# 4) Write env file
echo ""
if [[ -f "$OUTPUT_ENV" ]]; then
  echo "WARNING: $OUTPUT_ENV already exists."
  read -rp "Overwrite? (y/N): " CONFIRM_OVERWRITE
  if [[ ! "${CONFIRM_OVERWRITE,,}" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 2
  fi
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

echo ""
echo "Done. Environment file written to: $OUTPUT_ENV"
echo "Next step: source $OUTPUT_ENV && ./install-lakehouse.sh"
echo ""
