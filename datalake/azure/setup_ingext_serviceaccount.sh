#!/bin/bash

# ==============================================================================
# Script Name: setup_ingext_serviceaccount.sh
# Usage: ./setup_ingext_serviceaccount.sh [resourceGroup] [clusterName] [namespace] [storageAccountName]
# Description: Creates a K8s Service Account with:
#              1. Azure Managed Identity with permissions to access Blob Storage.
# ==============================================================================

set -e # Exit on error

# Use environment variables if set, otherwise use command-line arguments
# Command-line arguments override environment variables
RESOURCE_GROUP="${1:-${RESOURCE_GROUP}}"
CLUSTER_NAME="${2:-${CLUSTER_NAME}}"
NAMESPACE="${3:-${NAMESPACE}}"
STORAGE_ACCOUNT_NAME="${4:-${STORAGE_ACCOUNT_NAME}}"

# Check if required variables are set
if [ -z "$RESOURCE_GROUP" ] || [ -z "$CLUSTER_NAME" ] || [ -z "$NAMESPACE" ] || [ -z "$STORAGE_ACCOUNT_NAME" ]; then
    echo "Usage: $0 [resourceGroup] [clusterName] [namespace] [storageAccountName]"
    echo ""
    echo "Arguments are optional if environment variables are set:"
    echo "  RESOURCE_GROUP, CLUSTER_NAME, NAMESPACE, STORAGE_ACCOUNT_NAME"
    echo ""
    echo "Examples:"
    echo "  # Using environment variables (from preflight):"
    echo "  source ./ingext-datalake-azure.env"
    echo "  $0"
    echo ""
    echo "  # Using command-line arguments:"
    echo "  $0 ingext-rg ingext-lake ingext ingextdatalake"
    exit 1
fi

# Derived Names
SA_NAME="${NAMESPACE}-sa"
IDENTITY_NAME="ingext-${SA_NAME}-identity"

# Export for Azure CLI
export RESOURCE_GROUP
export CLUSTER_NAME
export NAMESPACE

echo "=== Setup Service Account: $SA_NAME ==="
echo "Cluster: $CLUSTER_NAME | Namespace: $NAMESPACE | Storage Account: $STORAGE_ACCOUNT_NAME"

# 1. Check Azure Login
if ! az account show >/dev/null 2>&1; then
    echo "Please login to Azure..."
    az login
fi

# 2. Get Subscription ID
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
echo "-> Subscription ID: $SUBSCRIPTION_ID"

# 3. Update Kubeconfig
echo "-> Updating kubeconfig..."
az aks get-credentials \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER_NAME" \
    --overwrite-existing >/dev/null

# 4. Create Namespace if it doesn't exist
echo "-> Creating namespace '$NAMESPACE' if needed..."
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# Note: The service account is created by ingext-community chart
# This script only sets up the Azure Managed Identity and permissions

# ==============================================================================
# PART A: AZURE MANAGED IDENTITY SETUP (Blob Storage Access)
# ==============================================================================

# 5. Create User-Assigned Managed Identity
echo "-> Creating User-Assigned Managed Identity: $IDENTITY_NAME"
IDENTITY_ID=$(az identity create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$IDENTITY_NAME" \
    --query id -o tsv 2>/dev/null || \
    az identity show \
        --resource-group "$RESOURCE_GROUP" \
        --name "$IDENTITY_NAME" \
        --query id -o tsv)

if [ -z "$IDENTITY_ID" ]; then
    echo "   Error: Failed to create or retrieve managed identity"
    exit 1
fi

IDENTITY_CLIENT_ID=$(az identity show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$IDENTITY_NAME" \
    --query clientId -o tsv)

echo "   Identity ID: $IDENTITY_ID"
echo "   Client ID: $IDENTITY_CLIENT_ID"

# 6. Get Storage Account Resource ID
echo "-> Verifying storage account exists..."
STORAGE_ACCOUNT_ID=$(az storage account show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$STORAGE_ACCOUNT_NAME" \
    --query id -o tsv 2>/dev/null)

if [ -z "$STORAGE_ACCOUNT_ID" ]; then
    echo "   Error: Storage account '$STORAGE_ACCOUNT_NAME' not found in resource group '$RESOURCE_GROUP'"
    echo "   Please create the storage account first using:"
    echo "     ./create_blob_storage.sh"
    exit 1
fi
echo "   Storage account found: $STORAGE_ACCOUNT_NAME"

# 7. Assign Storage Blob Data Contributor Role to Managed Identity
echo "-> Assigning 'Storage Blob Data Contributor' role to managed identity..."
az role assignment create \
    --role "Storage Blob Data Contributor" \
    --assignee "$IDENTITY_CLIENT_ID" \
    --scope "$STORAGE_ACCOUNT_ID" \
    >/dev/null 2>&1 || {
    echo "   Role assignment may already exist, continuing..."
}

# 8. Get AKS Cluster Identity (for federated identity credential)
echo "-> Getting AKS cluster identity..."
AKS_OIDC_ISSUER=$(az aks show \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER_NAME" \
    --query "oidcIssuerProfile.issuerUrl" -o tsv)

if [ -z "$AKS_OIDC_ISSUER" ] || [ "$AKS_OIDC_ISSUER" == "None" ]; then
    echo "   Enabling OIDC issuer for AKS cluster..."
    az aks update \
        --resource-group "$RESOURCE_GROUP" \
        --name "$CLUSTER_NAME" \
        --enable-oidc-issuer \
        --enable-workload-identity >/dev/null
    
    # Wait a moment for the update to propagate
    sleep 10
    
    AKS_OIDC_ISSUER=$(az aks show \
        --resource-group "$RESOURCE_GROUP" \
        --name "$CLUSTER_NAME" \
        --query "oidcIssuerProfile.issuerUrl" -o tsv)
fi

echo "   OIDC Issuer: $AKS_OIDC_ISSUER"

# 9. Create Federated Identity Credential
echo "-> Creating federated identity credential..."
FEDERATED_IDENTITY_NAME="${IDENTITY_NAME}-federated"

az identity federated-credential create \
    --name "$FEDERATED_IDENTITY_NAME" \
    --identity-name "$IDENTITY_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --issuer "$AKS_OIDC_ISSUER" \
    --subject "system:serviceaccount:${NAMESPACE}:${SA_NAME}" \
    --audience api://AzureADTokenExchange \
    >/dev/null 2>&1 || {
    echo "   Federated credential may already exist, continuing..."
}

# 10. Create Service Account with Azure Workload Identity annotation
echo "-> Creating/updating service account with workload identity..."
kubectl apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: $SA_NAME
  namespace: $NAMESPACE
  annotations:
    azure.workload.identity/client-id: "$IDENTITY_CLIENT_ID"
EOF

echo "========================================================"
echo "✅ Setup Complete!"
echo "Cluster: $CLUSTER_NAME"
echo "Namespace: $NAMESPACE"
echo "Service Account: $SA_NAME"
echo "Managed Identity: $IDENTITY_NAME"
echo "Storage Account: $STORAGE_ACCOUNT_NAME"
echo ""
echo "Note: Ensure your pods use this service account and have"
echo "      the azure.workload.identity/use: 'true' label"
echo "========================================================"

