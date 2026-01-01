#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Preflight Azure Wizard for Ingext Datalake installs
#
# - Asks questions interactively
# - Performs best-effort checks (az auth, provider registration, quotas, storage)
# - Writes an env file you can source before running the datalake setup scripts
#
# Usage:
#   ./preflight-azure-datalake.sh
#   OUTPUT_ENV=./my.env ./preflight-azure-datalake.sh
###############################################################################

OUTPUT_ENV="${OUTPUT_ENV:-./ingext-datalake-azure.env}"

# Check if configuration file already exists
check_existing_config() {
    if [ -f "$OUTPUT_ENV" ]; then
        echo ""
        echo "⚠️  Existing configuration file found: $OUTPUT_ENV"
        echo ""
        echo "Current configuration:"
        echo "----------------------------------------"
        # Extract and display key values from the env file
        EXISTING_VARS=$(grep -E "^export (RESOURCE_GROUP|LOCATION|CLUSTER_NAME|NODE_COUNT|NODE_VM_SIZE|STORAGE_ACCOUNT_NAME|CONTAINER_NAME|EXPIRE_DAYS|NAMESPACE)=" "$OUTPUT_ENV" 2>/dev/null || true)
        if [ -n "$EXISTING_VARS" ]; then
            echo "$EXISTING_VARS" | while IFS= read -r line; do
                # Extract variable name and value, remove quotes
                VAR_NAME=$(echo "$line" | sed 's/^export //; s/=.*$//')
                VAR_VALUE=$(echo "$line" | sed 's/^export [^=]*="//; s/"$//')
                printf "  %-25s %s\n" "$VAR_NAME:" "$VAR_VALUE"
            done
        else
            echo "  (Could not read configuration values)"
        fi
        echo "----------------------------------------"
        echo ""
        read -rp "Do you want to overwrite this configuration? (y/N): " OVERWRITE
        if [[ ! "${OVERWRITE,,}" =~ ^[Yy]$ ]]; then
            echo ""
            echo "Keeping existing configuration. Exiting."
            echo ""
            echo "To use existing configuration:"
            echo "  source $OUTPUT_ENV"
            echo "  ./aks_setup.sh"
            echo ""
            exit 0
        fi
        echo ""
        echo "Proceeding to create new configuration..."
        echo ""
    fi
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing dependency: $1"
    exit 1
  }
}

print_help() {
  cat <<EOF
Preflight Azure Datalake Wizard

Usage:
  ./preflight-azure-datalake.sh
  OUTPUT_ENV=./my.env ./preflight-azure-datalake.sh

What it does:
  - Prompts you for Azure + storage + install settings
  - Runs basic checks using Azure CLI (best effort)
  - Writes environment variables to an env file (default: ./ingext-datalake-azure.env)

Next step:
  source ./ingext-datalake-azure.env
  ./aks_setup.sh "\$RESOURCE_GROUP" "\$LOCATION" "\$CLUSTER_NAME" "\$NODE_COUNT"
  ./create_blob_storage.sh "\$RESOURCE_GROUP" "\$LOCATION" "\$STORAGE_ACCOUNT_NAME" "\$CONTAINER_NAME" "\$EXPIRE_DAYS"
  ./setup_ingext_serviceaccount.sh "\$RESOURCE_GROUP" "\$CLUSTER_NAME" "\$NAMESPACE" "\$STORAGE_ACCOUNT_NAME"

EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_help
  exit 0
fi

need az

# Color codes (defined early for use throughout script)
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color
CHECK_MARK="✓"
CROSS_MARK="✗"
WARNING_MARK="⚠"

echo ""
echo "================ Preflight Azure Datalake (Interactive) ================"
echo ""

# Check for existing configuration
check_existing_config

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
  echo "   - You cannot create AKS clusters or storage accounts without a subscription"
  echo ""
  echo "To fix this, you need to:"
  echo "  1. Create a new Azure subscription:"
  echo "     - Go to https://portal.azure.com"
  echo "     - Navigate to Subscriptions → Create subscription"
  echo ""
  echo "  2. OR get access to an existing subscription:"
  echo "     - Contact your Azure administrator"
  echo "     - Request 'Owner' or 'Contributor' role on a subscription"
  echo ""
  echo "  3. OR login with a different account that has subscriptions:"
  echo "     - az login (and choose a different account)"
  echo ""
  read -rp "Continue anyway? (y/N): " CONTINUE_NO_SUB
  if [[ ! "${CONTINUE_NO_SUB,,}" =~ ^[Yy]$ ]]; then
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
if [[ "${USE_CURRENT,,}" == "n" ]]; then
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
echo "=== Azure Configuration ==="
prompt LOCATION "Azure region (example: eastus, eastus2, westus2, centralus)" "eastus"
prompt RESOURCE_GROUP "Resource Group name" "ingext-datalake-rg"

echo ""
echo "=== AKS Cluster Configuration ==="
prompt CLUSTER_NAME "AKS cluster name" "ingext-lake"
prompt NODE_COUNT "Node count" "1"

# VM Size selection - show available sizes automatically
echo ""
echo "VM Size Selection:"
echo "Checking available VM sizes for region '$LOCATION'..."
echo ""

# Get and display filtered VM sizes
TABLE_OUTPUT=$(az vm list-sizes --location "$LOCATION" --output table 2>/dev/null || echo "")

# Default to a size that's commonly available for AKS
DEFAULT_VM_SIZE="standard_dc2s_v3"  # 2 vCPU, 8 GB RAM - commonly allowed for AKS

if [[ -n "$TABLE_OUTPUT" ]]; then
  # Filter to common AKS-compatible sizes
  FILTERED=$(echo "$TABLE_OUTPUT" | \
    grep -E "Standard_[DB]" | \
    grep -E "s_v[234]|ds_v[234]|ms_v[234]|_v[234]|as_v[234]|a_v[234]" | \
    grep -v -E "_nc|_nv|_hb|_hc|_hx|_fx|_l[0-9]" | \
    head -n 15 || true)
  
  # Prefer AKS-commonly-available sizes (dc series) if they exist in the list
  # Convert to lowercase for consistency
  AKS_PREFERRED=$(echo "$FILTERED" | grep -iE "Standard_DC" | head -n 1 | awk '{print $3}' | tr '[:upper:]' '[:lower:]' || echo "")
  
  # Only override default if we found a DC series (which is most compatible with AKS)
  if [[ -n "$AKS_PREFERRED" ]] && [[ "$AKS_PREFERRED" =~ ^standard_dc ]]; then
    DEFAULT_VM_SIZE="$AKS_PREFERRED"
  fi
  
  printf "Recommended VM size: ${GREEN}$DEFAULT_VM_SIZE${NC} (2 vCPU, 8GB RAM)\n"
  echo ""
  echo "  Other AKS-compatible options if needed:"
  echo "    - standard_dc2ds_v3 (2 vCPU, 8GB)"
  echo "    - standard_dc4s_v3 (4 vCPU, 16GB)"
  echo ""
else
  echo "Could not retrieve VM sizes. Using default."
fi

read -rp "Node VM size [$DEFAULT_VM_SIZE]: " NODE_VM_SIZE_INPUT
NODE_VM_SIZE="${NODE_VM_SIZE_INPUT:-$DEFAULT_VM_SIZE}"

echo ""
echo "=== Storage Configuration ==="
echo "Storage account names must be:"
echo "  - 3-24 characters long"
echo "  - Lowercase letters and numbers only"
echo "  - Globally unique across all Azure"
echo ""
prompt STORAGE_ACCOUNT_NAME "Storage account name" "ingextdatalake"

# Validate storage account name format
STORAGE_ACCOUNT_NAME_CLEAN=$(echo "$STORAGE_ACCOUNT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]//g')
if [[ "$STORAGE_ACCOUNT_NAME" != "$STORAGE_ACCOUNT_NAME_CLEAN" ]]; then
  echo "⚠️  WARNING: Storage account name will be sanitized to: $STORAGE_ACCOUNT_NAME_CLEAN"
  STORAGE_ACCOUNT_NAME="$STORAGE_ACCOUNT_NAME_CLEAN"
fi

if [[ ${#STORAGE_ACCOUNT_NAME} -lt 3 ]] || [[ ${#STORAGE_ACCOUNT_NAME} -gt 24 ]]; then
  echo "⚠️  WARNING: Storage account name must be 3-24 characters. Current length: ${#STORAGE_ACCOUNT_NAME}"
  echo "   The script will handle this, but you may want to adjust the name."
fi

prompt CONTAINER_NAME "Blob container name" "datalake"
prompt EXPIRE_DAYS "Object expiration (days)" "30"

echo ""
echo "=== Kubernetes Configuration ==="
prompt NAMESPACE "Kubernetes namespace" "ingext"

# 3) Ask permission readiness questions (human-verifiable)
echo ""
echo "=== Permissions and Readiness Questions ==="
echo "(Answer honestly, this avoids failed installs)"
prompt HAS_BILLING "Do you have an active Azure subscription with billing enabled? (yes/no)" "yes"
prompt HAS_OWNER "Do you have Owner or Contributor permissions to create AKS, Storage Accounts, and Managed Identities? (yes/no)" "yes"
prompt HAS_QUOTA "Do you expect enough quota in region '$LOCATION' for at least ${NODE_COUNT} nodes + App Gateway + Storage? (yes/no/unsure)" "unsure"
prompt HAS_STORAGE "Do you understand that storage account names must be globally unique? (yes/no)" "yes"

# 4) Best-effort technical checks
echo ""
echo "---------------- Best-effort checks ----------------"

echo ""
echo "[Check] Providers registered (AKS + Network + Storage)"
# First verify we have a valid subscription
if ! az account show >/dev/null 2>&1; then
  echo "  ${RED}${CROSS_MARK} ERROR: No valid subscription is set. Cannot check provider registration.${NC}"
  echo "  Please set a valid subscription first:"
  echo "    1. List available subscriptions: az account list --output table"
  echo "    2. Set subscription: az account set --subscription \"<name-or-id>\""
  RP_AKS="ERROR_NO_SUBSCRIPTION"
  RP_NET="ERROR_NO_SUBSCRIPTION"
  RP_STOR="ERROR_NO_SUBSCRIPTION"
else
  RP_AKS="$(az provider show -n Microsoft.ContainerService --query registrationState -o tsv 2>/dev/null || echo "ERROR")"
  RP_NET="$(az provider show -n Microsoft.Network --query registrationState -o tsv 2>/dev/null || echo "ERROR")"
  RP_STOR="$(az provider show -n Microsoft.Storage --query registrationState -o tsv 2>/dev/null || echo "ERROR")"
  
  # Check if the error is due to subscription not found
  if [[ "$RP_AKS" == "ERROR" ]]; then
    ERROR_MSG="$(az provider show -n Microsoft.ContainerService 2>&1 || true)"
    if echo "$ERROR_MSG" | grep -q "SubscriptionNotFound"; then
      RP_AKS="ERROR_SUBSCRIPTION_NOT_FOUND"
      RP_NET="ERROR_SUBSCRIPTION_NOT_FOUND"
      RP_STOR="ERROR_SUBSCRIPTION_NOT_FOUND"
    fi
  fi
fi

# Display with color coding
if [[ "$RP_AKS" == "Registered" ]]; then
  printf "  Microsoft.ContainerService: ${GREEN}${CHECK_MARK} Registered${NC}\n"
else
  printf "  Microsoft.ContainerService: ${RED}${CROSS_MARK} ${RP_AKS:-unknown}${NC}\n"
fi

if [[ "$RP_NET" == "Registered" ]]; then
  printf "  Microsoft.Network:          ${GREEN}${CHECK_MARK} Registered${NC}\n"
else
  printf "  Microsoft.Network:          ${RED}${CROSS_MARK} ${RP_NET:-unknown}${NC}\n"
fi

if [[ "$RP_STOR" == "Registered" ]]; then
  printf "  Microsoft.Storage:          ${GREEN}${CHECK_MARK} Registered${NC}\n"
else
  printf "  Microsoft.Storage:          ${RED}${CROSS_MARK} ${RP_STOR:-unknown}${NC}\n"
fi

if [[ "$RP_AKS" == "ERROR_NO_SUBSCRIPTION" ]]; then
  printf "  ${RED}ACTION REQUIRED: Set a valid subscription before proceeding.${NC}\n"
elif [[ "$RP_AKS" == "ERROR_SUBSCRIPTION_NOT_FOUND" ]]; then
  printf "  ${RED}ERROR: The current subscription is not accessible or doesn't exist.${NC}\n"
  echo "  Please:"
  echo "    1. Clear stale subscription: az account clear"
  echo "    2. Login again: az login"
  echo "    3. List subscriptions: az account list --output table"
  echo "    4. Set a valid subscription: az account set --subscription \"<name-or-id>\""
elif [[ "$RP_AKS" != "Registered" || "$RP_NET" != "Registered" || "$RP_STOR" != "Registered" ]]; then
  echo ""
  printf "  ${YELLOW}${WARNING_MARK} Some providers are not registered. Resource creation may fail.${NC}\n"
  echo ""
  echo "  To register providers (requires valid subscription):"
  NEEDS_REGISTRATION=0
  if [[ "$RP_AKS" != "Registered" ]]; then
    printf "    ${YELLOW}az provider register -n Microsoft.ContainerService${NC}\n"
    NEEDS_REGISTRATION=1
  fi
  if [[ "$RP_NET" != "Registered" ]]; then
    printf "    ${YELLOW}az provider register -n Microsoft.Network${NC}\n"
    NEEDS_REGISTRATION=1
  fi
  if [[ "$RP_STOR" != "Registered" ]]; then
    printf "    ${YELLOW}az provider register -n Microsoft.Storage${NC}\n"
    NEEDS_REGISTRATION=1
  fi
  if [[ $NEEDS_REGISTRATION -eq 1 ]]; then
    echo ""
    echo "  Registration can take 1-5 minutes. Check status:"
    if [[ "$RP_AKS" != "Registered" ]]; then
      echo "    az provider show -n Microsoft.ContainerService --query registrationState"
    fi
    if [[ "$RP_NET" != "Registered" ]]; then
      echo "    az provider show -n Microsoft.Network --query registrationState"
    fi
    if [[ "$RP_STOR" != "Registered" ]]; then
      echo "    az provider show -n Microsoft.Storage --query registrationState"
    fi
  fi
fi

echo ""
echo "[Check] Quota availability for AKS cluster"
# Calculate required vCPUs
# Extract vCPU count from VM size name (e.g., dc2s_v3 = 2, dc4s_v3 = 4)
VM_SIZE_LOWER=$(echo "$NODE_VM_SIZE" | tr '[:upper:]' '[:lower:]')
VCPU_COUNT=2  # Default assumption
if echo "$VM_SIZE_LOWER" | grep -qE "dc([0-9]+)|ds([0-9]+)|ec([0-9]+)"; then
    # Extract number after dc/ds/ec (e.g., dc2s_v3 -> 2, dc4s_v3 -> 4)
    VCPU_COUNT=$(echo "$VM_SIZE_LOWER" | sed -E 's/.*(dc|ds|ec)([0-9]+).*/\2/' | head -c 1)
    if ! [[ "$VCPU_COUNT" =~ ^[0-9]+$ ]] || [ -z "$VCPU_COUNT" ]; then
        VCPU_COUNT=2  # Fallback to 2 if extraction fails
    fi
fi

# Check quota using Azure CLI native queries
QUOTA_CHECK_FAILED=0

# Get Total Regional vCPUs quota
TOTAL_REGIONAL_QUOTA=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Total Regional vCPUs'].limit" -o tsv 2>/dev/null || echo "")
TOTAL_REGIONAL_USED=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Total Regional vCPUs'].currentValue" -o tsv 2>/dev/null || echo "")

if [[ -z "$TOTAL_REGIONAL_QUOTA" ]] || [[ -z "$TOTAL_REGIONAL_USED" ]]; then
  printf "  ${YELLOW}${WARNING_MARK} Unable to query quota. You may lack permission.${NC}\n"
  echo "     Proceeding anyway, but quota errors may occur during cluster creation."
  QUOTA_CHECK_FAILED=1
else
    TOTAL_REGIONAL_AVAILABLE=$((TOTAL_REGIONAL_QUOTA - TOTAL_REGIONAL_USED))
    REQUIRED_VCPUS_WITH_BUFFER=$((NODE_COUNT * VCPU_COUNT + VCPU_COUNT))  # Add surge buffer
    
    if [[ $TOTAL_REGIONAL_AVAILABLE -lt $REQUIRED_VCPUS_WITH_BUFFER ]]; then
        printf "  ${RED}${CROSS_MARK} Insufficient quota!${NC}\n"
        printf "     Available: ${RED}$TOTAL_REGIONAL_AVAILABLE${NC} vCPUs\n"
        printf "     Required: ${RED}$REQUIRED_VCPUS_WITH_BUFFER${NC} vCPUs (for $NODE_COUNT node(s) + surge buffer)\n"
        printf "     Shortage: ${RED}$((REQUIRED_VCPUS_WITH_BUFFER - TOTAL_REGIONAL_AVAILABLE))${NC} vCPUs\n"
        QUOTA_CHECK_FAILED=1
        
        # Only check family quota if regional quota fails
        VM_FAMILY=""
        if echo "$VM_SIZE_LOWER" | grep -q "dc.*v3"; then
            VM_FAMILY="Standard DCSv3 Family vCPUs"
        elif echo "$VM_SIZE_LOWER" | grep -q "ds.*v3"; then
            VM_FAMILY="Standard DSv3 Family vCPUs"
        elif echo "$VM_SIZE_LOWER" | grep -q "dc.*v2"; then
            VM_FAMILY="Standard DCSv2 Family vCPUs"
        elif echo "$VM_SIZE_LOWER" | grep -q "ds.*v2"; then
            VM_FAMILY="Standard DSv2 Family vCPUs"
        fi
        
        if [[ -n "$VM_FAMILY" ]]; then
            FAMILY_QUOTA=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='$VM_FAMILY'].limit" -o tsv 2>/dev/null || echo "")
            FAMILY_USED=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='$VM_FAMILY'].currentValue" -o tsv 2>/dev/null || echo "")
            
            if [[ -n "$FAMILY_QUOTA" ]] && [[ -n "$FAMILY_USED" ]] && [[ "$FAMILY_QUOTA" =~ ^[0-9]+$ ]] && [[ "$FAMILY_USED" =~ ^[0-9]+$ ]]; then
                FAMILY_AVAILABLE=$((FAMILY_QUOTA - FAMILY_USED))
                if [[ $FAMILY_AVAILABLE -lt $REQUIRED_VCPUS_WITH_BUFFER ]]; then
                    echo ""
                    printf "     Also insufficient $VM_FAMILY quota:\n"
                    printf "     Available: ${RED}$FAMILY_AVAILABLE${NC} vCPUs\n"
                    printf "     Required: ${RED}$REQUIRED_VCPUS_WITH_BUFFER${NC} vCPUs\n"
                fi
            fi
        fi
    else
        printf "  ${GREEN}${CHECK_MARK} Sufficient quota available${NC} ($TOTAL_REGIONAL_AVAILABLE vCPUs available, need $REQUIRED_VCPUS_WITH_BUFFER)\n"
    fi
    
    if [[ $QUOTA_CHECK_FAILED -eq 1 ]]; then
        echo ""
        echo "  ⚠️  QUOTA CHECK FAILED - Cluster creation will likely fail!"
        echo ""
        echo "  To resolve:"
        echo "    1. Delete unused resources to free quota:"
        echo "       az vm list --query \"[].{Name:name, ResourceGroup:resourceGroup}\" -o table"
        echo "       az aks list --query \"[].{Name:name, ResourceGroup:resourceGroup}\" -o table"
        echo ""
        echo "    2. Request quota increase:"
        echo "       https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/overview"
        echo ""
        echo "    3. Use a different region with available quota"
        echo ""
        read -rp "  Continue anyway? (yes/no): " CONTINUE_ANYWAY
        if [[ ! "${CONTINUE_ANYWAY,,}" =~ ^yes$ ]]; then
            echo ""
            echo "Exiting. Please resolve quota issues before proceeding."
            exit 1
        fi
        echo ""
    fi
fi

# Don't show the full quota table - it's too confusing
# Only show it if quota check failed and user wants details

echo ""
echo "[Check] Storage account name availability"
# Check if storage account name is available (best effort - may not catch all cases)
if az storage account check-name --name "$STORAGE_ACCOUNT_NAME" >/dev/null 2>&1; then
  CHECK_RESULT=$(az storage account check-name --name "$STORAGE_ACCOUNT_NAME" --query nameAvailable -o tsv 2>/dev/null || echo "unknown")
  if [[ "$CHECK_RESULT" == "true" ]]; then
    echo "  ✓ Storage account name '$STORAGE_ACCOUNT_NAME' appears to be available"
  elif [[ "$CHECK_RESULT" == "false" ]]; then
    echo "  ⚠️  WARNING: Storage account name '$STORAGE_ACCOUNT_NAME' may already be taken"
    echo "     You may need to choose a different name"
  else
    echo "  Note: Could not verify storage account name availability"
  fi
else
  echo "  Note: Could not check storage account name availability"
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
  echo "WARNING: Owner/Contributor-level permissions not confirmed. Install will likely fail."
  WARN=1
fi

if [[ "${HAS_STORAGE,,}" != "yes" ]]; then
  echo "WARNING: Storage account naming requirements not understood."
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
echo "Writing environment file: $OUTPUT_ENV"

cat > "$OUTPUT_ENV" <<EOF
# Generated by preflight-azure-datalake.sh
# Usage:
#   source $OUTPUT_ENV
#   ./aks_setup.sh "\$RESOURCE_GROUP" "\$LOCATION" "\$CLUSTER_NAME" "\$NODE_COUNT"
#   ./create_blob_storage.sh "\$RESOURCE_GROUP" "\$LOCATION" "\$STORAGE_ACCOUNT_NAME" "\$CONTAINER_NAME" "\$EXPIRE_DAYS"
#   ./setup_ingext_serviceaccount.sh "\$RESOURCE_GROUP" "\$CLUSTER_NAME" "\$NAMESPACE" "\$STORAGE_ACCOUNT_NAME"

# Azure Configuration
export RESOURCE_GROUP="$(printf '%s' "$RESOURCE_GROUP")"
export LOCATION="$(printf '%s' "$LOCATION")"
export CLUSTER_NAME="$(printf '%s' "$CLUSTER_NAME")"
export NODE_COUNT="$(printf '%s' "$NODE_COUNT")"
export NODE_VM_SIZE="$(printf '%s' "$NODE_VM_SIZE")"

# Storage Configuration
export STORAGE_ACCOUNT_NAME="$(printf '%s' "$STORAGE_ACCOUNT_NAME")"
export CONTAINER_NAME="$(printf '%s' "$CONTAINER_NAME")"
export EXPIRE_DAYS="$(printf '%s' "$EXPIRE_DAYS")"

# Kubernetes Configuration
export NAMESPACE="$(printf '%s' "$NAMESPACE")"

# Node Pool Configuration (optional, can be overridden)
export MERGE_VM_SIZE="${MERGE_VM_SIZE:-Standard_D4s_v3}"
export SEARCH_VM_SIZE="${SEARCH_VM_SIZE:-Standard_D4s_v3}"

# Self-reported readiness (for support/debugging)
export PREFLIGHT_HAS_BILLING="$(printf '%s' "$HAS_BILLING")"
export PREFLIGHT_HAS_OWNER="$(printf '%s' "$HAS_OWNER")"
export PREFLIGHT_HAS_QUOTA="$(printf '%s' "$HAS_QUOTA")"
export PREFLIGHT_HAS_STORAGE="$(printf '%s' "$HAS_STORAGE")"
EOF

echo ""
echo "Done."
echo ""
echo "Next steps:"
echo "  1) source $OUTPUT_ENV"
echo "  2) Run setup scripts in order (no arguments needed if env vars are set):"
echo "     ./aks_setup.sh"
echo "     ./create_blob_storage.sh"
echo "     ./setup_ingext_serviceaccount.sh"
echo "     ./setup_aks_nodepools.sh"
echo ""
echo "     Or override specific values:"
echo "     ./aks_setup.sh ingext-rg eastus  # overrides RESOURCE_GROUP and LOCATION"
echo ""
echo "  3) Follow azure_install.md for datalake component installation"
echo ""

