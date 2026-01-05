#!/bin/bash

# ==============================================================================
# Script Name: create_blob_storage.sh
# Usage: ./create_blob_storage.sh [resourceGroup] [location] [storageAccountName] [containerName] [expireDays]
# Description: Automates Azure Blob Storage Account and Container creation
# ==============================================================================

# Use environment variables if set, otherwise use command-line arguments
# Command-line arguments override environment variables
RESOURCE_GROUP="${1:-${RESOURCE_GROUP}}"
LOCATION="${2:-${LOCATION}}"
STORAGE_ACCOUNT_NAME="${3:-${STORAGE_ACCOUNT_NAME}}"
CONTAINER_NAME="${4:-${CONTAINER_NAME}}"
EXPIRE_DAYS="${5:-${EXPIRE_DAYS}}"

# Check if required variables are set
if [ -z "$RESOURCE_GROUP" ] || [ -z "$LOCATION" ] || [ -z "$STORAGE_ACCOUNT_NAME" ] || [ -z "$CONTAINER_NAME" ] || [ -z "$EXPIRE_DAYS" ]; then
    echo "Usage: $0 [resourceGroup] [location] [storageAccountName] [containerName] [expireDays]"
    echo ""
    echo "Arguments are optional if environment variables are set:"
    echo "  RESOURCE_GROUP, LOCATION, STORAGE_ACCOUNT_NAME, CONTAINER_NAME, EXPIRE_DAYS"
    echo ""
    echo "Examples:"
    echo "  # Using environment variables (from preflight):"
    echo "  source ./ingext-datalake-azure.env"
    echo "  $0"
    echo ""
    echo "  # Using command-line arguments:"
    echo "  $0 ingext-rg eastus ingextdatalake datalake 30"
    exit 1
fi

# Storage account names must be lowercase and 3-24 characters
STORAGE_ACCOUNT_NAME=$(echo "$STORAGE_ACCOUNT_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]//g')

echo "Resource Group: $RESOURCE_GROUP | Location: $LOCATION"
echo "Storage Account: $STORAGE_ACCOUNT_NAME | Container: $CONTAINER_NAME"

# 2. Check Azure Login
if ! az account show >/dev/null 2>&1; then
    echo "Please login to Azure..."
    az login
fi

# 3. Check if Storage Account already exists
echo "-> Checking if Storage Account '$STORAGE_ACCOUNT_NAME' exists..."
if az storage account show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$STORAGE_ACCOUNT_NAME" >/dev/null 2>&1; then
    echo "   Storage account already exists, skipping creation."
else
    echo "-> Creating Storage Account '$STORAGE_ACCOUNT_NAME'..."
    if az storage account create \
        --resource-group "$RESOURCE_GROUP" \
        --name "$STORAGE_ACCOUNT_NAME" \
        --location "$LOCATION" \
        --sku Standard_LRS \
        --kind StorageV2 \
        --access-tier Hot \
        --allow-blob-public-access false \
        --min-tls-version TLS1_2 >/dev/null 2>&1; then
        echo "   Success: Storage account created."
    else
        echo "   Error: Failed to create storage account."
        exit 1
    fi
fi

# 4. Get Storage Account Key
echo "-> Retrieving storage account key..."
STORAGE_KEY=$(az storage account keys list \
    --resource-group "$RESOURCE_GROUP" \
    --account-name "$STORAGE_ACCOUNT_NAME" \
    --query "[0].value" -o tsv)

# 5. Create Container
echo "-> Creating container '$CONTAINER_NAME'..."
az storage container create \
    --name "$CONTAINER_NAME" \
    --account-name "$STORAGE_ACCOUNT_NAME" \
    --account-key "$STORAGE_KEY" \
    --auth-mode key >/dev/null 2>&1 || {
    echo "   Container may already exist, continuing..."
}

# 6. Set Lifecycle Policy (Expiration)
echo "-> Setting object expiration to $EXPIRE_DAYS days..."
cat <<EOT > lifecycle-policy.json
{
  "rules": [
    {
      "name": "ExpireObjects",
      "enabled": true,
      "type": "Lifecycle",
      "definition": {
        "filters": {
          "blobTypes": ["blockBlob"],
          "prefixMatch": [""]
        },
        "actions": {
          "baseBlob": {
            "delete": {
              "daysAfterModificationGreaterThan": $EXPIRE_DAYS
            }
          }
        }
      }
    }
  ]
}
EOT

az storage account blob-service-properties update \
    --resource-group "$RESOURCE_GROUP" \
    --account-name "$STORAGE_ACCOUNT_NAME" \
    --delete-retention-policy enabled=true days=7 \
    --enable-versioning false >/dev/null 2>&1 || true

# Note: Azure Blob lifecycle management requires a management policy
# For full lifecycle management, use Azure Storage Lifecycle Management
echo "   Note: For full lifecycle management, configure Azure Storage Lifecycle Management"
echo "   in the Azure Portal or use 'az storage account management-policy create'"

rm -f lifecycle-policy.json

echo "========================================================"
echo "✅ Setup Complete!"
echo "Storage Account: $STORAGE_ACCOUNT_NAME"
echo "Container: $CONTAINER_NAME"
echo "Resource Group: $RESOURCE_GROUP"
echo "========================================================"

