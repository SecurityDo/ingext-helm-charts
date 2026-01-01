#!/bin/bash

# ==============================================================================
# Script Name: cleanup-azure-datalake.sh
# Usage: ./cleanup-azure-datalake.sh [resourceGroup1] [resourceGroup2] ...
# Description: Deletes AKS clusters and resource groups to free up quota
# ==============================================================================

set -e

# Default resource groups to clean up (can be overridden via command line)
RESOURCE_GROUPS=(
    "ingext-datalake-rg"
    "ingext-rg"
    "ingext-trial"
)

# If command line arguments provided, use those instead
if [ $# -gt 0 ]; then
    RESOURCE_GROUPS=("$@")
fi

echo "=========================================================="
echo "🧹 Azure Datalake Cleanup Script"
echo "=========================================================="
echo ""
echo "This will delete:"
echo "  - AKS clusters in the specified resource groups"
echo "  - Managed resource groups (MC_*)"
echo "  - The resource groups themselves"
echo ""
echo "Resource groups to clean up:"
for rg in "${RESOURCE_GROUPS[@]}"; do
    echo "  - $rg"
done
echo ""

# Check Azure login
if ! az account show >/dev/null 2>&1; then
    echo "Please login to Azure..."
    az login
fi

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
SUBSCRIPTION_NAME=$(az account show --query name -o tsv)
echo "Subscription: $SUBSCRIPTION_NAME ($SUBSCRIPTION_ID)"
echo ""

read -rp "⚠️  Are you sure you want to delete these resources? (yes/no): " CONFIRM
if [[ ! "${CONFIRM,,}" =~ ^yes$ ]]; then
    echo "Cancelled. No resources were deleted."
    exit 0
fi

echo ""
echo "Starting cleanup..."
echo ""

# Function to delete AKS cluster
delete_aks_cluster() {
    local rg="$1"
    local cluster_name="$2"
    
    if az aks show --resource-group "$rg" --name "$cluster_name" >/dev/null 2>&1; then
        echo "  -> Deleting AKS cluster: $cluster_name in $rg"
        az aks delete --resource-group "$rg" --name "$cluster_name" --yes --no-wait || {
            echo "    ⚠️  Failed to delete cluster (may already be deleting)"
        }
        
        # Wait a bit for the managed resource group to be created/identified
        sleep 2
        
        # Find and delete the managed resource group
        MANAGED_RG="MC_${rg}_${cluster_name}_*"
        for managed_rg in $(az group list --query "[?starts_with(name, 'MC_${rg}_${cluster_name}')].name" -o tsv 2>/dev/null || true); do
            if [ -n "$managed_rg" ]; then
                echo "  -> Deleting managed resource group: $managed_rg"
                az group delete --name "$managed_rg" --yes --no-wait || {
                    echo "    ⚠️  Failed to delete managed RG (may already be deleting)"
                }
            fi
        done
    fi
}

# Function to delete all AKS clusters in a resource group
delete_all_aks_clusters() {
    local rg="$1"
    
    if ! az group show --name "$rg" >/dev/null 2>&1; then
        echo "  ℹ️  Resource group '$rg' does not exist, skipping"
        return
    fi
    
    echo "Processing resource group: $rg"
    
    # List all AKS clusters in this resource group
    CLUSTERS=$(az aks list --resource-group "$rg" --query "[].name" -o tsv 2>/dev/null || echo "")
    
    if [ -z "$CLUSTERS" ]; then
        echo "  ℹ️  No AKS clusters found in $rg"
    else
        while IFS= read -r cluster; do
            if [ -n "$cluster" ]; then
                delete_aks_cluster "$rg" "$cluster"
            fi
        done <<< "$CLUSTERS"
    fi
    
    # Also check for managed resource groups that might exist
    echo "  -> Checking for managed resource groups..."
    for managed_rg in $(az group list --query "[?starts_with(name, 'MC_${rg}')].name" -o tsv 2>/dev/null || true); do
        if [ -n "$managed_rg" ]; then
            echo "  -> Deleting managed resource group: $managed_rg"
            az group delete --name "$managed_rg" --yes --no-wait || {
                echo "    ⚠️  Failed to delete managed RG (may already be deleting)"
            }
        fi
    done
    
    echo ""
}

# Delete all AKS clusters first
echo "Step 1: Deleting AKS clusters..."
echo "=========================================================="
for rg in "${RESOURCE_GROUPS[@]}"; do
    delete_all_aks_clusters "$rg"
done

# Wait a moment for deletions to start
echo "Waiting 10 seconds for deletions to initialize..."
sleep 10

# Delete the resource groups themselves
echo ""
echo "Step 2: Deleting resource groups..."
echo "=========================================================="
for rg in "${RESOURCE_GROUPS[@]}"; do
    if az group show --name "$rg" >/dev/null 2>&1; then
        echo "Deleting resource group: $rg"
        az group delete --name "$rg" --yes --no-wait || {
            echo "  ⚠️  Failed to delete resource group (may have dependencies)"
        }
    else
        echo "Resource group '$rg' does not exist, skipping"
    fi
done

echo ""
echo "=========================================================="
echo "✅ Cleanup initiated!"
echo "=========================================================="
echo ""
echo "Note: Deletions are running in the background (--no-wait flag)."
echo "This may take 10-30 minutes to complete."
echo ""
echo "To check status:"
echo "  az group list --query \"[?contains(name, 'ingext')].{Name:name, Location:location}\" -o table"
echo ""
echo "To check quota after cleanup:"
echo "  az vm list-usage --location eastus -o table"
echo ""

