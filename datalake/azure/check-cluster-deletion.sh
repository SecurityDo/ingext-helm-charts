#!/bin/bash

# ==============================================================================
# Script Name: check-cluster-deletion.sh
# Usage: ./check-cluster-deletion.sh [resourceGroup] [clusterName]
# Description: Checks AKS cluster deletion status and can abort if needed
# ==============================================================================

RESOURCE_GROUP="${1:-${RESOURCE_GROUP:-ingext-datalake-rg}}"
CLUSTER_NAME="${2:-${CLUSTER_NAME:-ingext-lake}}"

echo "=========================================================="
echo "🔍 Checking AKS Cluster Deletion Status"
echo "=========================================================="
echo "Resource Group: $RESOURCE_GROUP"
echo "Cluster Name:   $CLUSTER_NAME"
echo ""

# Check if cluster exists
if ! az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" >/dev/null 2>&1; then
    echo "✅ Cluster '$CLUSTER_NAME' does not exist (deletion may have completed)"
    echo ""
    echo "Checking for any remaining clusters..."
    az aks list --query "[].{Name:name, RG:resourceGroup, State:powerState.code, Provisioning:provisioningState}" -o table 2>/dev/null || echo "  No clusters found"
    exit 0
fi

# Get cluster status
echo "Cluster Status:"
CLUSTER_STATE=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --query "{PowerState:powerState.code, ProvisioningState:provisioningState}" -o json 2>/dev/null)
echo "$CLUSTER_STATE" | jq '.' 2>/dev/null || echo "$CLUSTER_STATE"
echo ""

# Check for ongoing operations
echo "Checking for ongoing operations..."
OPERATIONS=$(az aks operation list --resource-group "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" --query "[?status=='InProgress'].{OperationID:id, OperationType:operation, StartTime:startTime}" -o table 2>/dev/null)

if [ -n "$OPERATIONS" ] && [ "$OPERATIONS" != "OperationID    OperationType    StartTime" ]; then
    echo "⚠️  Found ongoing operations:"
    echo "$OPERATIONS"
    echo ""
    
    # Extract operation IDs
    OPERATION_IDS=$(az aks operation list --resource-group "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" --query "[?status=='InProgress'].id" -o tsv 2>/dev/null)
    
    if [ -n "$OPERATION_IDS" ]; then
        echo "Options:"
        echo "  1. Wait for deletion to complete (can take 10-30 minutes)"
        echo "  2. Abort the deletion operation"
        echo ""
        read -rp "Abort the deletion operation? (yes/no): " ABORT
        
        if [[ "${ABORT,,}" =~ ^yes$ ]]; then
            echo ""
            echo "Aborting operations..."
            for op_id in $OPERATION_IDS; do
                if [ -n "$op_id" ]; then
                    echo "  -> Aborting operation: $op_id"
                    az aks operation-abort --resource-group "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" --operation-id "$op_id" 2>/dev/null || {
                        echo "    ⚠️  Could not abort (may need to use full operation ID)"
                    }
                fi
            done
            echo ""
            echo "After aborting, you can delete the cluster again:"
            echo "  az aks delete --resource-group $RESOURCE_GROUP --name $CLUSTER_NAME --yes"
        fi
    fi
else
    echo "  No ongoing operations found"
fi

echo ""
echo "=========================================================="
echo "To manually abort a specific operation:"
echo "  az aks operation-abort --resource-group $RESOURCE_GROUP --cluster-name $CLUSTER_NAME --operation-id <operation-id>"
echo ""
echo "To delete the cluster again:"
echo "  az aks delete --resource-group $RESOURCE_GROUP --name $CLUSTER_NAME --yes"
echo "=========================================================="

