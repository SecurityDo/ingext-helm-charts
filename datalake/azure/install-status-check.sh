#!/bin/bash

###############################################################################
# Azure Datalake Installation Status Checker
#
# Displays the status of all required resources in a two-column format
# with color-coded status indicators
#
# Usage:
#   ./install-status-check.sh
#   source ./install-status-check.sh && check_datalake_status
###############################################################################

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Status symbols
CHECK_MARK="✓"
CROSS_MARK="✗"
WARNING_MARK="⚠"

check_datalake_status() {
    # Load environment variables if available
    if [ -f "./ingext-datalake-azure.env" ]; then
        source ./ingext-datalake-azure.env 2>/dev/null
    fi

    # Try to detect resource group and cluster from kubectl context if not set
    if [ -z "${RESOURCE_GROUP:-}" ] || [ -z "${CLUSTER_NAME:-}" ]; then
        # Try to extract from kubectl context
        CURRENT_CONTEXT=$(kubectl config current-context 2>/dev/null || echo "")
        if [ -n "$CURRENT_CONTEXT" ]; then
            if [ -z "${CLUSTER_NAME:-}" ]; then
                CLUSTER_NAME="$CURRENT_CONTEXT"
            fi
            # Try to get resource group from node labels
            # AKS node labels contain: kubernetes.azure.com/cluster=MC_resourcegroup_clustername_region
            CLUSTER_LABEL=$(kubectl get nodes -o jsonpath='{.items[0].metadata.labels.kubernetes\.azure\.com/cluster}' 2>/dev/null || echo "")
            if [ -n "$CLUSTER_LABEL" ]; then
                # Extract resource group from label: MC_resourcegroup_clustername_region
                # Format is MC_<resource-group>_<cluster-name>_<region>
                NODE_RG=$(echo "$CLUSTER_LABEL" | cut -d'_' -f2 2>/dev/null || echo "")
                if [ -n "$NODE_RG" ] && [ -z "${RESOURCE_GROUP:-}" ]; then
                    RESOURCE_GROUP="$NODE_RG"
                fi
            fi
        fi
    fi

    # Use defaults if not set
    RESOURCE_GROUP="${RESOURCE_GROUP:-ingext-rg}"
    CLUSTER_NAME="${CLUSTER_NAME:-ingext-lake}"
    LOCATION="${LOCATION:-eastus}"
    NAMESPACE="${NAMESPACE:-ingext}"
    STORAGE_ACCOUNT_NAME="${STORAGE_ACCOUNT_NAME:-}"
    CONTAINER_NAME="${CONTAINER_NAME:-datalake}"

    echo ""
    echo "=========================================================="
    echo "Azure Datalake Installation Status"
    echo "=========================================================="
    echo ""
    printf "%-40s %s\n" "Resource" "Status"
    echo "----------------------------------------------------------"

    # 1. Check AKS Cluster
    printf "%-40s " "AKS Cluster ($CLUSTER_NAME)"
    # First check if we can access the cluster via kubectl (more reliable)
    CLUSTER_ACCESSIBLE=false
    if kubectl cluster-info >/dev/null 2>&1; then
        CLUSTER_ACCESSIBLE=true
        NODE_COUNT=$(kubectl get nodes --no-headers 2>/dev/null | wc -l | tr -d ' ')
        READY_NODES=$(kubectl get nodes --no-headers 2>/dev/null | awk '$2=="Ready" {count++} END {print count+0}')
        
        # Try to get Azure details if Azure CLI is available
        if az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" >/dev/null 2>&1; then
            PROVISIONING_STATE=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --query "provisioningState" -o tsv 2>/dev/null || echo "Unknown")
            POWER_STATE=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --query "powerState.code" -o tsv 2>/dev/null || echo "Unknown")
            if [ "$PROVISIONING_STATE" = "Succeeded" ] && [ "$POWER_STATE" = "Running" ]; then
                printf "${GREEN}${CHECK_MARK} Running${NC} ($READY_NODES/$NODE_COUNT nodes ready, RG: $RESOURCE_GROUP)\n"
            else
                printf "${GREEN}${CHECK_MARK} Accessible${NC} ($READY_NODES/$NODE_COUNT nodes ready, State: $PROVISIONING_STATE)\n"
            fi
        else
            # Cluster is accessible via kubectl but Azure CLI check failed
            # This is fine - cluster is working
            printf "${GREEN}${CHECK_MARK} Running${NC} ($READY_NODES/$NODE_COUNT nodes ready, RG: unknown)\n"
        fi
    elif az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" >/dev/null 2>&1; then
        # Azure CLI shows cluster exists but kubectl can't access it
        PROVISIONING_STATE=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --query "provisioningState" -o tsv 2>/dev/null || echo "Unknown")
        POWER_STATE=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --query "powerState.code" -o tsv 2>/dev/null || echo "Unknown")
        printf "${YELLOW}${WARNING_MARK} Exists but not accessible${NC} (State: $PROVISIONING_STATE / $POWER_STATE)\n"
    else
        printf "${RED}${CROSS_MARK} Not Found${NC}\n"
    fi

    # 2. Check Kubernetes Namespace
    printf "%-40s " "Kubernetes Namespace ($NAMESPACE)"
    if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
        printf "${GREEN}${CHECK_MARK} Exists${NC}\n"
    else
        printf "${RED}${CROSS_MARK} Not Found${NC}\n"
    fi

    # 3. Check Blob Storage Account
    printf "%-40s " "Blob Storage Account"
    if [ -n "$STORAGE_ACCOUNT_NAME" ]; then
        if az storage account show --resource-group "$RESOURCE_GROUP" --name "$STORAGE_ACCOUNT_NAME" >/dev/null 2>&1; then
            printf "${GREEN}${CHECK_MARK} Exists ($STORAGE_ACCOUNT_NAME)${NC}\n"
        else
            printf "${RED}${CROSS_MARK} Not Found ($STORAGE_ACCOUNT_NAME)${NC}\n"
        fi
    else
        printf "${YELLOW}${WARNING_MARK} Not Configured${NC}\n"
    fi

    # 4. Check Storage Container
    printf "%-40s " "Storage Container ($CONTAINER_NAME)"
    if [ -n "$STORAGE_ACCOUNT_NAME" ]; then
        # Check if storage account exists first
        if az storage account show --resource-group "$RESOURCE_GROUP" --name "$STORAGE_ACCOUNT_NAME" >/dev/null 2>&1; then
            # Try to get storage key for container check (use background process with timeout to prevent hanging)
            # Check if timeout command exists, if not use a simpler approach
            if command -v timeout >/dev/null 2>&1; then
                STORAGE_KEY=$(timeout 3 az storage account keys list \
                    --resource-group "$RESOURCE_GROUP" \
                    --account-name "$STORAGE_ACCOUNT_NAME" \
                    --query "[0].value" -o tsv 2>/dev/null || echo "")
            else
                # Fallback: run in background and kill if takes too long
                STORAGE_KEY=$(az storage account keys list \
                    --resource-group "$RESOURCE_GROUP" \
                    --account-name "$STORAGE_ACCOUNT_NAME" \
                    --query "[0].value" -o tsv 2>/dev/null || echo "")
            fi
            
            if [ -n "$STORAGE_KEY" ]; then
                # Check container with key auth (faster, no interactive prompts)
                if command -v timeout >/dev/null 2>&1; then
                    CONTAINER_CHECK=$(timeout 3 az storage container show \
                        --account-name "$STORAGE_ACCOUNT_NAME" \
                        --account-key "$STORAGE_KEY" \
                        --name "$CONTAINER_NAME" \
                        --auth-mode key >/dev/null 2>&1 && echo "exists" || echo "notfound")
                else
                    # Without timeout, just try it (may hang, but less likely with key auth)
                    CONTAINER_CHECK=$(az storage container show \
                        --account-name "$STORAGE_ACCOUNT_NAME" \
                        --account-key "$STORAGE_KEY" \
                        --name "$CONTAINER_NAME" \
                        --auth-mode key >/dev/null 2>&1 && echo "exists" || echo "notfound")
                fi
                
                if [ "$CONTAINER_CHECK" = "exists" ]; then
                    printf "${GREEN}${CHECK_MARK} Exists${NC}\n"
                else
                    printf "${RED}${CROSS_MARK} Not Found${NC}\n"
                fi
            else
                # Skip container check if we can't get the key (prevents hanging)
                printf "${YELLOW}${WARNING_MARK} Cannot Verify (auth issue)${NC}\n"
            fi
        else
            printf "${YELLOW}${WARNING_MARK} N/A (storage account not found)${NC}\n"
        fi
    else
        printf "${YELLOW}${WARNING_MARK} N/A (no storage account)${NC}\n"
    fi

    # 5. Check Service Account
    printf "%-40s " "Service Account ($NAMESPACE-sa)"
    if kubectl get serviceaccount "${NAMESPACE}-sa" -n "$NAMESPACE" >/dev/null 2>&1; then
        # Check for workload identity annotation
        if kubectl get serviceaccount "${NAMESPACE}-sa" -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.azure\.workload\.identity/client-id}' >/dev/null 2>&1; then
            printf "${GREEN}${CHECK_MARK} Configured with Workload Identity${NC}\n"
        else
            printf "${YELLOW}${WARNING_MARK} Exists but not configured${NC}\n"
        fi
    else
        printf "${RED}${CROSS_MARK} Not Found${NC}\n"
    fi

    # 6. Check Managed Identity
    IDENTITY_NAME="ingext-${NAMESPACE}-sa-identity"
    printf "%-40s " "Managed Identity ($IDENTITY_NAME)"
    if az identity show --resource-group "$RESOURCE_GROUP" --name "$IDENTITY_NAME" >/dev/null 2>&1; then
        # Check role assignment
        CLIENT_ID=$(az identity show --resource-group "$RESOURCE_GROUP" --name "$IDENTITY_NAME" --query clientId -o tsv 2>/dev/null)
        if [ -n "$CLIENT_ID" ] && [ -n "$STORAGE_ACCOUNT_NAME" ]; then
            STORAGE_ACCOUNT_ID=$(az storage account show --resource-group "$RESOURCE_GROUP" --name "$STORAGE_ACCOUNT_NAME" --query id -o tsv 2>/dev/null)
            if [ -n "$STORAGE_ACCOUNT_ID" ]; then
                # Check for role assignment (use proper JMESPath query syntax)
                ROLE_ASSIGNED=$(az role assignment list \
                    --assignee "$CLIENT_ID" \
                    --scope "$STORAGE_ACCOUNT_ID" \
                    --query "[?roleDefinitionName=='Storage Blob Data Contributor'].{Name:name}" \
                    -o tsv 2>/dev/null || echo "")
                if [ -n "$ROLE_ASSIGNED" ]; then
                    printf "${GREEN}${CHECK_MARK} Exists with Storage Access${NC}\n"
                else
                    printf "${YELLOW}${WARNING_MARK} Exists but no role assignment${NC}\n"
                fi
            else
                printf "${GREEN}${CHECK_MARK} Exists${NC}\n"
            fi
        else
            printf "${GREEN}${CHECK_MARK} Exists${NC}\n"
        fi
    else
        printf "${RED}${CROSS_MARK} Not Found${NC}\n"
    fi

    # 7. Check Node Pool: poolmerge
    printf "%-40s " "Node Pool (poolmerge)"
    if az aks nodepool show --resource-group "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" --name poolmerge >/dev/null 2>&1; then
        POOL_STATE=$(az aks nodepool show --resource-group "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" --name poolmerge --query "provisioningState" -o tsv 2>/dev/null || echo "Unknown")
        if [ "$POOL_STATE" = "Succeeded" ]; then
            printf "${GREEN}${CHECK_MARK} Exists${NC}\n"
        else
            printf "${YELLOW}${WARNING_MARK} $POOL_STATE${NC}\n"
        fi
    else
        printf "${RED}${CROSS_MARK} Not Found${NC}\n"
    fi

    # 8. Check Node Pool: poolsearch
    printf "%-40s " "Node Pool (poolsearch)"
    if az aks nodepool show --resource-group "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" --name poolsearch >/dev/null 2>&1; then
        POOL_STATE=$(az aks nodepool show --resource-group "$RESOURCE_GROUP" --cluster-name "$CLUSTER_NAME" --name poolsearch --query "provisioningState" -o tsv 2>/dev/null || echo "Unknown")
        if [ "$POOL_STATE" = "Succeeded" ]; then
            printf "${GREEN}${CHECK_MARK} Exists${NC}\n"
        else
            printf "${YELLOW}${WARNING_MARK} $POOL_STATE${NC}\n"
        fi
    else
        printf "${RED}${CROSS_MARK} Not Found${NC}\n"
    fi

    # 9. Check Helm Release: ingext-lake-config
    printf "%-40s " "Helm: ingext-lake-config"
    if helm list -n "$NAMESPACE" --short 2>/dev/null | grep -q "ingext-lake-config"; then
        printf "${GREEN}${CHECK_MARK} Installed${NC}\n"
    else
        printf "${RED}${CROSS_MARK} Not Installed${NC}\n"
    fi

    # 10. Check Helm Release: ingext-manager-role
    printf "%-40s " "Helm: ingext-manager-role"
    if helm list -n "$NAMESPACE" --short 2>/dev/null | grep -q "ingext-manager-role"; then
        printf "${GREEN}${CHECK_MARK} Installed${NC}\n"
    else
        printf "${RED}${CROSS_MARK} Not Installed${NC}\n"
    fi

    # 11. Check Helm Release: ingext-s3-lake
    printf "%-40s " "Helm: ingext-s3-lake"
    if helm list -n "$NAMESPACE" --short 2>/dev/null | grep -q "ingext-s3-lake"; then
        printf "${GREEN}${CHECK_MARK} Installed${NC}\n"
    else
        printf "${RED}${CROSS_MARK} Not Installed${NC}\n"
    fi

    # 12. Check Helm Release: ingext-lake-mgr
    printf "%-40s " "Helm: ingext-lake-mgr"
    if helm list -n "$NAMESPACE" --short 2>/dev/null | grep -q "ingext-lake-mgr"; then
        printf "${GREEN}${CHECK_MARK} Installed${NC}\n"
    else
        printf "${RED}${CROSS_MARK} Not Installed${NC}\n"
    fi

    # 13. Check Helm Release: ingext-lake-worker
    printf "%-40s " "Helm: ingext-lake-worker"
    if helm list -n "$NAMESPACE" --short 2>/dev/null | grep -q "ingext-lake-worker"; then
        printf "${GREEN}${CHECK_MARK} Installed${NC}\n"
    else
        printf "${RED}${CROSS_MARK} Not Installed${NC}\n"
    fi

    # 14. Check Helm Release: ingext-search-service
    printf "%-40s " "Helm: ingext-search-service"
    if helm list -n "$NAMESPACE" --short 2>/dev/null | grep -q "ingext-search-service"; then
        printf "${GREEN}${CHECK_MARK} Installed${NC}\n"
    else
        printf "${RED}${CROSS_MARK} Not Installed${NC}\n"
    fi

    # 15. Check Datalake Pods
    printf "%-40s " "Datalake Pods (Running)"
    # Use a safer method to count pods (avoid grep with special chars)
    POD_OUTPUT=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null || echo "")
    if [ -n "$POD_OUTPUT" ]; then
        POD_COUNT=$(echo "$POD_OUTPUT" | wc -l | tr -d ' ')
        RUNNING_PODS=$(echo "$POD_OUTPUT" | awk '$3=="Running" {count++} END {print count+0}')
        if [ "$POD_COUNT" -gt 0 ]; then
            if [ "$RUNNING_PODS" -eq "$POD_COUNT" ]; then
                printf "${GREEN}${CHECK_MARK} $RUNNING_PODS/$POD_COUNT Running${NC}\n"
            else
                printf "${YELLOW}${WARNING_MARK} $RUNNING_PODS/$POD_COUNT Running${NC}\n"
            fi
        else
            printf "${RED}${CROSS_MARK} No Pods Found${NC}\n"
        fi
    else
        printf "${RED}${CROSS_MARK} No Pods Found${NC}\n"
    fi

    echo "----------------------------------------------------------"
    echo ""
    
    # Summary
    TOTAL_CHECKS=15
    # Count statuses (rough estimate - could be improved)
    GREEN_COUNT=$(printf "%-40s %s\n" "Resource" "Status" | grep -c "${GREEN}${CHECK_MARK}" || echo "0")
    
    echo "Legend:"
    printf "  ${GREEN}${CHECK_MARK} Green${NC} = Complete/Healthy\n"
    printf "  ${YELLOW}${WARNING_MARK} Yellow${NC} = Partial/Needs Attention\n"
    printf "  ${RED}${CROSS_MARK} Red${NC} = Missing/Not Found\n"
    echo ""
}

# If script is run directly (not sourced), execute the function
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    check_datalake_status
fi

