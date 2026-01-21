#!/bin/bash

set -e  # Abort script immediately if any command fails
set -o pipefail

# ==========================================
# 1. VARIABLES (Update these before running)
# ==========================================
RG_NAME="<Your-Resource-Group>"
NAMESPACE_NAME="<Your-Namespace>"
HUB_NAME="<Your-Event-Hub-Name>"
LOCATION="eastus"

# Set to true if using Basic Tier (which forces use of $Default consumer group)
# Set to false if using Standard Tier (allows custom consumer groups)
BASIC_TIER=false

# Name for the new Consumer Group (ignored if BASIC_TIER=true)
CONSUMER_GROUP_NAME="ingext"

# Name for the Security Policy (SAS Key for reading)
POLICY_NAME="IngextReaderPolicy"

# Storage Account Name (Must be lowercase, numbers only, globally unique)
STORAGE_ACCOUNT_NAME="ingextreader$RANDOM" # Added random to ensure uniqueness
CONTAINER_NAME="ingext-checkpoints"

# ==========================================
# 2. EXECUTION START
# ==========================================
echo "--- Starting Configuration ---"

# --- PART A: STORAGE SETUP ---
echo ""
echo ">>> Setting up Storage Account: $STORAGE_ACCOUNT_NAME"

# Check if storage account exists, if not create it
if az storage account show --name "$STORAGE_ACCOUNT_NAME" --resource-group "$RG_NAME" >/dev/null 2>&1; then
    echo "Storage account '$STORAGE_ACCOUNT_NAME' already exists. Skipping creation."
else
    echo "Creating Storage Account..."
    az storage account create \
        --name "$STORAGE_ACCOUNT_NAME" \
        --resource-group "$RG_NAME" \
        --location "$LOCATION" \
        --sku Standard_LRS \
        --kind StorageV2
fi

echo ">>> Creating Container: $CONTAINER_NAME"
az storage container create \
    --name "$CONTAINER_NAME" \
    --account-name "$STORAGE_ACCOUNT_NAME" \
    --auth-mode login

echo ">>> Fetching Storage Connection String..."
STORAGE_CONN_STR=$(az storage account show-connection-string \
    --name "$STORAGE_ACCOUNT_NAME" \
    --resource-group "$RG_NAME" \
    --output tsv)

# --- PART B: EVENT HUB CONSUMER GROUP ---
echo ""
echo ">>> Setting up Consumer Group"

FINAL_CONSUMER_GROUP=""

if [ "$BASIC_TIER" = true ]; then
    echo "Basic Tier selected. Skipping custom Consumer Group creation."
    echo "Using system default: '\$Default'"
    FINAL_CONSUMER_GROUP="\$Default"
else
    echo "Standard Tier selected. Creating Consumer Group: '$CONSUMER_GROUP_NAME'..."
    # Check if exists to avoid error on re-run
    if az eventhubs eventhub consumer-group show --resource-group "$RG_NAME" --namespace-name "$NAMESPACE_NAME" --eventhub-name "$HUB_NAME" --name "$CONSUMER_GROUP_NAME" >/dev/null 2>&1; then
         echo "Consumer group '$CONSUMER_GROUP_NAME' already exists."
    else
         az eventhubs eventhub consumer-group create \
            --resource-group "$RG_NAME" \
            --namespace-name "$NAMESPACE_NAME" \
            --eventhub-name "$HUB_NAME" \
            --name "$CONSUMER_GROUP_NAME"
    fi
    FINAL_CONSUMER_GROUP="$CONSUMER_GROUP_NAME"
fi

# --- PART C: SECURITY POLICY (SAS) ---
echo ""
echo ">>> Setting up Access Policy: $POLICY_NAME"

# Create/Update the policy with Listen rights
az eventhubs eventhub authorization-rule create \
    --resource-group "$RG_NAME" \
    --namespace-name "$NAMESPACE_NAME" \
    --eventhub-name "$HUB_NAME" \
    --name "$POLICY_NAME" \
    --rights Listen

echo ">>> Fetching Event Hub Connection String..."
EH_CONN_STR=$(az eventhubs eventhub authorization-rule keys list \
    --resource-group "$RG_NAME" \
    --namespace-name "$NAMESPACE_NAME" \
    --eventhub-name "$HUB_NAME" \
    --name "$POLICY_NAME" \
    --query "primaryConnectionString" -o tsv)

# ==========================================
# 3. FINAL OUTPUT
# ==========================================
echo ""
echo "========================================================"
echo "       CONFIGURATION SUCCESSFUL - READER SETUP          "
echo "========================================================"
echo ""
echo "Event Hub Name:           $HUB_NAME"
echo "Consumer Group:           $FINAL_CONSUMER_GROUP"
echo "Event Hub Conn String:    $EH_CONN_STR"
echo ""
echo "Storage Container:        $CONTAINER_NAME"
echo "Storage Conn String:      $STORAGE_CONN_STR"
echo ""
echo "========================================================"
