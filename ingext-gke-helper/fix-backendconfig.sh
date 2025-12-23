#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Fix BackendConfig - Change TCP to HTTP Health Check
#
# GKE Ingress doesn't support TCP health checks. This script updates the
# BackendConfig to use HTTP health checks instead.
#
# Usage:
#   ./fix-backendconfig.sh [--namespace ingext]
###############################################################################

print_help() {
  cat <<EOF
Fix BackendConfig - Change TCP to HTTP Health Check

Usage:
  ./fix-backendconfig.sh [options]

Optional options:
  --namespace <name>               Kubernetes namespace (default: ingext)
  --help                           Show this help message and exit

Environment variables (optional, flags override):
  NAMESPACE

Example:
  ./fix-backendconfig.sh --namespace ingext
EOF
}

# -------- Defaults --------
NAMESPACE="${NAMESPACE:-ingext}"

# -------- Parse arguments --------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1"
      echo "Run with --help for usage."
      exit 1
      ;;
  esac
done

# -------- Helper functions --------
need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing dependency: $1"
    exit 1
  }
}

log() {
  echo ""
  echo "==> $*"
}

color_green() {
  echo -e "\033[0;32m$*\033[0m"
}

color_yellow() {
  echo -e "\033[0;33m$*\033[0m"
}

color_red() {
  echo -e "\033[0;31m$*\033[0m"
}

# -------- Dependency checks --------
need kubectl

# -------- Check kubectl connectivity --------
if ! kubectl cluster-info >/dev/null 2>&1; then
  echo "ERROR: Cannot connect to Kubernetes cluster"
  exit 1
fi

echo ""
echo "=========================================="
echo "Fix BackendConfig - Change TCP to HTTP"
echo "=========================================="
echo "Namespace: $NAMESPACE"
echo ""

# -------- Step 1: Delete existing BackendConfig --------
log "Step 1: Delete existing BackendConfig with TCP health check"
if kubectl get backendconfig api-backend-config -n "$NAMESPACE" >/dev/null 2>&1; then
  kubectl delete backendconfig api-backend-config -n "$NAMESPACE"
  color_green "✓ Old BackendConfig deleted"
  sleep 2
else
  color_yellow "⚠ BackendConfig not found (may have been deleted already)"
fi

# -------- Step 2: Create new BackendConfig with HTTP health check --------
log "Step 2: Create new BackendConfig with HTTP health check"
cat <<EOF | kubectl apply -f -
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: api-backend-config
  namespace: $NAMESPACE
spec:
  healthCheck:
    checkIntervalSec: 10
    timeoutSec: 5
    healthyThreshold: 2
    unhealthyThreshold: 3
    type: HTTP
    port: 8002
    requestPath: /api
EOF

if kubectl get backendconfig api-backend-config -n "$NAMESPACE" >/dev/null 2>&1; then
  color_green "✓ New BackendConfig created with HTTP health check"
else
  color_red "✗ Failed to create BackendConfig"
  exit 1
fi

# -------- Step 3: Verify service annotation --------
log "Step 3: Verify API service annotation"
if kubectl get service api -n "$NAMESPACE" >/dev/null 2>&1; then
  BACKEND_CONFIG_ANN=$(kubectl get service api -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.cloud\.google\.com/backend-config}' 2>/dev/null || echo "")
  if [[ -n "$BACKEND_CONFIG_ANN" ]]; then
    color_green "✓ API service has BackendConfig annotation: $BACKEND_CONFIG_ANN"
  else
    color_yellow "⚠ API service missing BackendConfig annotation, adding it..."
    kubectl annotate service api -n "$NAMESPACE" \
      cloud.google.com/backend-config='{"default": "api-backend-config"}' \
      --overwrite
    color_green "✓ Annotation added"
  fi
else
  color_red "✗ API service not found"
  exit 1
fi

# -------- Step 4: Wait and check status --------
log "Step 4: Wait for GKE to update (30 seconds)"
echo "   GKE will now update the load balancer with the new health check"
sleep 30

# -------- Step 5: Check ingress events --------
log "Step 5: Check for errors"
RECENT_ERRORS=$(kubectl get events -n "$NAMESPACE" --sort-by='.lastTimestamp' | grep -i "error\|warning" | tail -5 || echo "")
if [[ -n "$RECENT_ERRORS" ]]; then
  color_yellow "Recent events (check for health check errors):"
  echo "$RECENT_ERRORS"
else
  color_green "✓ No recent errors found"
fi

echo ""
echo "=========================================="
echo "Next Steps"
echo "=========================================="
echo ""
echo "1. Wait 5-10 minutes for GKE to update the load balancer"
echo ""
echo "2. Monitor ingress backend health:"
echo "   kubectl describe ingress ingext-ingress -n $NAMESPACE | grep -A 10 'Backends:'"
echo ""
echo "3. Check for health check errors:"
echo "   kubectl describe ingress ingext-ingress -n $NAMESPACE | grep -i 'error\|warning'"
echo ""
echo "4. If API backend still doesn't become healthy, try:"
echo "   - Remove BackendConfig entirely (let GKE use defaults)"
echo "   - Or check if API has a different health check endpoint"
echo ""
echo "Note: HTTP health checks require the API to respond with 200 OK to GET /api"
echo "      If the API doesn't support this, the health check may fail."
echo ""

color_green "BackendConfig updated! Monitor the ingress for backend health status."

