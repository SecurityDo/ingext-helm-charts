#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# API Routing Diagnostic Script
#
# Diagnoses why API endpoints return 404 by checking:
# - Ingress path configuration
# - API service and endpoints
# - API pod status
# - Ingress backend health
#
# Usage:
#   ./diagnose-api-routing.sh [--namespace ingext] [--domain gcp.k8.ingext.io]
###############################################################################

print_help() {
  cat <<EOF
API Routing Diagnostic Script

Usage:
  ./diagnose-api-routing.sh [options]

Optional options:
  --namespace <name>               Kubernetes namespace (default: ingext)
  --domain <fqdn>                  Public site domain (default: from ingext-gke.env)
  --help                           Show this help message and exit

Environment variables (optional, flags override):
  NAMESPACE
  SITE_DOMAIN

Example:
  ./diagnose-api-routing.sh --namespace ingext --domain gcp.k8.ingext.io
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
    --domain)
      SITE_DOMAIN="$2"
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

# -------- Load environment file if available --------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/ingext-gke.env"
if [[ -f "$ENV_FILE" ]]; then
  log "Loading environment from $ENV_FILE"
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  # Override with command-line args if provided
  [[ -n "${NAMESPACE:-}" ]] && NAMESPACE="${NAMESPACE}"
  [[ -n "${SITE_DOMAIN:-}" ]] && SITE_DOMAIN="${SITE_DOMAIN}"
fi

# -------- Validate required variables --------
if [[ -z "${SITE_DOMAIN:-}" ]]; then
  echo "ERROR: SITE_DOMAIN is required"
  echo "Either set it via --domain flag or in ingext-gke.env"
  exit 1
fi

# -------- Check kubectl connectivity --------
if ! kubectl cluster-info >/dev/null 2>&1; then
  echo "ERROR: Cannot connect to Kubernetes cluster"
  exit 1
fi

echo ""
echo "=========================================="
echo "API Routing Diagnostic Report"
echo "=========================================="
echo "Domain: $SITE_DOMAIN"
echo "Namespace: $NAMESPACE"
echo ""

# -------- 1. Check Ingress Configuration --------
log "1. Ingress Path Configuration"
if kubectl get ingress ingext-ingress -n "$NAMESPACE" >/dev/null 2>&1; then
  # Count how many rules exist
  RULE_COUNT=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[*].host}' 2>/dev/null | tr ' ' '\n' | grep -c "$SITE_DOMAIN" || echo "0")
  
  if [[ "$RULE_COUNT" -eq 1 ]]; then
    color_green "✓ Ingress has single rule (correct)"
    
    # Check paths
    PATHS=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[0].http.paths[*].path}' 2>/dev/null || echo "")
    if echo "$PATHS" | grep -q "/api"; then
      color_green "✓ /api path configured"
    else
      color_red "✗ /api path NOT configured"
    fi
    
    if echo "$PATHS" | grep -q "/services"; then
      color_green "✓ /services path configured"
    else
      color_yellow "⚠ /services path not found"
    fi
    
    if echo "$PATHS" | grep -q "^/$"; then
      color_green "✓ / path configured"
    else
      color_yellow "⚠ / path not found"
    fi
    
    echo "   Configured paths: $PATHS"
  else
    color_red "✗ Ingress has $RULE_COUNT rules (should be 1)"
    echo "   This is the problem! GKE Ingress requires all paths under a single rule."
    echo ""
    echo "   Current rules:"
    kubectl get ingress ingext-ingress -n "$NAMESPACE" -o yaml | grep -A 5 "rules:" || true
  fi
else
  color_red "✗ Ingress not found"
fi

# -------- 2. Check API Service --------
log "2. API Service Status"
if kubectl get service api -n "$NAMESPACE" >/dev/null 2>&1; then
  color_green "✓ API service exists"
  
  # Check service endpoints
  API_ENDPOINTS=$(kubectl get endpoints api -n "$NAMESPACE" -o jsonpath='{.subsets[0].addresses[*].ip}' 2>/dev/null || echo "")
  if [[ -n "$API_ENDPOINTS" ]]; then
    color_green "✓ API service has endpoints: $API_ENDPOINTS"
  else
    color_red "✗ API service has NO endpoints"
    echo "   This means no API pods are ready or service selector doesn't match pods"
  fi
  
  # Check service port
  API_PORT=$(kubectl get service api -n "$NAMESPACE" -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo "")
  if [[ "$API_PORT" == "8002" ]]; then
    color_green "✓ API service port is 8002 (correct)"
  else
    color_yellow "⚠ API service port is $API_PORT (expected 8002)"
  fi
else
  color_red "✗ API service not found"
fi

# -------- 3. Check API Pods --------
log "3. API Pod Status"
API_PODS=$(kubectl get pods -n "$NAMESPACE" -l "ingext.io/app=api" --no-headers 2>/dev/null | wc -l || echo "0")
if [[ "$API_PODS" -gt 0 ]]; then
  API_READY=$(kubectl get pods -n "$NAMESPACE" -l "ingext.io/app=api" --no-headers 2>/dev/null | grep -c "Running" || echo "0")
  if [[ "$API_READY" -gt 0 ]]; then
    color_green "✓ API pods are running ($API_READY/$API_PODS)"
    echo "   Pod details:"
    kubectl get pods -n "$NAMESPACE" -l "ingext.io/app=api" -o wide
  else
    color_red "✗ API pods exist but none are Running"
    echo "   Pod status:"
    kubectl get pods -n "$NAMESPACE" -l "ingext.io/app=api"
  fi
else
  color_red "✗ No API pods found"
  echo "   Check if API statefulset exists:"
  kubectl get statefulset -n "$NAMESPACE" | grep api || echo "   (No API statefulset found)"
fi

# -------- 4. Check Ingress Backend Health --------
log "4. Ingress Backend Health"
if kubectl get ingress ingext-ingress -n "$NAMESPACE" >/dev/null 2>&1; then
  BACKENDS=$(kubectl describe ingress ingext-ingress -n "$NAMESPACE" 2>/dev/null | grep -A 10 "Backends:" || echo "")
  if [[ -n "$BACKENDS" ]]; then
    echo "$BACKENDS"
    if echo "$BACKENDS" | grep -q "api.*HEALTHY"; then
      color_green "✓ API backend is HEALTHY"
    elif echo "$BACKENDS" | grep -q "api.*UNHEALTHY"; then
      color_red "✗ API backend is UNHEALTHY"
      echo "   This can take 10-15 minutes after BackendConfig is applied"
    elif echo "$BACKENDS" | grep -q "api"; then
      color_yellow "⚠ API backend status unknown"
    else
      color_red "✗ API backend not found in ingress backends"
    fi
  else
    color_yellow "⚠ Backend status not available yet (ingress may still be provisioning)"
  fi
fi

# -------- 5. Test Direct API Access --------
log "5. Test Direct API Access (port-forward)"
if kubectl get service api -n "$NAMESPACE" >/dev/null 2>&1; then
  echo "   Testing API via port-forward (this will run in background)..."
  kubectl port-forward -n "$NAMESPACE" service/api 8002:8002 >/dev/null 2>&1 &
  PF_PID=$!
  sleep 2
  
  if curl -s -f http://localhost:8002/api/auth/login -X POST -H "Content-Type: application/json" -d '{}' >/dev/null 2>&1; then
    color_green "✓ API responds correctly via direct access"
    echo "   This confirms the API itself works - the issue is with ingress routing"
  else
    HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8002/api/auth/login -X POST -H "Content-Type: application/json" -d '{}' 2>/dev/null || echo "000")
    if [[ "$HTTP_CODE" == "404" ]]; then
      color_yellow "⚠ API returns 404 even via direct access"
      echo "   This suggests the API application itself may have routing issues"
    elif [[ "$HTTP_CODE" == "000" ]]; then
      color_red "✗ Cannot connect to API (connection refused)"
      echo "   API pod may not be listening on port 8002"
    else
      color_yellow "⚠ API returned HTTP $HTTP_CODE"
    fi
  fi
  
  kill $PF_PID 2>/dev/null || true
  wait $PF_PID 2>/dev/null || true
else
  color_yellow "⚠ Cannot test - API service not found"
fi

# -------- Summary and Recommendations --------
echo ""
echo "=========================================="
echo "Summary and Recommendations"
echo "=========================================="

# Check if ingress has multiple rules
RULE_COUNT=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[*].host}' 2>/dev/null | tr ' ' '\n' | grep -c "$SITE_DOMAIN" || echo "0")
if [[ "$RULE_COUNT" -gt 1 ]]; then
  echo ""
  color_red "PRIMARY ISSUE: Ingress has multiple rules"
  echo "   Fix: Run ./fix-all-issues.sh --domain $SITE_DOMAIN"
  echo "   Or reinstall ingress: helm upgrade --install ingext-community-ingress-gcp ..."
fi

# Check if API has endpoints
API_ENDPOINTS=$(kubectl get endpoints api -n "$NAMESPACE" -o jsonpath='{.subsets[0].addresses[*].ip}' 2>/dev/null || echo "")
if [[ -z "$API_ENDPOINTS" ]]; then
  echo ""
  color_red "ISSUE: API service has no endpoints"
  echo "   Check: kubectl get pods -n $NAMESPACE | grep api"
  echo "   Check: kubectl get statefulset -n $NAMESPACE | grep api"
  echo "   Wait for API pods to be Running"
fi

# Check if API backend is unhealthy
BACKENDS=$(kubectl describe ingress ingext-ingress -n "$NAMESPACE" 2>/dev/null | grep -A 10 "Backends:" || echo "")
if echo "$BACKENDS" | grep -q "api.*UNHEALTHY"; then
  echo ""
  color_yellow "ISSUE: API backend is UNHEALTHY"
  echo "   This can take 10-15 minutes after BackendConfig is applied"
  echo "   Check: kubectl get backendconfig api-backend-config -n $NAMESPACE"
  echo "   Verify: kubectl get service api -n $NAMESPACE -o yaml | grep backend-config"
fi

echo ""
echo "For more details:"
echo "  kubectl describe ingress ingext-ingress -n $NAMESPACE"
echo "  kubectl get endpoints api -n $NAMESPACE"
echo "  kubectl logs -n $NAMESPACE -l ingext.io/app=api --tail=50"


