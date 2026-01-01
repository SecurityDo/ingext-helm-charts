#!/bin/bash

# ==============================================================================
# Script Name: force-cleanup.sh
# Usage: ./force-cleanup.sh
# Description: Forcefully deletes all Azure datalake resources immediately
# ==============================================================================

set -e

echo "=========================================================="
echo "🧹 Force Cleanup - Deleting ALL Azure Datalake Resources"
echo "=========================================================="
echo ""

# Check Azure login
if ! az account show >/dev/null 2>&1; then
    echo "Please login to Azure..."
    az login
fi

LOCATION="${LOCATION:-eastus}"

echo "Checking for existing resources..."
echo ""

# Find all resource groups with "ingext" in the name
echo "Step 1: Finding resource groups..."
RESOURCE_GROUPS=$(az group list --query "[?contains(name, 'ingext')].name" -o tsv 2>/dev/null || echo "")

if [ -z "$RESOURCE_GROUPS" ]; then
    echo "  No resource groups found with 'ingext' in name"
else
    echo "  Found resource groups:"
    echo "$RESOURCE_GROUPS" | while read -r rg; do
        echo "    - $rg"
    done
fi
echo ""

# Find all AKS clusters
echo "Step 2: Finding AKS clusters..."
CLUSTERS=$(az aks list --query "[].{Name:name, RG:resourceGroup}" -o tsv 2>/dev/null || echo "")

if [ -z "$CLUSTERS" ]; then
    echo "  No AKS clusters found"
else
    echo "  Found AKS clusters:"
    echo "$CLUSTERS" | while IFS=$'\t' read -r name rg; do
        echo "    - $name (in $rg)"
    done
fi
echo ""

# Find managed resource groups (MC_*)
echo "Step 3: Finding managed resource groups (MC_*)..."
MANAGED_RGS=$(az group list --query "[?starts_with(name, 'MC_')].name" -o tsv 2>/dev/null || echo "")

if [ -z "$MANAGED_RGS" ]; then
    echo "  No managed resource groups found"
else
    echo "  Found managed resource groups:"
    echo "$MANAGED_RGS" | while read -r rg; do
        echo "    - $rg"
    done
fi
echo ""

read -rp "⚠️  Delete ALL of these resources? (yes/no): " CONFIRM
if [[ ! "${CONFIRM,,}" =~ ^yes$ ]]; then
    echo "Cancelled."
    exit 0
fi

echo ""
echo "Starting deletion..."
echo ""

# Delete all AKS clusters (wait for completion)
if [ -n "$CLUSTERS" ]; then
    echo "Deleting AKS clusters..."
    echo "$CLUSTERS" | while IFS=$'\t' read -r name rg; do
        if [ -n "$name" ] && [ -n "$rg" ]; then
            echo "  -> Deleting cluster: $name in $rg"
            if az aks show --resource-group "$rg" --name "$name" >/dev/null 2>&1; then
                az aks delete --resource-group "$rg" --name "$name" --yes --no-wait
                echo "    ✓ Deletion initiated"
            fi
        fi
    done
fi

# Wait a bit for managed RGs to be identified
sleep 5

# Delete managed resource groups
if [ -n "$MANAGED_RGS" ]; then
    echo ""
    echo "Deleting managed resource groups..."
    echo "$MANAGED_RGS" | while read -r rg; do
        if [ -n "$rg" ]; then
            echo "  -> Deleting: $rg"
            az group delete --name "$rg" --yes --no-wait 2>/dev/null || true
            echo "    ✓ Deletion initiated"
        fi
    done
fi

# Delete main resource groups
if [ -n "$RESOURCE_GROUPS" ]; then
    echo ""
    echo "Deleting resource groups..."
    echo "$RESOURCE_GROUPS" | while read -r rg; do
        if [ -n "$rg" ]; then
            echo "  -> Deleting: $rg"
            az group delete --name "$rg" --yes --no-wait 2>/dev/null || true
            echo "    ✓ Deletion initiated"
        fi
    done
fi

echo ""
echo "=========================================================="
echo "✅ Deletion initiated for all resources"
echo "=========================================================="
echo ""
echo "Waiting 30 seconds, then checking status..."
sleep 30

echo ""
echo "Current status:"
echo "  Resource groups:"
az group list --query "[?contains(name, 'ingext')].{Name:name, State:properties.provisioningState}" -o table 2>/dev/null || echo "    (checking...)"

echo ""
echo "  AKS clusters:"
az aks list --query "[].{Name:name, RG:resourceGroup, State:powerState.code}" -o table 2>/dev/null || echo "    (checking...)"

echo ""
echo "  Quota usage:"
az vm list-usage --location "$LOCATION" --query "[?name.value=='Total Regional vCPUs' || name.value=='Standard DCSv3 Family vCPUs'].{Name:name.value, Used:currentValue, Limit:limit}" -o table 2>/dev/null || echo "    (checking...)"

echo ""
echo "Note: Deletions may take 10-30 minutes to complete."
echo "Run this script again to check status, or:"
echo "  az group list --query \"[?contains(name, 'ingext')].name\" -o table"

