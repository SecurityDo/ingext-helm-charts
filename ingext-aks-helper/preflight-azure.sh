#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Preflight Azure Wizard for Ingext AKS installs
#
# - Asks questions interactively
# - Performs best-effort checks (az auth, provider registration, quotas snapshot, DNS resolution status)
# - Writes an env file you can source before running install-ingext-aks.sh
#
# Usage:
#   ./preflight-azure.sh
#   OUTPUT_ENV=./my.env ./preflight-azure.sh
###############################################################################

OUTPUT_ENV="${OUTPUT_ENV:-./ingext-aks.env}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing dependency: $1"
    exit 1
  }
}

print_help() {
  cat <<EOF
Preflight Azure Wizard (Ingext AKS)

Usage:
  ./preflight-azure.sh
  OUTPUT_ENV=./my.env ./preflight-azure.sh

What it does:
  - Prompts you for Azure + DNS + install settings
  - Runs basic checks using Azure CLI (best effort)
  - Writes environment variables to an env file (default: ./ingext-aks.env)

Next step:
  source ./ingext-aks.env
  ./install-ingext-aks.sh --location "\$LOCATION" --resource-group "\$RESOURCE_GROUP" --cluster-name "\$CLUSTER_NAME" --domain "\$SITE_DOMAIN" --email "\$CERT_EMAIL"

EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_help
  exit 0
fi

need az

echo ""
echo "================ Preflight Azure (Interactive) ================"
echo ""

# 1) Azure login status and subscription selection
if ! az account show >/dev/null 2>&1; then
  echo "You are not logged into Azure yet."
  echo "Opening Azure login now."
  az login >/dev/null
fi

# Check if current subscription is valid
CURRENT_SUB_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
if [[ -n "$CURRENT_SUB_ID" ]]; then
  # Try to verify subscription exists
  if ! az account show --subscription "$CURRENT_SUB_ID" >/dev/null 2>&1; then
    echo "WARNING: Current subscription '$CURRENT_SUB_ID' is not accessible."
    echo "This may be a stale subscription. Please select a valid one."
    echo ""
    # Clear the invalid subscription context
    az account clear 2>/dev/null || true
    echo "Logging in again to refresh subscription list..."
    az login >/dev/null
  fi
fi

# Show available subscriptions
echo "Available Azure Subscriptions:"
echo ""
SUBSCRIPTIONS=$(az account list --output table 2>/dev/null || echo "")
if [[ -z "$SUBSCRIPTIONS" ]] || echo "$SUBSCRIPTIONS" | grep -q "WARNING\|ERROR"; then
  echo "WARNING: Could not list subscriptions. You may need to login again."
  echo "Attempting to refresh login..."
  az login >/dev/null
  SUBSCRIPTIONS=$(az account list --output table 2>/dev/null || echo "")
fi

# Check if there are any real subscriptions (not just tenant-level accounts)
if echo "$SUBSCRIPTIONS" | grep -q "N/A(tenant level account)"; then
  echo "$SUBSCRIPTIONS"
  echo ""
  echo "⚠️  WARNING: You are logged in but have NO SUBSCRIPTIONS available."
  echo "   The account shows 'N/A(tenant level account)' which means:"
  echo "   - You have tenant access but no subscription access"
  echo "   - You cannot create AKS clusters without a subscription"
  echo ""
  echo "To fix this, you need to:"
  echo "  1. Create a new Azure subscription:"
  echo "     - Go to https://portal.azure.com"
  echo "     - Navigate to Subscriptions → Create subscription"
  echo "     - Or use: az account create --name \"YourSubscriptionName\""
  echo ""
  echo "  2. OR get access to an existing subscription:"
  echo "     - Contact your Azure administrator"
  echo "     - Request 'Owner' or 'Contributor' role on a subscription"
  echo ""
  echo "  3. OR login with a different account that has subscriptions:"
  echo "     - az login (and choose a different account)"
  echo ""
  read -rp "Continue anyway? (y/N): " CONTINUE_NO_SUB
  if [[ ! "$CONTINUE_NO_SUB" =~ ^[Yy]$ ]]; then
    echo "Exiting. Please set up a subscription first."
    exit 2
  fi
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
CURRENT_TENANT="$(az account show --query tenantId -o tsv 2>/dev/null || true)"

if [[ -z "$CURRENT_SUB_ID" ]]; then
  echo "No subscription is currently set. Please select one:"
  echo ""
  read -rp "Enter subscription name or ID: " TARGET_SUB
  if [[ -n "$TARGET_SUB" ]]; then
    az account set --subscription "$TARGET_SUB" || {
      echo "ERROR: Failed to set subscription. Please check the name/ID."
      exit 1
    }
    CURRENT_SUB_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
    CURRENT_SUB_NAME="$(az account show --query name -o tsv 2>/dev/null || true)"
  fi
fi

echo "Currently active subscription:"
echo "  Name:         $CURRENT_SUB_NAME"
echo "  Subscription ID: $CURRENT_SUB_ID"
echo "  User:         $CURRENT_USER"
if [[ -n "$CURRENT_TENANT" ]]; then
  echo "  Tenant:       $CURRENT_TENANT"
fi
echo ""

# Ask if user wants to switch subscriptions
read -rp "Use this subscription? (Y/n): " USE_CURRENT
if [[ "$USE_CURRENT" == "n" || "$USE_CURRENT" == "N" ]]; then
  echo ""
  echo "Options:"
  echo "  1) Select a different subscription from the list above"
  echo "  2) Login with a different Azure account"
  read -rp "Choose option (1/2): " SWITCH_OPTION
  
  if [[ "$SWITCH_OPTION" == "1" ]]; then
    echo ""
    echo "Enter the subscription name or ID to switch to:"
    read -rp "Subscription: " TARGET_SUB
    if [[ -n "$TARGET_SUB" ]]; then
      az account set --subscription "$TARGET_SUB" || {
        echo "ERROR: Failed to switch subscription. Please check the name/ID and try again."
        exit 1
      }
      echo "Switched to subscription: $TARGET_SUB"
    fi
  elif [[ "$SWITCH_OPTION" == "2" ]]; then
    echo ""
    echo "Logging in with a different Azure account..."
    az login --allow-no-subscriptions || {
      echo "ERROR: Login failed"
      exit 1
    }
    echo ""
    echo "Available subscriptions for new account:"
    az account list --output table
    echo ""
    read -rp "Enter subscription name or ID to use: " TARGET_SUB
    if [[ -n "$TARGET_SUB" ]]; then
      az account set --subscription "$TARGET_SUB" || {
        echo "ERROR: Failed to set subscription"
        exit 1
      }
      echo "Switched to subscription: $TARGET_SUB"
    fi
  fi
fi

# Get final subscription details
SUB_ID="$(az account show --query id -o tsv 2>/dev/null || true)"
SUB_NAME="$(az account show --query name -o tsv 2>/dev/null || true)"
USER_NAME="$(az account show --query user.name -o tsv 2>/dev/null || true)"
TENANT_NAME="$(az account show --query tenantDefaultDomain -o tsv 2>/dev/null || true)"

echo ""
echo "Using Azure subscription:"
echo "  Subscription: $SUB_NAME"
echo "  Sub ID:       $SUB_ID"
echo "  User:         $USER_NAME"
if [[ -n "$TENANT_NAME" ]]; then
  echo "  Tenant:       $TENANT_NAME"
fi
echo ""

# Helper for prompts with defaults
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

# 2) Collect inputs
prompt LOCATION "Azure region (example: eastus, eastus2, westus2, centralus)" "eastus"
prompt RESOURCE_GROUP "Resource Group name" "ingext-rg"
prompt CLUSTER_NAME "AKS cluster name" "ingext-aks"
prompt NODE_COUNT "Node count" "2"

# VM Size selection - show available sizes automatically
echo ""
echo "VM Size Selection:"
echo "Checking available VM sizes for region '$LOCATION'..."
echo ""

# Get and display filtered VM sizes
TABLE_OUTPUT=$(az vm list-sizes --location "$LOCATION" --output table 2>/dev/null || echo "")

# Default to a size that's commonly available for AKS and recommended for Ingext (AMD EPYC)
DEFAULT_VM_SIZE="Standard_D4as_v5"

if [[ -n "$TABLE_OUTPUT" ]]; then
  # Filter to common AKS-compatible sizes
  FILTERED=$(echo "$TABLE_OUTPUT" | \
    grep -E "Standard_[DB][0-9]" | \
    grep -E "s_v[2345]|ds_v[2345]|ms_v[2345]|_v[2345]|as_v[2345]|a_v[2345]" | \
    grep -v -E "_nc|_nv|_hb|_hc|_hx|_fx|_l[0-9]" | \
    head -n 15 || true)
  
  if [[ -n "$FILTERED" ]]; then
    echo "⚠️  WARNING: These are GENERAL VM sizes, not AKS-specific!"
    echo "   AKS has additional restrictions. The installer will show actual AKS-available sizes if this fails."
    echo ""
    echo "Recommended VM sizes (general purpose AMD EPYC, showing first 15):"
    echo "$FILTERED" | head -n 17
    echo ""
    
    # Prefer dasv5 series if it exists in the list
    DASV5_PREFERRED=$(echo "$FILTERED" | grep -E "Standard_D[0-9]+as_v5" | head -n 1 | awk '{print $3}' || echo "")
    
    if [[ -n "$DASV5_PREFERRED" ]] && [[ "$DASV5_PREFERRED" =~ ^Standard_ ]]; then
      DEFAULT_VM_SIZE="$DASV5_PREFERRED"
      echo "Default recommendation (AMD EPYC dasv5): $DEFAULT_VM_SIZE"
    else
      echo "Default recommendation: $DEFAULT_VM_SIZE"
    fi
    
    echo ""
    echo "💡 Tip: Common AKS-compatible sizes to try if the default fails:"
    echo "   - Standard_D4as_v5 (4 vCPU, 16GB) - Recommended AMD EPYC"
    echo "   - Standard_D2as_v5 (2 vCPU, 8GB)  - Smaller AMD EPYC"
    echo "   - standard_dc2ds_v3 (2 vCPU, 8GB) - Intel alternative"
    echo ""
  else
    echo "Could not filter sizes. Showing first 10 available:"
    echo "$TABLE_OUTPUT" | head -n 12
    echo ""
  fi
else
  echo "Could not retrieve VM sizes. Using default."
fi

read -rp "Node VM size [$DEFAULT_VM_SIZE]: " NODE_VM_SIZE_INPUT
NODE_VM_SIZE="${NODE_VM_SIZE_INPUT:-$DEFAULT_VM_SIZE}"

prompt NAMESPACE "Kubernetes namespace" "ingext"
prompt SITE_DOMAIN "Public domain for Ingext (example: ingext.example.com)" ""
prompt CERT_EMAIL "Email for certificate issuer" ""

echo ""
echo "You will need DNS control for: $SITE_DOMAIN"
echo "You will create an A record to the Application Gateway public IP after ingress is created."
echo ""

# 3) Ask permission readiness questions (human-verifiable)
echo "Permissions and readiness questions (answer honestly, this avoids failed installs):"
prompt HAS_BILLING "Do you have an active Azure subscription with billing enabled? (yes/no)" "yes"
prompt HAS_OWNER "Do you have Owner or equivalent permissions to create AKS and Application Gateway? (yes/no)" "yes"
prompt HAS_QUOTA "Do you expect enough quota in region '$LOCATION' for at least ${NODE_COUNT} nodes + App Gateway? (yes/no/unsure)" "unsure"
prompt HAS_DNS "Do you control DNS for '$SITE_DOMAIN' (can create A records)? (yes/no)" "yes"

# 4) Best-effort technical checks
echo ""
echo "---------------- Best-effort checks ----------------"

echo ""
echo "[Check] Providers registered (AKS + Network)"
# First verify we have a valid subscription
if ! az account show >/dev/null 2>&1; then
  echo "  ERROR: No valid subscription is set. Cannot check provider registration."
  echo "  Please set a valid subscription first:"
  echo "    1. List available subscriptions: az account list --output table"
  echo "    2. Set subscription: az account set --subscription \"<name-or-id>\""
  echo "    3. If no subscriptions are available, you need to:"
  echo "       - Create a new Azure subscription, OR"
  echo "       - Have an administrator grant you access to an existing subscription"
  RP_AKS="ERROR_NO_SUBSCRIPTION"
  RP_NET="ERROR_NO_SUBSCRIPTION"
else
  RP_AKS="$(az provider show -n Microsoft.ContainerService --query registrationState -o tsv 2>/dev/null || echo "ERROR")"
  RP_NET="$(az provider show -n Microsoft.Network --query registrationState -o tsv 2>/dev/null || echo "ERROR")"
  
  # Check if the error is due to subscription not found
  if [[ "$RP_AKS" == "ERROR" ]]; then
    ERROR_MSG="$(az provider show -n Microsoft.ContainerService 2>&1 || true)"
    if echo "$ERROR_MSG" | grep -q "SubscriptionNotFound"; then
      RP_AKS="ERROR_SUBSCRIPTION_NOT_FOUND"
      RP_NET="ERROR_SUBSCRIPTION_NOT_FOUND"
    fi
  fi
fi

echo "  Microsoft.ContainerService: ${RP_AKS:-unknown}"
echo "  Microsoft.Network:          ${RP_NET:-unknown}"

if [[ "$RP_AKS" == "ERROR_NO_SUBSCRIPTION" ]]; then
  echo "  ACTION REQUIRED: Set a valid subscription before proceeding."
elif [[ "$RP_AKS" == "ERROR_SUBSCRIPTION_NOT_FOUND" ]]; then
  echo "  ERROR: The current subscription is not accessible or doesn't exist."
  echo "  Please:"
  echo "    1. Clear stale subscription: az account clear"
  echo "    2. Login again: az login"
  echo "    3. List subscriptions: az account list --output table"
  echo "    4. Set a valid subscription: az account set --subscription \"<name-or-id>\""
  echo "    5. If no subscriptions appear, you may need to:"
  echo "       - Create a new Azure subscription in the Azure Portal, OR"
  echo "       - Contact an administrator to grant you access to a subscription"
elif [[ "$RP_AKS" != "Registered" || "$RP_NET" != "Registered" ]]; then
  echo "  NOTE: If these are not Registered, AKS/App Gateway creation can fail."
  echo "  To register providers (requires valid subscription):"
  echo "    az provider register -n Microsoft.ContainerService"
  echo "    az provider register -n Microsoft.Network"
  echo ""
  echo "  Check registration status anytime with:"
  echo "    ./check-providers.sh"
  echo ""
  echo "  Or watch status continuously (if 'watch' is installed):"
  echo "    watch -n 5 ./check-providers.sh"
fi

echo ""
echo "[Check] Region usage snapshot (compute)"
# This is informative, not authoritative. Some tenants cannot query usage.
az vm list-usage --location "$LOCATION" -o table 2>/dev/null | head -n 25 || {
  echo "  WARNING: Unable to query compute usage. You may lack permission."
}

echo ""
echo "[Check] DNS resolution status (not ownership proof)"
if command -v dig >/dev/null 2>&1; then
  A_REC="$(dig +short A "$SITE_DOMAIN" | head -n 1 || true)"
  if [[ -n "$A_REC" ]]; then
    echo "  Current A record: $A_REC"
  else
    echo "  No A record found currently (OK if new subdomain)."
  fi
elif command -v nslookup >/dev/null 2>&1; then
  if nslookup "$SITE_DOMAIN" >/dev/null 2>&1; then
    echo "  Domain resolves (nslookup succeeded)."
  else
    echo "  Domain does not currently resolve (OK if new subdomain)."
  fi
else
  echo "  dig/nslookup not found, skipping resolution check."
fi

# 5) Summarize risk flags
echo ""
echo "---------------- Preflight summary ----------------"
WARN=0

if [[ "${HAS_BILLING,,}" != "yes" ]]; then
  echo "WARNING: Billing not confirmed. Install will likely fail."
  WARN=1
fi

if [[ "${HAS_OWNER,,}" != "yes" ]]; then
  echo "WARNING: Owner-level permissions not confirmed. Install will likely fail."
  WARN=1
fi

if [[ "${HAS_DNS,,}" != "yes" ]]; then
  echo "WARNING: DNS control not confirmed. HTTPS and login will not work."
  WARN=1
fi

if [[ "${HAS_QUOTA,,}" == "no" ]]; then
  echo "WARNING: Quota likely insufficient in $LOCATION."
  WARN=1
fi

if [[ "$WARN" -eq 0 ]]; then
  echo "No major red flags reported."
else
  echo "One or more red flags detected. You can still generate the env file, but expect install problems."
fi

# 6) Write env file
echo ""
if [[ -f "$OUTPUT_ENV" ]]; then
  echo "WARNING: $OUTPUT_ENV already exists and will be overwritten."
  read -rp "Continue? (y/N): " CONFIRM_OVERWRITE
  if [[ ! "$CONFIRM_OVERWRITE" =~ ^[Yy]$ ]]; then
    echo "Cancelled. Environment file not updated."
    exit 2
  fi
fi

echo "Writing environment file: $OUTPUT_ENV"

cat > "$OUTPUT_ENV" <<EOF
# Generated by preflight-azure.sh
# Usage:
#   source $OUTPUT_ENV
#   ./install-ingext-aks.sh --location "\$LOCATION" --resource-group "\$RESOURCE_GROUP" --cluster-name "\$CLUSTER_NAME" --domain "\$SITE_DOMAIN" --email "\$CERT_EMAIL"

export LOCATION="$(printf '%s' "$LOCATION")"
export RESOURCE_GROUP="$(printf '%s' "$RESOURCE_GROUP")"
export CLUSTER_NAME="$(printf '%s' "$CLUSTER_NAME")"
export NODE_COUNT="$(printf '%s' "$NODE_COUNT")"
export NODE_VM_SIZE="$(printf '%s' "$NODE_VM_SIZE")"
export NAMESPACE="$(printf '%s' "$NAMESPACE")"
export SITE_DOMAIN="$(printf '%s' "$SITE_DOMAIN")"
export CERT_EMAIL="$(printf '%s' "$CERT_EMAIL")"

# Self-reported readiness (for support/debugging)
export PREFLIGHT_HAS_BILLING="$(printf '%s' "$HAS_BILLING")"
export PREFLIGHT_HAS_OWNER="$(printf '%s' "$HAS_OWNER")"
export PREFLIGHT_HAS_QUOTA="$(printf '%s' "$HAS_QUOTA")"
export PREFLIGHT_HAS_DNS="$(printf '%s' "$HAS_DNS")"
EOF

echo ""
echo "Done."
echo ""
echo "Next steps:"
echo "  1) source $OUTPUT_ENV"
echo "  2) Run installer:"
echo "     ./install-ingext-aks.sh"
echo ""
echo "     (The installer will use the environment variables from $OUTPUT_ENV)"
echo ""
echo "     Alternatively, you can pass arguments directly:"
echo "     ./install-ingext-aks.sh \\"
echo "       --location \"\$LOCATION\" \\"
echo "       --resource-group \"\$RESOURCE_GROUP\" \\"
echo "       --cluster-name \"\$CLUSTER_NAME\" \\"
echo "       --domain \"\$SITE_DOMAIN\" \\"
echo "       --email \"\$CERT_EMAIL\""
echo ""

