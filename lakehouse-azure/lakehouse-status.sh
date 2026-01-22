#!/usr/bin/env bash

set -uo pipefail

###############################################################################
# Azure Lakehouse Status Checker
#
# Shows the status of all installed components in a clean two-column format.
###############################################################################

# -------- 1. Load Environment --------
if [[ ! -f "./lakehouse-azure.env" ]]; then
  echo "ERROR: lakehouse-azure.env not found. Run ./preflight-lakehouse.sh first."
  exit 1
fi

source ./lakehouse-azure.env

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Column formatting
FORMAT="%-40s %-20b\n"

echo ""
echo "==================== Lakehouse Status: $CLUSTER_NAME ===================="
printf "$FORMAT" "COMPONENT" "STATUS"
echo "------------------------------------------------------------------------"

# 1. Infrastructure Status
get_az_status() {
  local status="$1"
  if [[ "$status" == "Succeeded" ]] || [[ "$status" == "Running" ]]; then
    echo -e "${GREEN}${status}${NC}"
  elif [[ "$status" == "Updating" ]] || [[ "$status" == "Creating" ]]; then
    echo -e "${YELLOW}${status}${NC}"
  else
    echo -e "${RED}${status}${NC}"
  fi
}

AKS_PROV=$(az aks show --name "$CLUSTER_NAME" --resource-group "$RESOURCE_GROUP" --query 'provisioningState' -o tsv 2>/dev/null || echo "NOT FOUND")
STORAGE_PROV=$(az storage account show --name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" --query 'provisioningState' -o tsv 2>/dev/null || echo "NOT FOUND")

printf "$FORMAT" "AKS Cluster ($CLUSTER_NAME)" "$(get_az_status "$AKS_PROV")"
printf "$FORMAT" "Storage Account ($STORAGE_ACCOUNT)" "$(get_az_status "$STORAGE_PROV")"

# 2. Kubernetes Pods Status Helper
check_pod_status() {
  local app_name="$1"
  local display_name="$2"
  local status=""
  local color="$NC"

  # Try different common label patterns
  local labels=(
    "ingext.io/app=$app_name"
    "app=$app_name"
    "app.kubernetes.io/name=$app_name"
  )

  for label in "${labels[@]}"; do
    # Get phase
    status=$(kubectl get pods -n "$NAMESPACE" -l "$label" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)
    
    if [[ -n "$status" ]]; then
      if [[ "$status" == "Running" ]]; then
        # Get readiness
        local is_ready=""
        is_ready=$(kubectl get pods -n "$NAMESPACE" -l "$label" -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null || echo "true")
        
        if [[ "$is_ready" == "false" ]]; then
          status="Starting (0/1)"
          color="$YELLOW"
        else
          status="Running"
          color="$GREEN"
        fi
      elif [[ "$status" == "Pending" ]]; then
        color="$YELLOW"
      else
        color="$RED"
      fi
      break
    fi
  done

  if [[ -z "$status" ]]; then
    status="NOT DEPLOYED"
    color="$RED"
  fi

  printf "$FORMAT" "$display_name" "${color}${status}${NC}"
}

# 3. Component Status
echo ""
echo "[Core Services]"
check_pod_status "redis" "Redis (Cache)"
check_pod_status "opensearch" "OpenSearch (Search Index)"
check_pod_status "victoria-metrics-single" "VictoriaMetrics (TSDB)"
check_pod_status "etcd" "etcd (Key-Value Store)"

echo ""
echo "[Ingext Stream]"
check_pod_status "api" "API Service"
check_pod_status "platform" "Platform Service"
check_pod_status "fluency8" "Fluency Service"

echo ""
echo "[Ingext Datalake]"
check_pod_status "lake-mgr" "Lake Manager"
check_pod_status "search-service" "Lake Search"
check_pod_status "lake-worker" "Lake Worker"

echo ""
echo "[Networking]"
# Ingress Address
AGW_IP=$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "PROVISIONING...")
COLOR_IP="$NC"
if [[ "$AGW_IP" =~ ^[0-9] ]]; then
  COLOR_IP="$GREEN"
fi
printf "$FORMAT" "Azure App Gateway" "${COLOR_IP}${AGW_IP}${NC}"
printf "$FORMAT" "DNS Domain" "$SITE_DOMAIN"

echo "========================================================================"
echo ""
echo "💡 TIP: If components are 'NOT DEPLOYED' or stuck, check logs:"
echo "   ./lakehouse-logs.sh api"
echo ""
