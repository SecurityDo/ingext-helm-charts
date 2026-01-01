#!/bin/bash

# ==============================================================================
# Script Name: check-and-cleanup.sh
# Usage: ./check-and-cleanup.sh
# Description: Checks what's still running and helps delete it
# ==============================================================================

LOCATION="${LOCATION:-eastus}"

echo "=========================================================="
echo "🔍 Checking Remaining Resources"
echo "=========================================================="
echo ""

# Check resource groups
echo "Resource Groups:"
az group list --query "[?contains(name, 'ingext')].{Name:name, Location:location, State:properties.provisioningState}" -o table 2>/dev/null || echo "  None found"
echo ""

# Check AKS clusters
echo "AKS Clusters:"
az aks list --query "[].{Name:name, RG:resourceGroup, State:powerState.code, Provisioning:provisioningState}" -o table 2>/dev/null || echo "  None found"
echo ""

# Check managed resource groups
echo "Managed Resource Groups (MC_*):"
az group list --query "[?starts_with(name, 'MC_')].{Name:name, Location:location, State:properties.provisioningState}" -o table 2>/dev/null || echo "  None found"
echo ""

# Check quota
echo "Current Quota Usage:"
az vm list-usage --location "$LOCATION" --query "[?name.value=='Total Regional vCPUs' || name.value=='Standard DCSv3 Family vCPUs'].{Name:name.value, Used:currentValue, Limit:limit}" -o table 2>/dev/null
echo ""

# Check for VMs
echo "Virtual Machines:"
az vm list --query "[?contains(resourceGroup, 'ingext')].{Name:name, RG:resourceGroup, State:powerState}" -o table 2>/dev/null || echo "  None found"
echo ""

# Check VM scale sets
echo "VM Scale Sets:"
az vmss list --query "[?contains(resourceGroup, 'ingext')].{Name:name, RG:resourceGroup}" -o table 2>/dev/null || echo "  None found"
echo ""

echo "=========================================================="
echo "If resources are still showing, they may be:"
echo "  1. Still deleting (can take 10-30 minutes)"
echo "  2. Stuck in 'Deleting' state"
echo ""
echo "To force delete stuck resources:"
echo "  ./force-cleanup.sh"
echo ""
echo "Or manually delete resource groups:"
echo "  az group delete --name <resource-group-name> --yes --no-wait"
echo "=========================================================="

