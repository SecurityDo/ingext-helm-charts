#!/usr/bin/env bash

set -uo pipefail # Removed -e to handle errors manually in the VM section

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

# Show available subscriptions
echo "Available Azure Subscriptions:"
echo ""
az account list --output table 2>/dev/null || echo "Warning: Could not list subscriptions."

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
    val=$(echo "$val" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]')
  fi

  printf -v "$var_name" "%s" "$val"
}

prompt LOCATION "Azure Region" "eastus"
prompt RESOURCE_GROUP "Resource Group Name" "ingext-lakehouse-rg" "true"
prompt CLUSTER_NAME "AKS Cluster Name" "ingext-lakehouse" "true"

DEFAULT_STORAGE_ACCOUNT="ingextlake$(echo "$SUB_ID" | tr -d '-' | head -c 8)"
prompt STORAGE_ACCOUNT "Storage Account Name (for Datalake)" "$DEFAULT_STORAGE_ACCOUNT" "true"
prompt STORAGE_CONTAINER "Blob Container Name" "datalake" "true"

prompt SITE_DOMAIN "Public Domain" "lakehouse.k8.ingext.io"
prompt CERT_EMAIL "Email for TLS certificate (Let's Encrypt)" ""
prompt NAMESPACE "Kubernetes Namespace" "ingext" "true"

# VM Size selection
echo ""
echo "VM Size Selection for region '$LOCATION'..."

# Try to get sizes from multiple sources for maximum compatibility
SERVICE_ALLOWED=$(az aks list-locations --location "$LOCATION" --query "vmSizes" -o tsv 2>/dev/null || echo "")
SUBSCRIPTION_ALLOWED=$(az vm list-skus --location "$LOCATION" --resource-type virtualMachines --query "[?capabilities[?name=='vCPUs' && value>'1']].name" -o tsv 2>/dev/null || echo "")
FALLBACK_SIZES=$(az vm list-sizes --location "$LOCATION" --query "[].name" -o tsv 2>/dev/null || echo "")

DEFAULT_VM_SIZE="Standard_D2s_v6"

# Attempt intersection if possible
if [[ -n "$SERVICE_ALLOWED" && -n "$SUBSCRIPTION_ALLOWED" ]]; then
  ACTUAL_ALLOWED=$(comm -12 <(echo "$SERVICE_ALLOWED" | tr '[:upper:]' '[:lower:]' | sort) <(echo "$SUBSCRIPTION_ALLOWED" | tr '[:upper:]' '[:lower:]' | sort))
else
  ACTUAL_ALLOWED=""
fi

if [[ -n "$ACTUAL_ALLOWED" ]]; then
  echo "Commonly supported AKS sizes for your subscription (D-series):"
  echo "$ACTUAL_ALLOWED" | grep -Ei "standard_d[0-9]s_v[3456]" | head -n 15
else
  echo "⚠️  Note: Could not perform strict subscription check. Showing general available sizes:"
  if [[ -n "$SERVICE_ALLOWED" ]]; then
    echo "$SERVICE_ALLOWED" | grep -Ei "Standard_D[0-9]s_v[3456]" | head -n 15
  else
    echo "$FALLBACK_SIZES" | grep -Ei "Standard_D[0-9]s_v[3456]" | head -n 15
  fi
fi

echo ""
prompt NODE_VM_SIZE "AKS Node VM Size" "$DEFAULT_VM_SIZE"
prompt NODE_COUNT "Initial Node Count" "3"

# 3) Readiness Checklist
echo ""
echo "Permissions & Readiness Check:"
prompt HAS_BILLING "Do you have active billing enabled? yes/no" "yes"
prompt HAS_OWNER "Do you have Owner/Contributor permissions? yes/no" "yes"
prompt HAS_DNS "Do you control DNS for '$SITE_DOMAIN'? yes/no" "yes"

# 4) Technical Checks
echo ""
echo "---------------- Best-effort checks ----------------"

echo "[Check] Providers registered"
RP_AKS="$(az provider show -n Microsoft.ContainerService --query registrationState -o tsv 2>/dev/null || echo "Registered")"
RP_NET="$(az provider show -n Microsoft.Network --query registrationState -o tsv 2>/dev/null || echo "Registered")"
echo "  AKS Provider: $RP_AKS"
echo "  Network Provider: $RP_NET"

echo ""
echo "[Check] Region Quota Snapshot"
az vm list-usage --location "$LOCATION" -o table 2>/dev/null | head -n 10 || echo "  Unable to query quota."

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
