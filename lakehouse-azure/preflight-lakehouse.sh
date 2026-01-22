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
echo "================ Preflight Azure Lakehouse (Interactive) ================"
echo ""

# 1) Azure Auth & Subscription Check
if ! az account show >/dev/null 2>&1; then
  echo "You are not logged into Azure yet."
  echo "Opening Azure login now."
  az login >/dev/null
fi

# Check if current subscription is valid
CURRENT_SUB_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
if [[ -n "$CURRENT_SUB_ID" ]]; then
  if ! az account show --subscription "$CURRENT_SUB_ID" >/dev/null 2>&1; then
    echo "WARNING: Current subscription '$CURRENT_SUB_ID' is not accessible."
    echo "This may be a stale subscription. Clearing context and logging in again..."
    az account clear 2>/dev/null || true
    az login >/dev/null
  fi
fi

# Show available subscriptions
echo "Available Azure Subscriptions:"
echo ""
SUBSCRIPTIONS=$(az account list --output table 2>/dev/null || echo "")
if [[ -z "$SUBSCRIPTIONS" ]] || echo "$SUBSCRIPTIONS" | grep -q "WARNING\|ERROR"; then
  echo "WARNING: Could not list subscriptions. Attempting refresh..."
  az login >/dev/null
  SUBSCRIPTIONS=$(az account list --output table 2>/dev/null || echo "")
fi

# Check for tenant-level accounts without subscriptions
if echo "$SUBSCRIPTIONS" | grep -q "N/A(tenant level account)"; then
  echo "$SUBSCRIPTIONS"
  echo ""
  echo "⚠️  WARNING: You are logged in but have NO SUBSCRIPTIONS available."
  echo "   - You cannot create AKS clusters without a subscription."
  echo "   - Please create a subscription in the Azure Portal or get access to one."
  echo ""
  read -rp "Continue anyway? (y/N): " CONTINUE_NO_SUB
  if [[ ! "$CONTINUE_NO_SUB" =~ ^[Yy]$ ]]; then exit 2; fi
elif [[ -n "$SUBSCRIPTIONS" ]]; then
  echo "$SUBSCRIPTIONS"
else
  echo "ERROR: Could not list subscriptions. Please check your Azure access."
  exit 1
fi

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
  echo "Options: 1 Select from list above, 2 Login with different account"
  read -rp "Choice 1/2: " SWITCH_OPTION
  if [[ "$SWITCH_OPTION" == "1" ]]; then
    read -rp "Enter subscription Name or ID: " TARGET_SUB
    if [[ -n "$TARGET_SUB" ]]; then
      az account set --subscription "$TARGET_SUB" || { echo "ERROR: Failed to switch."; exit 1; }
    fi
  elif [[ "$SWITCH_OPTION" == "2" ]]; then
    az login --allow-no-subscriptions >/dev/null
    az account list --output table
    read -rp "Enter subscription Name or ID to use: " TARGET_SUB
    if [[ -n "$TARGET_SUB" ]]; then
      az account set --subscription "$TARGET_SUB" || { echo "ERROR: Failed to switch."; exit 1; }
    fi
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
    # Lowercase and digits only
    val=$(echo "$val" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]')
  fi

  # Use a simple assignment instead of printf -v for maximum compatibility
  eval "$var_name=\"\$val\""
}

prompt LOCATION "Azure Region" "eastus"
prompt RESOURCE_GROUP "Resource Group Name" "ingext-lakehouse-rg" "true"
prompt CLUSTER_NAME "AKS Cluster Name" "ingext-lakehouse" "true"

# Storage Account naming: 3-24 characters, lowercase letters and numbers only.
DEFAULT_STORAGE_ACCOUNT="ingextlake$(echo "$SUB_ID" | tr -d '-' | head -c 8)"
prompt STORAGE_ACCOUNT "Storage Account Name (for Datalake)" "$DEFAULT_STORAGE_ACCOUNT" "true"
prompt STORAGE_CONTAINER "Blob Container Name" "datalake" "true"

prompt SITE_DOMAIN "Public Domain" "lakehouse.k8.ingext.io"
prompt CERT_EMAIL "Email for TLS certificate (Let's Encrypt)" ""
prompt NAMESPACE "Kubernetes Namespace" "ingext" "true"

# VM Size selection - show available sizes specifically for AKS
echo ""
echo "VM Size Selection for region '$LOCATION'..."
# Try to get AKS-specific VM sizes first
TABLE_OUTPUT=$(az aks list-locations --location "$LOCATION" --query "vmSizes" -o table 2>/dev/null || az vm list-sizes --location "$LOCATION" --output table 2>/dev/null || echo "")
DEFAULT_VM_SIZE="Standard_D2s_v6"

if [[ -n "$TABLE_OUTPUT" ]]; then
  # Check if our default specifically exists in the allowed list
  if echo "$TABLE_OUTPUT" | grep -qi "$DEFAULT_VM_SIZE"; then
    echo "✅ Default size '$DEFAULT_VM_SIZE' is available in this region."
  else
    echo "⚠️  Note: Default '$DEFAULT_VM_SIZE' not found in immediate list. It may have a different name or be restricted."
  fi
  echo ""

  # Filter to common sizes, focusing on D-series (General Purpose)
  # We show a mix of older and newer generations
  FILTERED=$(echo "$TABLE_OUTPUT" | grep -Ei "Standard_D[0-9]+[as]*_v[456]" | head -n 20 || true)
  
  if [[ -n "$FILTERED" ]]; then
    echo "Commonly supported AKS sizes (D-series v4, v5, v6):"
    echo "$FILTERED"
    echo ""
  else
    echo "Could not find specific D-series v4-v6. Showing first 15 available sizes:"
    echo "$TABLE_OUTPUT" | head -n 15
    echo ""
  fi
fi

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
RP_AKS="$(az provider show -n Microsoft.ContainerService --query registrationState -o tsv 2>/dev/null || echo "ERROR")"
RP_NET="$(az provider show -n Microsoft.Network --query registrationState -o tsv 2>/dev/null || echo "ERROR")"
echo "  AKS Provider: $RP_AKS"
echo "  Network Provider: $RP_NET"

if [[ "$RP_AKS" != "Registered" || "$RP_NET" != "Registered" ]]; then
  echo "  ACTION: You may need to run: az provider register -n Microsoft.ContainerService"
fi

echo ""
echo "[Check] Region Quota Snapshot"
az vm list-usage --location "$LOCATION" -o table 2>/dev/null | head -n 15 || echo "  Unable to query quota."

echo ""
echo "[Check] DNS Resolution"
if [[ -n "$SITE_DOMAIN" ]] && command -v dig >/dev/null 2>&1; then
  A_REC="$(dig +short A "$SITE_DOMAIN" | head -n 1 || true)"
  if [[ -n "$A_REC" ]]; then
    echo "  Current A record for $SITE_DOMAIN: $A_REC"
  else
    echo "  No A record found (expected for new setup)."
  fi
fi

# 5) Write env file
echo ""
if [[ -f "$OUTPUT_ENV" ]]; then
  echo "WARNING: $OUTPUT_ENV already exists."
  read -rp "Overwrite? (y/N): " CONFIRM_OVERWRITE
  if [[ ! "$CONFIRM_OVERWRITE" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 2
  fi
fi

echo "Writing environment file: $OUTPUT_ENV"

cat > "$OUTPUT_ENV" <<EOF
# Generated by preflight-lakehouse.sh
# Usage:
#   source $OUTPUT_ENV
#   ./install-lakehouse.sh

export SUBSCRIPTION_ID="$(printf '%s' "$SUB_ID")"
export TENANT_ID="$(printf '%s' "$TENANT_ID")"
export LOCATION="$(printf '%s' "$LOCATION")"
export RESOURCE_GROUP="$(printf '%s' "$RESOURCE_GROUP")"
export CLUSTER_NAME="$(printf '%s' "$CLUSTER_NAME")"
export STORAGE_ACCOUNT="$(printf '%s' "$STORAGE_ACCOUNT")"
export STORAGE_CONTAINER="$(printf '%s' "$STORAGE_CONTAINER")"
export SITE_DOMAIN="$(printf '%s' "$SITE_DOMAIN")"
export CERT_EMAIL="$(printf '%s' "$CERT_EMAIL")"
export NAMESPACE="$(printf '%s' "$NAMESPACE")"
export NODE_VM_SIZE="$(printf '%s' "$NODE_VM_SIZE")"
export NODE_COUNT="$(printf '%s' "$NODE_COUNT")"

# Self-reported readiness (for support/debugging)
export PREFLIGHT_HAS_BILLING="$(printf '%s' "$HAS_BILLING")"
export PREFLIGHT_HAS_OWNER="$(printf '%s' "$HAS_OWNER")"
export PREFLIGHT_HAS_DNS="$(printf '%s' "$HAS_DNS")"
EOF

chmod +x "$OUTPUT_ENV"

echo ""
echo "Done. Environment file written to: $OUTPUT_ENV"
echo "Next step: source $OUTPUT_ENV && ./install-lakehouse.sh"
echo ""
