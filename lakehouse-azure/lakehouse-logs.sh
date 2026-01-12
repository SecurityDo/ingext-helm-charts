#!/usr/bin/env bash

set -uo pipefail

###############################################################################
# Azure Lakehouse Log Viewer
#
# Usage: 
#   ./lakehouse-logs.sh              - Show recent logs for ALL components
#   ./lakehouse-logs.sh api          - Show logs for API
#   ./lakehouse-logs.sh platform     - Show logs for Platform
#   ./lakehouse-logs.sh agic        - Show logs for Application Gateway Ingress Controller
#   ./lakehouse-logs.sh errors       - Show only lines containing "ERROR" or "FAIL"
###############################################################################

# -------- 1. Load Environment --------
if [[ ! -f "./lakehouse-azure.env" ]]; then
  echo "ERROR: lakehouse-azure.env not found."
  exit 1
fi

source ./lakehouse-azure.env

COMPONENT="${1:-all}"
TAIL="${2:-50}"

log_component() {
  local app_name="$1"
  local display_name="$2"
  echo "--- Logs for $display_name ($app_name) ---"
  
  # Try the different label patterns we use
  local labels=(
    "ingext.io/app=$app_name"
    "app=$app_name"
    "app.kubernetes.io/name=$app_name"
  )
  
  local found=false
  for label in "${labels[@]}"; do
    if kubectl get pods -n "$NAMESPACE" -l "$label" 2>/dev/null | grep -q "Running\|Error\|Crash"; then
      kubectl logs -n "$NAMESPACE" -l "$label" --tail="$TAIL" --all-containers=true
      found=true
      break
    fi
  done
  
  if [[ "$found" == "false" ]]; then
    echo "   (No pods found for $app_name)"
  fi
  echo ""
}

case "$COMPONENT" in
  api)
    log_component "api" "API Service"
    ;;
  platform)
    log_component "platform" "Platform Service"
    ;;
  fluency)
    log_component "fluency8" "Fluency Service"
    ;;
  lake)
    log_component "lake-mgr" "Lake Manager"
    log_component "search-service" "Lake Search"
    log_component "lake-worker" "Lake Worker"
    ;;
  agic)
    echo "--- Logs for Application Gateway Ingress Controller ---"
    kubectl logs -n kube-system -l app.kubernetes.io/name=ingress-appgw --tail="$TAIL"
    ;;
  errors)
    echo "--- Searching for ERROR/FAIL across all pods in $NAMESPACE ---"
    kubectl logs -n "$NAMESPACE" --all-pods=true --tail=200 | grep -iE "error|fail|exception|fatal"
    ;;
  all)
    log_component "api" "API"
    log_component "platform" "Platform"
    log_component "lake-mgr" "Lake Manager"
    log_component "search-service" "Search Service"
    ;;
  *)
    echo "Unknown component: $COMPONENT"
    echo "Available: api, platform, fluency, lake, agic, errors, all"
    exit 1
    ;;
esac
