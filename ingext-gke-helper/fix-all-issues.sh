#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Fix All Issues - Certificate and API Routing
#
# Comprehensive fix script that:
# 1. Fixes ingress path configuration (consolidates paths under single rule)
# 2. Fixes certificate issues
# 3. Verifies API routing
#
# Usage:
#   ./fix-all-issues.sh [--namespace ingext] [--domain gcp.k8.ingext.io]
###############################################################################

print_help() {
  cat <<EOF
Fix All Issues - Certificate and API Routing

Usage:
  ./fix-all-issues.sh [options]

Optional options:
  --namespace <name>               Kubernetes namespace (default: ingext)
  --domain <fqdn>                  Public site domain (default: from ingext-gke.env)
  --help                           Show this help message and exit

Environment variables (optional, flags override):
  NAMESPACE
  SITE_DOMAIN

Example:
  ./fix-all-issues.sh --namespace ingext --domain gcp.k8.ingext.io
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
for bin in kubectl helm; do
  need "$bin"
done

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
echo "Fix All Issues - Certificate and API Routing"
echo "=========================================="
echo "Domain: $SITE_DOMAIN"
echo "Namespace: $NAMESPACE"
echo ""

# -------- Step 1: Fix Certificate Issues --------
log "Step 1: Fix Certificate Issues"
TLS_SECRET="ingext-tls-secret"
if kubectl get secret "$TLS_SECRET" -n "$NAMESPACE" >/dev/null 2>&1; then
  ISSUER_ANNOTATION=$(kubectl get secret "$TLS_SECRET" -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.cert-manager\.io/issuer-name}' 2>/dev/null || echo "")
  CLUSTER_ISSUER_ANNOTATION=$(kubectl get secret "$TLS_SECRET" -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.cert-manager\.io/cluster-issuer-name}' 2>/dev/null || echo "")
  
  if [[ -n "$ISSUER_ANNOTATION" ]] || [[ -z "$CLUSTER_ISSUER_ANNOTATION" ]] || [[ "$CLUSTER_ISSUER_ANNOTATION" != "letsencrypt-prod" ]]; then
    color_yellow "Deleting TLS secret with incorrect issuer annotation"
    kubectl delete secret "$TLS_SECRET" -n "$NAMESPACE" 2>/dev/null || true
    color_green "✓ TLS secret deleted"
  fi
fi

# Delete challenges and certificate
kubectl delete challenge -n "$NAMESPACE" --all 2>/dev/null || true
CERT_NAME=$(kubectl get certificate -n "$NAMESPACE" -o name 2>/dev/null | head -1 || echo "")
if [[ -n "$CERT_NAME" ]]; then
  kubectl delete "$CERT_NAME" -n "$NAMESPACE" 2>/dev/null || true
  color_green "✓ Certificate resource deleted"
fi

# -------- Step 2: Fix Ingress Configuration --------
log "Step 2: Fix Ingress Configuration (consolidate paths under single rule)"
CHART_DIR="$SCRIPT_DIR/../charts/ingext-community-ingress-gcp"
STATIC_IP_NAME="${NAMESPACE}-static-ip"

if [[ ! -d "$CHART_DIR" ]]; then
  color_red "✗ Ingress chart not found at $CHART_DIR"
  exit 1
fi

# Get static IP name from existing ingress if available
if kubectl get ingress ingext-ingress -n "$NAMESPACE" >/dev/null 2>&1; then
  EXISTING_STATIC_IP=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.kubernetes\.io/ingress\.global-static-ip-name}' 2>/dev/null || echo "")
  if [[ -n "$EXISTING_STATIC_IP" ]]; then
    STATIC_IP_NAME="$EXISTING_STATIC_IP"
  fi
fi

color_yellow "Reinstalling ingress with fixed path configuration"
helm upgrade --install ingext-community-ingress-gcp "$CHART_DIR" \
  -n "$NAMESPACE" \
  --set "siteDomain=$SITE_DOMAIN" \
  --set "ingress.staticIpName=$STATIC_IP_NAME" || {
  color_red "✗ Failed to reinstall ingress"
  exit 1
}

color_green "✓ Ingress reinstalled with fixed configuration"

# -------- Step 3: Verify Ingress Paths --------
log "Step 3: Verify Ingress Path Configuration"
INGRESS_PATHS=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[0].http.paths[*].path}' 2>/dev/null || echo "")
if echo "$INGRESS_PATHS" | grep -q "/api"; then
  color_green "✓ Ingress has /api path configured"
else
  color_red "✗ Ingress missing /api path"
fi

# -------- Step 4: Verify API Service --------
log "Step 4: Verify API Service"
if kubectl get service api -n "$NAMESPACE" >/dev/null 2>&1; then
  API_ENDPOINTS=$(kubectl get endpoints api -n "$NAMESPACE" -o jsonpath='{.subsets[0].addresses[*].ip}' 2>/dev/null || echo "")
  if [[ -n "$API_ENDPOINTS" ]]; then
    color_green "✓ API service has endpoints"
  else
    color_yellow "⚠ API service has no endpoints (pods may not be ready)"
  fi
else
  color_red "✗ API service not found"
fi

# -------- Step 5: Wait for Resources --------
log "Step 5: Waiting for resources to stabilize"
echo "   Waiting 30 seconds for ingress and cert-manager to process..."
sleep 30

# -------- Step 6: Check Status --------
log "Step 6: Current Status"
ING_IP=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
if [[ -n "$ING_IP" ]]; then
  color_green "✓ Ingress IP: $ING_IP"
else
  color_yellow "⚠ Ingress IP not yet assigned (may take 2-5 minutes)"
fi

CERT_READY=$(kubectl get certificate -n "$NAMESPACE" -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "Unknown")
if [[ "$CERT_READY" == "True" ]]; then
  color_green "✓ Certificate is Ready"
elif [[ "$CERT_READY" == "False" ]]; then
  color_yellow "⚠ Certificate not yet ready (this is normal, may take 5-10 minutes)"
else
  color_yellow "⚠ Certificate resource not yet created (cert-manager will create it)"
fi

echo ""
echo "=========================================="
echo "Next Steps"
echo "=========================================="
echo ""
echo "1. Wait for ingress IP (if not assigned):"
echo "   kubectl get ingress ingext-ingress -n $NAMESPACE -w"
echo ""
echo "2. Monitor certificate issuance:"
echo "   kubectl get certificate -n $NAMESPACE -w"
echo "   kubectl get challenge -n $NAMESPACE -w"
echo ""
echo "3. Test API routing (once certificate is ready):"
echo "   curl -k https://$SITE_DOMAIN/api/auth/login -X POST -H 'Content-Type: application/json' -d '{}'"
echo ""
echo "4. Check ingress paths:"
echo "   kubectl describe ingress ingext-ingress -n $NAMESPACE | grep -A 20 'Rules:'"
echo ""
echo "5. If API still returns 404, check:"
echo "   - API pods are running: kubectl get pods -n $NAMESPACE | grep api"
echo "   - API service endpoints: kubectl get endpoints api -n $NAMESPACE"
echo "   - Ingress backend health: kubectl describe ingress ingext-ingress -n $NAMESPACE | grep Backends"
echo ""

color_green "Fix complete! Monitor the resources above."

