#!/bin/bash

# ==============================================================================
# Script Name: check_quota.sh
# Usage: ./check_quota.sh [location]
# Description: Checks Azure VM quota status, especially for DCSv3 family
# ==============================================================================

LOCATION="${1:-${LOCATION:-eastus}}"

echo "=== Azure VM Quota Status for Location: $LOCATION ==="
echo ""

# Check if Azure is logged in
if ! az account show >/dev/null 2>&1; then
    echo "Error: Not logged in to Azure. Please run 'az login' first."
    exit 1
fi

echo "Checking quota status..."
echo ""

# Get total regional quota
echo "📊 Total Regional vCPUs:"
TOTAL_REGIONAL=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Total Regional vCPUs'].{Current:currentValue, Limit:limit}" -o table 2>/dev/null)
if [ -n "$TOTAL_REGIONAL" ]; then
    echo "$TOTAL_REGIONAL"
else
    echo "  Unable to retrieve (may need to wait for quota update to propagate)"
fi
echo ""

# Get DCSv3 family quota specifically
echo "📊 Standard DCSv3 Family vCPUs (needed for standard_dc2s_v3, standard_dc4s_v3, etc.):"
DCSV3_QUOTA=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Standard DCSv3 Family vCPUs'].{Current:currentValue, Limit:limit}" -o table 2>/dev/null)
if [ -n "$DCSV3_QUOTA" ]; then
    echo "$DCSV3_QUOTA"
    
    # Check if limit is 0
    DCSV3_LIMIT=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Standard DCSv3 Family vCPUs'].limit" -o tsv 2>/dev/null)
    if [ "$DCSV3_LIMIT" = "0" ]; then
        echo ""
        echo "⚠️  WARNING: DCSv3 Family quota is still 0!"
        echo "   This means you cannot use any DCSv3 VM sizes (dc2s_v3, dc4s_v3, etc.)"
        echo ""
        echo "   If you just requested a quota increase:"
        echo "   1. Quota increases can take 15-30 minutes to propagate"
        echo "   2. You may need to request 'Standard DCSv3 Family vCPUs' separately"
        echo "      (not just 'Total Regional vCPUs')"
        echo "   3. Check your quota requests in Azure Portal:"
        echo "      https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/overview"
        echo ""
        echo "   Alternative: Use a VM family that already has quota:"
        echo "   - Standard DSv3 Family (for Standard_DS2_v3, Standard_DS1_v2, etc.)"
        echo "   - Standard Dv3 Family (for Standard_D2s_v3, etc.)"
    fi
else
    echo "  Unable to retrieve (may need to wait for quota update to propagate)"
fi
echo ""

# Show other families with available quota
echo "📊 Other VM Families with Available Quota:"
echo "(These can be used as alternatives)"
az vm list-usage --location "$LOCATION" --query "[?contains(name.value, 'Family vCPUs') && limit > 0 && currentValue < limit].{Family:name.value, Used:currentValue, Limit:limit}" -o table 2>/dev/null | head -20
echo ""

# Show recommended alternatives
echo "💡 Recommended Alternative VM Sizes (if DCSv3 quota is still 0):"
echo ""
echo "For 2 vCPU nodes (similar to standard_dc2s_v3):"
echo "  - Standard_DS2_v3  (2 vCPU, 7 GB RAM) - DSv3 family"
echo "  - Standard_D2s_v3 (2 vCPU, 8 GB RAM) - DSv3 family"
echo ""
echo "To use these alternatives:"
echo "  export MERGE_VM_SIZE=Standard_DS2_v3"
echo "  export SEARCH_VM_SIZE=Standard_DS2_v3"
echo "  ./setup_aks_nodepools.sh"
echo ""

echo "========================================================"
echo "To request DCSv3 quota increase:"
echo "1. Go to: https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/overview"
echo "2. Select your subscription and region: $LOCATION"
echo "3. Search for: 'Standard DCSv3 Family vCPUs'"
echo "4. Click 'Request quota increase'"
echo "5. Wait 15-30 minutes for propagation"
echo "========================================================"

