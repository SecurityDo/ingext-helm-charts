#!/bin/bash

# Exit immediately if a command exits with a non-zero status
set -e

# Use environment variables if set, otherwise use command-line arguments
# Command-line arguments override environment variables
RESOURCE_GROUP="${1:-${RESOURCE_GROUP}}"
LOCATION="${2:-${LOCATION}}"
CLUSTER_NAME="${3:-${CLUSTER_NAME}}"
NODE_COUNT="${4:-${NODE_COUNT}}"

# Check if required variables are set
if [ -z "$RESOURCE_GROUP" ] || [ -z "$LOCATION" ] || [ -z "$CLUSTER_NAME" ] || [ -z "$NODE_COUNT" ]; then
    echo "Usage: $0 [resourceGroup] [location] [clusterName] [nodeCount]"
    echo ""
    echo "Arguments are optional if environment variables are set:"
    echo "  RESOURCE_GROUP, LOCATION, CLUSTER_NAME, NODE_COUNT"
    echo ""
    echo "Examples:"
    echo "  # Using environment variables (from preflight):"
    echo "  source ./ingext-datalake-azure.env"
    echo "  $0"
    echo ""
    echo "  # Using command-line arguments:"
    echo "  $0 ingext-rg eastus ingext-lake 3"
    echo ""
    echo "  # Mixing (env vars + overrides):"
    echo "  source ./ingext-datalake-azure.env"
    echo "  $0 ingext-rg eastus  # overrides RESOURCE_GROUP and LOCATION"
    exit 1
fi

# Export variables
export RESOURCE_GROUP
export LOCATION
export CLUSTER_NAME
export NODE_COUNT="${NODE_COUNT:-1}"
# Default to Standard_D2s_v3 (Dv3 family) which is commonly available
export NODE_VM_SIZE="${NODE_VM_SIZE:-Standard_D2s_v3}"
export APPGW_NAME="${APPGW_NAME:-ingext-agw}"
export APPGW_SUBNET_CIDR="${APPGW_SUBNET_CIDR:-10.225.0.0/16}"

echo "--- Starting AKS Setup ---"
echo "Resource Group: $RESOURCE_GROUP"
echo "Location:       $LOCATION"
echo "Cluster:       $CLUSTER_NAME"
echo "Node Count:    $NODE_COUNT"
echo "Node VM Size:  $NODE_VM_SIZE"
echo "--------------------------"
echo ""

# Proactive quota check: If using DCSv3 family and quota is 0, warn and suggest alternative
if echo "$NODE_VM_SIZE" | grep -qi "dc.*v3"; then
    DCSV3_QUOTA=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Standard DCSv3 Family vCPUs'].limit" -o tsv 2>/dev/null || echo "0")
    if [ "$DCSV3_QUOTA" = "0" ] || [ -z "$DCSV3_QUOTA" ]; then
        echo "⚠️  WARNING: DCSv3 Family quota is 0!"
        echo "   VM size '$NODE_VM_SIZE' is in the DCSv3 family which has no quota."
        echo ""
        echo "   Checking for alternatives..."
        
        # Check DSv3 family
        DSV3_QUOTA=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Standard DSv3 Family vCPUs'].limit" -o tsv 2>/dev/null || echo "0")
        DSV3_USED=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Standard DSv3 Family vCPUs'].currentValue" -o tsv 2>/dev/null || echo "0")
        
        if [ "$DSV3_QUOTA" != "0" ] && [ -n "$DSV3_QUOTA" ]; then
            DSV3_AVAILABLE=$((DSV3_QUOTA - DSV3_USED))
            if [ "$DSV3_AVAILABLE" -ge 2 ]; then
                echo "   ✅ Found alternative: Standard_DS2_v3 (DSv3 family, $DSV3_AVAILABLE vCPUs available)"
                echo ""
                echo "   To use this instead, run:"
                echo "      export NODE_VM_SIZE=Standard_DS2_v3"
                echo "      ./aks_setup.sh"
                echo ""
                read -rp "   Continue anyway with $NODE_VM_SIZE? (will fail) (yes/no): " CONTINUE
                if [[ ! "${CONTINUE,,}" =~ ^yes$ ]]; then
                    echo "   Cancelled. Please update NODE_VM_SIZE and try again."
                    exit 1
                fi
                echo ""
            fi
        fi
    fi
fi
echo ""

# Warn if node count is high (may cause quota issues)
if [ "$NODE_COUNT" -gt 1 ]; then
    echo ""
    echo "⚠️  WARNING: NODE_COUNT is set to $NODE_COUNT"
    echo "   This will require ${NODE_COUNT}x the vCPU quota."
    echo "   If you encounter quota errors, try: NODE_COUNT=1 ./aks_setup.sh"
    echo ""
fi

# 2. Check Azure Login
echo "Checking Azure login..."
if ! az account show >/dev/null 2>&1; then
    echo "Please login to Azure..."
    az login
fi

# Get current subscription
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
echo "Subscription:  $SUBSCRIPTION_ID"

# 3. Create Resource Group
echo "Creating resource group..."
az group create \
    --name "$RESOURCE_GROUP" \
    --location "$LOCATION" >/dev/null 2>&1 || {
    echo "Resource group may already exist, continuing..."
}

# 4. Check if cluster already exists
echo "Checking if AKS cluster already exists..."
CLUSTER_EXISTS=false
if az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" >/dev/null 2>&1; then
    CLUSTER_EXISTS=true
    echo "-> Cluster '$CLUSTER_NAME' already exists"
    
    # Check cluster health
    PROVISIONING_STATE=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --query "provisioningState" -o tsv 2>/dev/null || echo "Unknown")
    POWER_STATE=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --query "powerState.code" -o tsv 2>/dev/null || echo "Unknown")
    
    echo "-> Provisioning State: $PROVISIONING_STATE"
    echo "-> Power State: $POWER_STATE"
    
    if [ "$PROVISIONING_STATE" = "Succeeded" ] && [ "$POWER_STATE" = "Running" ]; then
        echo "-> Cluster is healthy and running"
        echo "-> Skipping cluster creation, will update kubeconfig"
        SKIP_CREATE=true
    else
        echo "-> WARNING: Cluster exists but may not be in a healthy state"
        echo "-> Provisioning State: $PROVISIONING_STATE, Power State: $POWER_STATE"
        echo "-> Attempting to continue with kubeconfig update..."
        SKIP_CREATE=true
    fi
else
    echo "-> Cluster does not exist, will create new cluster"
    SKIP_CREATE=false
fi

# 5. Create AKS Cluster with Application Gateway (if needed)
if [ "$SKIP_CREATE" = false ]; then
    echo "Creating AKS cluster (this may take 10-15 minutes)..."

# Check if we can actually write SSH keys (test write, not just permissions)
SSH_KEY_FLAG=""
CAN_WRITE_SSH=false

# First check if SSH keys already exist
if [ -f "$HOME/.ssh/id_rsa" ] && [ -f "$HOME/.ssh/id_rsa.pub" ]; then
    echo "-> Using existing SSH keys"
    CAN_WRITE_SSH=true
else
    # Try to actually write a test file to verify we can write
    # Use echo with redirection to catch read-only filesystem errors
    TEST_FILE="$HOME/.ssh/.aks_setup_test_$$"
    if (mkdir -p "$HOME/.ssh" 2>/dev/null && echo "test" > "$TEST_FILE" 2>/dev/null && rm -f "$TEST_FILE" 2>/dev/null); then
        CAN_WRITE_SSH=true
        SSH_KEY_FLAG="--generate-ssh-keys"
        echo "-> Will generate SSH keys"
    else
        echo "-> Skipping SSH key generation (read-only filesystem detected)"
        echo "   Note: SSH keys are optional for AKS cluster operation"
        CAN_WRITE_SSH=false
    fi
fi

# Build the AKS create command as an array (safer than string with eval)
# Note: --enable-azure-rbac requires --enable-aad, so we'll use managed identity RBAC instead
AKS_CREATE_ARGS=(
    aks create
    --resource-group "$RESOURCE_GROUP"
    --name "$CLUSTER_NAME"
    --location "$LOCATION"
    --node-count "$NODE_COUNT"
    --node-vm-size "$NODE_VM_SIZE"
    --network-plugin azure
    --enable-addons ingress-appgw
    --appgw-name "$APPGW_NAME"
    --appgw-subnet-cidr "$APPGW_SUBNET_CIDR"
    --enable-managed-identity
)

# Add SSH key flag only if we can actually generate keys
if [ "$CAN_WRITE_SSH" = true ] && [ -n "$SSH_KEY_FLAG" ]; then
    AKS_CREATE_ARGS+=("$SSH_KEY_FLAG")
fi

# Execute the command
# Suppress the harmless docker_bridge_cidr warning (deprecated parameter, ignored by Azure)
# This warning appears when using --network-plugin azure but doesn't affect functionality
TMP_OUTPUT=$(mktemp)
az "${AKS_CREATE_ARGS[@]}" 2>&1 | grep -v "docker_bridge_cidr is not a known attribute" | tee "$TMP_OUTPUT"
EXIT_CODE=${PIPESTATUS[0]}  # Get exit code of 'az' command, not grep

if [ $EXIT_CODE -ne 0 ]; then
    # Check for specific error types and provide helpful guidance
    ERROR_OUTPUT=$(cat "$TMP_OUTPUT")
    rm -f "$TMP_OUTPUT"
    
    if echo "$ERROR_OUTPUT" | grep -q "InsufficientVCPUQuota\|Insufficient.*quota"; then
        echo ""
        echo "=========================================================="
        echo "❌ Quota Error: Insufficient vCPU quota in region"
        echo "=========================================================="
        echo ""
        echo "The Azure subscription does not have enough vCPU quota in '$LOCATION'"
        echo "to create the AKS cluster with $NODE_COUNT node(s) of size $NODE_VM_SIZE."
        echo ""
        # Extract VM family from VM size name for accurate quota request
        VM_FAMILY=""
        if echo "$NODE_VM_SIZE" | grep -q "dc.*v3"; then
            VM_FAMILY="Standard DCSv3 Family vCPUs"
        elif echo "$NODE_VM_SIZE" | grep -q "ds.*v3"; then
            VM_FAMILY="Standard DSv3 Family vCPUs"
        elif echo "$NODE_VM_SIZE" | grep -q "dc.*v2"; then
            VM_FAMILY="Standard DCSv2 Family vCPUs"
        elif echo "$NODE_VM_SIZE" | grep -q "ds.*v2"; then
            VM_FAMILY="Standard DSv2 Family vCPUs"
        else
            VM_FAMILY="Standard DCSv3 Family vCPUs (or check quota table below)"
        fi
        
        echo "Options to resolve this:"
        echo ""
        echo "1. Check current quota usage and identify what's using quota:"
        echo "   az vm list-usage --location $LOCATION -o table"
        echo ""
        echo "2. Delete unused resources to free up quota:"
        echo "   # List all VMs (filter by location manually):"
        echo "   az vm list --query \"[].{Name:name, ResourceGroup:resourceGroup, Location:location, Size:hardwareProfile.vmSize}\" -o table"
        echo ""
        echo "   # List all AKS clusters:"
        echo "   az aks list --query \"[].{Name:name, ResourceGroup:resourceGroup, Location:location}\" -o table"
        echo ""
        echo "   # List resources by resource group (to find what's in your region):"
        echo "   az group list --query \"[?location=='$LOCATION'].{Name:name, Location:location}\" -o table"
        echo ""
        echo "   # Delete unused resources (replace with actual names):"
        echo "   az vm delete --resource-group <rg-name> --name <vm-name> --yes"
        echo "   az aks delete --resource-group <rg-name> --name <cluster-name> --yes"
        echo ""
        echo "3. Request quota increase:"
        echo "   - Visit: https://portal.azure.com/#view/Microsoft_Azure_Capacity/QuotaMenuBlade/~/overview"
        echo "   - Select your subscription and region '$LOCATION'"
        echo "   - Request increase for: $VM_FAMILY"
        echo "   - Also check 'Total Regional vCPUs' quota"
        echo ""
        echo "4. Use a different region with available quota:"
        echo "   - Try: westus2, centralus, westcentralus, or other regions"
        echo "   - Update LOCATION in your environment file and retry"
        echo "   - Example: LOCATION=westus2 ./aks_setup.sh"
        echo ""
        if [ "$NODE_COUNT" -gt 1 ]; then
            echo "5. Reduce node count (currently: $NODE_COUNT):"
            echo "   - AKS may reserve additional capacity for surge nodes"
            echo "   - Try: NODE_COUNT=1 ./aks_setup.sh"
            echo ""
        else
            echo "5. Note: NODE_COUNT is already 1 (minimum for AKS)"
            echo "   - You cannot reduce further without quota increase or deleting resources"
            echo ""
        fi
        
        echo "6. VM Size Constraints:"
        echo "   - AKS requires minimum 2 vCPU and 4 GB RAM for system node pools"
        echo "   - Current size '$NODE_VM_SIZE' failed due to quota"
        echo ""
        echo "   Checking available 2 vCPU VM sizes in your subscription..."
        echo ""
        
        # Check DCSv3 family quota first
        DCSV3_QUOTA=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Standard DCSv3 Family vCPUs'].limit" -o tsv 2>/dev/null || echo "0")
        DCSV3_USED=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Standard DCSv3 Family vCPUs'].currentValue" -o tsv 2>/dev/null || echo "0")
        
        if [ "$DCSV3_QUOTA" = "0" ] || [ -z "$DCSV3_QUOTA" ]; then
            echo "   ⚠️  DCSv3 Family quota is 0 - cannot use standard_dc2s_v3 or any DCSv3 VMs"
            echo ""
            echo "   Checking other VM families with available quota..."
            
            # Check DSv3 family (most common alternative)
            DSV3_QUOTA=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Standard DSv3 Family vCPUs'].limit" -o tsv 2>/dev/null || echo "0")
            DSV3_USED=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Standard DSv3 Family vCPUs'].currentValue" -o tsv 2>/dev/null || echo "0")
            
            if [ "$DSV3_QUOTA" != "0" ] && [ -n "$DSV3_QUOTA" ]; then
                DSV3_AVAILABLE=$((DSV3_QUOTA - DSV3_USED))
                if [ "$DSV3_AVAILABLE" -ge 2 ]; then
                    echo "   ✅ Standard DSv3 Family has quota available: $DSV3_AVAILABLE vCPUs"
                    echo "      Recommended: Standard_DS2_v3 (2 vCPU, 7 GB RAM)"
                    echo ""
                    echo "   To use this, set:"
                    echo "      export NODE_VM_SIZE=Standard_DS2_v3"
                    echo "      ./aks_setup.sh"
                fi
            fi
            
            # Check Dv3 family
            DV3_QUOTA=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Standard Dv3 Family vCPUs'].limit" -o tsv 2>/dev/null || echo "0")
            DV3_USED=$(az vm list-usage --location "$LOCATION" --query "[?name.value=='Standard Dv3 Family vCPUs'].currentValue" -o tsv 2>/dev/null || echo "0")
            
            if [ "$DV3_QUOTA" != "0" ] && [ -n "$DV3_QUOTA" ]; then
                DV3_AVAILABLE=$((DV3_QUOTA - DV3_USED))
                if [ "$DV3_AVAILABLE" -ge 2 ]; then
                    echo "   ✅ Standard Dv3 Family has quota available: $DV3_AVAILABLE vCPUs"
                    echo "      Alternative: Standard_D2s_v3 (2 vCPU, 8 GB RAM)"
                fi
            fi
            
            echo ""
            echo "   All VM families with available quota:"
            az vm list-usage --location "$LOCATION" --query "[?contains(name.value, 'Family vCPUs') && limit > 0 && (limit - currentValue) >= 2].{Family:name.value, Used:currentValue, Limit:limit, Available:limit - currentValue}" -o table 2>/dev/null | head -10 || echo "     (checking...)"
        else
            # DCSv3 has quota, but might be exhausted
            echo "   DCSv3 Family quota: $DCSV3_USED/$DCSV3_QUOTA used"
            if [ "$DCSV3_QUOTA" -le "$DCSV3_USED" ]; then
                echo "   ⚠️  DCSv3 Family quota exhausted"
            fi
        fi
        
        echo ""
        echo "   To query all available 2 vCPU sizes manually:"
        echo "      az vm list-sizes --location $LOCATION --output table | grep -i '2.*cpu\|ds2\|d2s'"
        echo ""
        echo "Current request:"
        echo "  Region: $LOCATION"
        echo "  Nodes: $NODE_COUNT"
        echo "  VM Size: $NODE_VM_SIZE"
        echo "  Required vCPUs: $((NODE_COUNT * 2)) (estimated, may be higher due to surge nodes)"
        echo ""
        echo "After resolving the quota issue, re-run:"
        echo "  ./aks_setup.sh"
        echo "=========================================================="
        exit 1
    elif echo "$ERROR_OUTPUT" | grep -q "is not allowed\|not allowed in your subscription"; then
        echo ""
        echo "=========================================================="
        echo "❌ VM Size Error: VM size not allowed for AKS"
        echo "=========================================================="
        echo ""
        echo "The VM size '$NODE_VM_SIZE' is not allowed for AKS clusters"
        echo "in your subscription in region '$LOCATION'."
        echo ""
        echo "The error message above lists all available VM sizes for AKS."
        echo ""
        echo "Options to resolve this:"
        echo ""
        echo "1. Use an allowed VM size. Checking what's available in your subscription..."
        echo ""
        
        # Query available VM sizes from the error message or by querying
        echo "   Available 2 vCPU VM sizes (AKS-compatible, >= 4GB RAM):"
        AVAILABLE_2CPU=$(az vm list-sizes --location "$LOCATION" --query "[?numberOfCores == \`2\` && memoryInMb >= \`4096\`].name" -o tsv 2>/dev/null | head -10)
        
        if [ -n "$AVAILABLE_2CPU" ]; then
            echo "$AVAILABLE_2CPU" | while read -r size; do
                if [ -n "$size" ]; then
                    MEMORY=$(az vm list-sizes --location "$LOCATION" --query "[?name=='$size'].memoryInMb" -o tsv 2>/dev/null || echo "?")
                    echo "     - $size  (2 vCPU, ${MEMORY} MB RAM)"
                fi
            done
            echo ""
            echo "   Example: NODE_VM_SIZE=Standard_DS2_v3 ./aks_setup.sh"
        else
            echo "     (Querying available sizes...)"
            az vm list-sizes --location "$LOCATION" --query "[?numberOfCores == \`2\` && memoryInMb >= \`4096\`].{Name:name, Memory:memoryInMb}" -o table 2>/dev/null | head -10
        fi
        echo ""
        echo "3. Request access to additional VM sizes:"
        echo "   - Contact your Azure subscription administrator"
        echo "   - Some VM families may require special approval"
        echo ""
        echo "Current request:"
        echo "  Region: $LOCATION"
        echo "  VM Size: $NODE_VM_SIZE (NOT ALLOWED)"
        echo ""
        echo "After selecting an allowed VM size, re-run:"
        echo "  NODE_VM_SIZE=<allowed-size> ./aks_setup.sh"
        echo "=========================================================="
        exit 1
    elif echo "$ERROR_OUTPUT" | grep -q "already exists"; then
        echo ""
        echo "Note: Cluster may already exist. The script will check and handle this."
        echo "If the cluster exists, it will be verified instead of created."
        exit 1
    else
        echo ""
        echo "Error: Failed to create AKS cluster"
        echo ""
        echo "Error details:"
        echo "$ERROR_OUTPUT"
        echo ""
        echo "Common issues:"
        echo "  - Insufficient permissions (need Contributor or Owner role)"
        echo "  - Quota limits exceeded"
        echo "  - Invalid VM size for the region"
        echo "  - Network configuration issues"
        echo ""
        echo "Check Azure portal or run: az aks show --resource-group $RESOURCE_GROUP --name $CLUSTER_NAME"
        exit 1
    fi
fi
rm -f "$TMP_OUTPUT"
else
    echo "-> Skipping cluster creation (cluster already exists and is healthy)"
fi

# 6. Update Kubeconfig
echo "Updating kubeconfig..."
az aks get-credentials \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER_NAME" \
    --overwrite-existing

# 7. Verify Cluster Access
echo "Verifying cluster access..."
if kubectl cluster-info >/dev/null 2>&1; then
    echo "-> Cluster is accessible via kubectl"
    
    # Check node status
    NODE_COUNT=$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')
    READY_NODES=$(kubectl get nodes --no-headers 2>/dev/null | grep -c " Ready " || echo "0")
    
    echo "-> Nodes: $READY_NODES/$NODE_COUNT ready"
    
    if [ "$READY_NODES" -gt 0 ]; then
        echo "-> Cluster is operational"
    else
        echo "-> WARNING: No ready nodes found"
    fi
else
    echo "-> WARNING: Could not verify cluster access"
fi

echo ""
echo "========================================================"
if [ "$CLUSTER_EXISTS" = true ]; then
    echo "✅ AKS Cluster Verified!"
    echo "Cluster: $CLUSTER_NAME (already existed)"
else
    echo "✅ AKS Setup Complete!"
    echo "Cluster: $CLUSTER_NAME (newly created)"
fi
echo "Resource Group: $RESOURCE_GROUP"
echo "Location: $LOCATION"
echo "========================================================"
echo ""

# 8. Optionally proceed with next steps if environment variables are set
if [ -n "${STORAGE_ACCOUNT_NAME:-}" ] && [ -n "${CONTAINER_NAME:-}" ] && [ -n "${EXPIRE_DAYS:-}" ] && [ -n "${NAMESPACE:-}" ]; then
    echo "Detected environment variables for next steps. Proceeding with automated setup..."
    echo ""
    
    # Check if scripts exist
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    
    # 8a. Create blob storage
    if [ -f "$SCRIPT_DIR/create_blob_storage.sh" ]; then
        echo "========================================================"
        echo "Step 1: Creating Blob Storage"
        echo "========================================================"
        "$SCRIPT_DIR/create_blob_storage.sh" || {
            echo "WARNING: Blob storage creation failed or already exists"
        }
        echo ""
    fi
    
    # 8b. Setup service account
    if [ -f "$SCRIPT_DIR/setup_ingext_serviceaccount.sh" ]; then
        echo "========================================================"
        echo "Step 2: Setting up Service Account"
        echo "========================================================"
        "$SCRIPT_DIR/setup_ingext_serviceaccount.sh" || {
            echo "WARNING: Service account setup failed"
        }
        echo ""
    fi
    
    # 8c. Setup node pools
    if [ -f "$SCRIPT_DIR/setup_aks_nodepools.sh" ]; then
        echo "========================================================"
        echo "Step 3: Setting up Node Pools"
        echo "========================================================"
        "$SCRIPT_DIR/setup_aks_nodepools.sh" || {
            echo "WARNING: Node pool setup failed or pools already exist"
        }
        echo ""
    fi
    
    echo "========================================================"
    echo "✅ Automated Setup Complete!"
    echo "========================================================"
    echo ""
    echo "Next steps: Follow azure_install.md for datalake component installation"
else
    echo "Next steps (run manually or set environment variables to auto-run):"
    echo "  1. Create blob storage:"
    echo "     ./create_blob_storage.sh"
    echo ""
    echo "  2. Setup service account:"
    echo "     ./setup_ingext_serviceaccount.sh"
    echo ""
    echo "  3. Setup node pools:"
    echo "     ./setup_aks_nodepools.sh"
    echo ""
    echo "  Or source environment file and re-run this script:"
    echo "     source ./ingext-datalake-azure.env"
    echo "     ./aks_setup.sh"
fi

