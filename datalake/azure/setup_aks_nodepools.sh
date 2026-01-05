#!/bin/bash

# ==============================================================================
# Script Name: setup_aks_nodepools.sh
# Usage: ./setup_aks_nodepools.sh [resourceGroup] [clusterName] [location]
# Description: Creates AKS node pools for datalake workloads (merge and search)
#              Similar to AWS's Karpenter NodePool setup
# ==============================================================================

set -e # Exit immediately if a command exits with a non-zero status

# Use environment variables if set, otherwise use command-line arguments
# Command-line arguments override environment variables
RESOURCE_GROUP="${1:-${RESOURCE_GROUP}}"
CLUSTER_NAME="${2:-${CLUSTER_NAME}}"
LOCATION="${3:-${LOCATION}}"

# Check if required variables are set
if [ -z "$RESOURCE_GROUP" ] || [ -z "$CLUSTER_NAME" ] || [ -z "$LOCATION" ]; then
    echo "Usage: $0 [resourceGroup] [clusterName] [location]"
    echo ""
    echo "Arguments are optional if environment variables are set:"
    echo "  RESOURCE_GROUP, CLUSTER_NAME, LOCATION"
    echo ""
    echo "Examples:"
    echo "  # Using environment variables (from preflight):"
    echo "  source ./ingext-datalake-azure.env"
    echo "  $0"
    echo ""
    echo "  # Using command-line arguments:"
    echo "  $0 ingext-rg ingext-lake eastus"
    exit 1
fi

# Node pool configuration (can be overridden via environment variables)
# Default to Standard_D2s_v3 (Dv3 family) which is commonly available
MERGE_VM_SIZE="${MERGE_VM_SIZE:-Standard_D2s_v3}"
MERGE_MIN_COUNT="${MERGE_MIN_COUNT:-1}"
MERGE_MAX_COUNT="${MERGE_MAX_COUNT:-1}"

SEARCH_VM_SIZE="${SEARCH_VM_SIZE:-Standard_D2s_v3}"
SEARCH_MIN_COUNT="${SEARCH_MIN_COUNT:-1}"
SEARCH_MAX_COUNT="${SEARCH_MAX_COUNT:-1}"

echo "=== Setting up AKS Node Pools for Cluster: $CLUSTER_NAME ==="
echo "Resource Group: $RESOURCE_GROUP"
echo "Location:       $LOCATION"
echo ""

# Check Azure Login
if ! az account show >/dev/null 2>&1; then
    echo "Please login to Azure..."
    az login
fi

# Verify cluster exists
echo "-> Verifying AKS cluster exists..."
if ! az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" >/dev/null 2>&1; then
    echo "Error: AKS cluster '$CLUSTER_NAME' not found in resource group '$RESOURCE_GROUP'"
    exit 1
fi

# Get cluster credentials
echo "-> Updating kubeconfig..."
az aks get-credentials \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER_NAME" \
    --overwrite-existing >/dev/null

# 1. Create merge node pool
# Note: Node pool names must be alphanumeric only (no hyphens)
MERGE_POOL_NAME="poolmerge"
echo ""
echo "-> Creating merge node pool ($MERGE_POOL_NAME)..."
echo "   VM Size: $MERGE_VM_SIZE"
echo "   Min: $MERGE_MIN_COUNT, Max: $MERGE_MAX_COUNT"

# Check if pool already exists
if az aks nodepool show \
    --resource-group "$RESOURCE_GROUP" \
    --cluster-name "$CLUSTER_NAME" \
    --name "$MERGE_POOL_NAME" >/dev/null 2>&1; then
    echo "   Node pool '$MERGE_POOL_NAME' already exists. Skipping creation."
else
    ERROR_LOG=$(mktemp)
    if ! az aks nodepool add \
        --resource-group "$RESOURCE_GROUP" \
        --cluster-name "$CLUSTER_NAME" \
        --name "$MERGE_POOL_NAME" \
        --node-count "$MERGE_MIN_COUNT" \
        --node-vm-size "$MERGE_VM_SIZE" \
        --mode User \
        --enable-cluster-autoscaler \
        --min-count "$MERGE_MIN_COUNT" \
        --max-count "$MERGE_MAX_COUNT" \
        --labels "node-pool=pool-merge" \
        --node-taints "node-pool=pool-merge:NoSchedule" \
        --os-type Linux \
        --os-sku Ubuntu > "$ERROR_LOG" 2>&1; then
        
        # Check for VM size not allowed error
        if grep -q "is not allowed in your subscription" "$ERROR_LOG"; then
            echo ""
            echo "   ✗ ERROR: VM size '$MERGE_VM_SIZE' is not allowed in your subscription."
            echo ""
            echo "   To fix this, set MERGE_VM_SIZE to an available VM size."
            echo "   Common DC series options (often available in restricted subscriptions):"
            echo "     - standard_dc2s_v3  (2 vCPU, 8 GB RAM)"
            echo "     - standard_dc4s_v3  (4 vCPU, 16 GB RAM)"
            echo "     - standard_dc8s_v3  (8 vCPU, 32 GB RAM)"
            echo ""
            echo "   Example:"
            echo "     export MERGE_VM_SIZE=standard_dc2s_v3"
            echo "     $0"
            echo ""
            echo "   Or check available sizes for your subscription:"
            echo "     az vm list-sizes --location $LOCATION --query '[].name' -o table"
            rm -f "$ERROR_LOG"
            exit 1
        # Check for insufficient quota error
        elif grep -q "ErrCode_InsufficientVCPUQuota\|Insufficient.*quota" "$ERROR_LOG"; then
            echo ""
            echo "   ✗ ERROR: Insufficient vCPU quota for VM size '$MERGE_VM_SIZE'."
            echo ""
            # Try to extract quota info from error
            if grep -q "left.*quota" "$ERROR_LOG"; then
                echo "   The error message indicates:"
                grep -o "left.*quota [0-9]*" "$ERROR_LOG" | head -1 | sed 's/^/     /'
            fi
            echo ""
            echo "   IMPORTANT: Check your VM family quota!"
            echo "   The VM size '$MERGE_VM_SIZE' is in the 'Standard DCSv3 Family'."
            echo "   If that family has a limit of 0, you cannot use any DCSv3 VMs."
            echo ""
            echo "   Check quota:"
            echo "     az vm list-usage --location $LOCATION --query \"[?contains(name.value, 'DCSv3')]\" -o table"
            echo ""
            echo "   Solutions:"
            echo "   1. Use a VM size from a family with available quota:"
            echo "      # Check which families have quota > 0:"
            echo "      az vm list-usage --location $LOCATION -o table | grep -E 'Family vCPUs|Total Regional'"
            echo ""
            echo "      # Common alternatives (if quota available):"
            echo "      export MERGE_VM_SIZE=Standard_DS2_v3   # DSv3 family (2 vCPU)"
            echo "      export MERGE_VM_SIZE=Standard_D2s_v3  # DSv3 family (2 vCPU)"
            echo "      export MERGE_VM_SIZE=Standard_DS1_v2   # DSv2 family (1 vCPU, if allowed)"
            echo "      export MERGE_MAX_COUNT=1"
            echo "      $0"
            echo ""
            echo "   2. Request quota increase for DCSv3 family:"
            echo "      https://learn.microsoft.com/en-us/azure/quotas/view-quotas"
            echo "      (Search for 'Standard DCSv3 Family vCPUs' in the portal)"
            echo ""
            echo "   3. Check current quota usage:"
            echo "      az vm list-usage --location $LOCATION -o table"
            echo ""
            echo "   Note: Surge nodes during upgrades also consume quota."
            echo "         Consider setting MAX_COUNT=1 to minimize surge node impact."
            rm -f "$ERROR_LOG"
            exit 1
        else
            echo "   ✗ Failed to create merge node pool"
            cat "$ERROR_LOG"
            rm -f "$ERROR_LOG"
            exit 1
        fi
    else
        echo "   ✓ Merge node pool created successfully"
        rm -f "$ERROR_LOG"
    fi
fi

# 2. Create search node pool
# Note: Node pool names must be alphanumeric only (no hyphens)
SEARCH_POOL_NAME="poolsearch"
echo ""
echo "-> Creating search node pool ($SEARCH_POOL_NAME)..."
echo "   VM Size: $SEARCH_VM_SIZE"
echo "   Min: $SEARCH_MIN_COUNT, Max: $SEARCH_MAX_COUNT"

# Check if pool already exists
if az aks nodepool show \
    --resource-group "$RESOURCE_GROUP" \
    --cluster-name "$CLUSTER_NAME" \
    --name "$SEARCH_POOL_NAME" >/dev/null 2>&1; then
    echo "   Node pool '$SEARCH_POOL_NAME' already exists. Skipping creation."
else
    ERROR_LOG=$(mktemp)
    if ! az aks nodepool add \
        --resource-group "$RESOURCE_GROUP" \
        --cluster-name "$CLUSTER_NAME" \
        --name "$SEARCH_POOL_NAME" \
        --node-count "$SEARCH_MIN_COUNT" \
        --node-vm-size "$SEARCH_VM_SIZE" \
        --mode User \
        --enable-cluster-autoscaler \
        --min-count "$SEARCH_MIN_COUNT" \
        --max-count "$SEARCH_MAX_COUNT" \
        --labels "node-pool=pool-search" \
        --node-taints "node-pool=pool-search:NoSchedule" \
        --os-type Linux \
        --os-sku Ubuntu > "$ERROR_LOG" 2>&1; then
        
        # Check for VM size not allowed error
        if grep -q "is not allowed in your subscription" "$ERROR_LOG"; then
            echo ""
            echo "   ✗ ERROR: VM size '$SEARCH_VM_SIZE' is not allowed in your subscription."
            echo ""
            echo "   To fix this, set SEARCH_VM_SIZE to an available VM size."
            echo "   Common DC series options (often available in restricted subscriptions):"
            echo "     - standard_dc2s_v3  (2 vCPU, 8 GB RAM)"
            echo "     - standard_dc4s_v3  (4 vCPU, 16 GB RAM)"
            echo "     - standard_dc8s_v3  (8 vCPU, 32 GB RAM)"
            echo ""
            echo "   Example:"
            echo "     export SEARCH_VM_SIZE=standard_dc2s_v3"
            echo "     $0"
            echo ""
            echo "   Or check available sizes for your subscription:"
            echo "     az vm list-sizes --location $LOCATION --query '[].name' -o table"
            rm -f "$ERROR_LOG"
            exit 1
        # Check for insufficient quota error
        elif grep -q "ErrCode_InsufficientVCPUQuota\|Insufficient.*quota" "$ERROR_LOG"; then
            echo ""
            echo "   ✗ ERROR: Insufficient vCPU quota for VM size '$SEARCH_VM_SIZE'."
            echo ""
            # Try to extract quota info from error
            if grep -q "left.*quota" "$ERROR_LOG"; then
                echo "   The error message indicates:"
                grep -o "left.*quota [0-9]*" "$ERROR_LOG" | head -1 | sed 's/^/     /'
            fi
            echo ""
            echo "   IMPORTANT: Check your VM family quota!"
            echo "   The VM size '$SEARCH_VM_SIZE' is in the 'Standard DCSv3 Family'."
            echo "   If that family has a limit of 0, you cannot use any DCSv3 VMs."
            echo ""
            echo "   Check quota:"
            echo "     az vm list-usage --location $LOCATION --query \"[?contains(name.value, 'DCSv3')]\" -o table"
            echo ""
            echo "   Solutions:"
            echo "   1. Use a VM size from a family with available quota:"
            echo "      # Check which families have quota > 0:"
            echo "      az vm list-usage --location $LOCATION -o table | grep -E 'Family vCPUs|Total Regional'"
            echo ""
            echo "      # Common alternatives (if quota available):"
            echo "      export SEARCH_VM_SIZE=Standard_DS2_v3   # DSv3 family (2 vCPU)"
            echo "      export SEARCH_VM_SIZE=Standard_D2s_v3  # DSv3 family (2 vCPU)"
            echo "      export SEARCH_VM_SIZE=Standard_DS1_v2   # DSv2 family (1 vCPU, if allowed)"
            echo "      export SEARCH_MAX_COUNT=1"
            echo "      $0"
            echo ""
            echo "   2. Request quota increase for DCSv3 family:"
            echo "      https://learn.microsoft.com/en-us/azure/quotas/view-quotas"
            echo "      (Search for 'Standard DCSv3 Family vCPUs' in the portal)"
            echo ""
            echo "   3. Check current quota usage:"
            echo "      az vm list-usage --location $LOCATION -o table"
            echo ""
            echo "   Note: Surge nodes during upgrades also consume quota."
            echo "         Consider setting MAX_COUNT=1 to minimize surge node impact."
            rm -f "$ERROR_LOG"
            exit 1
        else
            echo "   ✗ Failed to create search node pool"
            cat "$ERROR_LOG"
            rm -f "$ERROR_LOG"
            exit 1
        fi
    else
        echo "   ✓ Search node pool created successfully"
        rm -f "$ERROR_LOG"
    fi
fi

# 3. Verify node pools
echo ""
echo "-> Verifying node pools..."
echo ""
az aks nodepool list \
    --resource-group "$RESOURCE_GROUP" \
    --cluster-name "$CLUSTER_NAME" \
    --output table

echo ""
echo "========================================================"
echo "✅ Node Pool Setup Complete!"
echo "========================================================"
echo "Cluster: $CLUSTER_NAME"
echo "Resource Group: $RESOURCE_GROUP"
echo ""
echo "Node Pools Created:"
echo "  - $MERGE_POOL_NAME:  $MERGE_VM_SIZE (min: $MERGE_MIN_COUNT, max: $MERGE_MAX_COUNT)"
echo "  - $SEARCH_POOL_NAME: $SEARCH_VM_SIZE (min: $SEARCH_MIN_COUNT, max: $SEARCH_MAX_COUNT)"
echo ""
echo "Note: Node pools have taints to prevent general workloads:"
echo "  - $MERGE_POOL_NAME:  node-pool=pool-merge:NoSchedule"
echo "  - $SEARCH_POOL_NAME: node-pool=pool-search:NoSchedule"
echo ""
echo "Pods must have matching tolerations to schedule on these pools."
echo "========================================================"

