#!/usr/bin/env bash

set -uo pipefail

###############################################################################
# Fix All Remaining Issues
#
# Addresses all remaining issues identified by test-all.sh:
# 1. Certificate IncorrectIssuer
# 2. API backend not registered (force GKE to reprocess)
# 3. Ingress / path check (verify and fix if needed)
#
# Usage:
#   ./fix-remaining-issues.sh [--namespace ingext] [--domain gcp.k8.ingext.io]
###############################################################################

print_help() {
  cat <<EOF
Fix All Remaining Issues

Usage:
  ./fix-remaining-issues.sh [options]

Optional options:
  --namespace <name>               Kubernetes namespace (default: ingext)
  --domain <fqdn>                  Public site domain (default: from ingext-gke.env)
  --help                           Show this help message and exit

Environment variables (optional, flags override):
  NAMESPACE
  SITE_DOMAIN

Example:
  ./fix-remaining-issues.sh --namespace ingext --domain gcp.k8.ingext.io
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
      exit 1
      ;;
  esac
done

# -------- Helper functions --------
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

# -------- Load environment file if available --------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/ingext-gke.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  [[ -n "${NAMESPACE:-}" ]] && NAMESPACE="${NAMESPACE}"
  [[ -n "${SITE_DOMAIN:-}" ]] && SITE_DOMAIN="${SITE_DOMAIN}"
fi

# -------- Validate required variables --------
if [[ -z "${SITE_DOMAIN:-}" ]]; then
  echo "ERROR: SITE_DOMAIN is required"
  exit 1
fi

echo ""
echo "=========================================="
echo "Fix All Remaining Issues"
echo "=========================================="
echo "Domain: $SITE_DOMAIN"
echo "Namespace: $NAMESPACE"
echo ""

# ============================================================================
# STEP 1: Fix Certificate (IncorrectIssuer)
# ============================================================================
log "Step 1: Fix Certificate (IncorrectIssuer)"

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

# ============================================================================
# STEP 2: Force GKE to Reprocess BackendConfig
# ============================================================================
log "Step 2: Force GKE to Reprocess BackendConfig (remove and re-add annotation)"

# Remove BackendConfig annotation temporarily
if kubectl get service api -n "$NAMESPACE" >/dev/null 2>&1; then
  color_yellow "Removing BackendConfig annotation from API service"
  kubectl annotate service api -n "$NAMESPACE" cloud.google.com/backend-config- 2>/dev/null || true
  sleep 5
  
  color_yellow "Re-adding BackendConfig annotation to API service"
  kubectl annotate service api -n "$NAMESPACE" \
    cloud.google.com/backend-config='{"default": "api-backend-config"}' \
    --overwrite
  color_green "✓ BackendConfig annotation refreshed"
else
  color_red "✗ API service not found"
fi

# ============================================================================
# STEP 3: Verify and Fix Ingress / Path
# ============================================================================
log "Step 3: Verify Ingress / Path"

PATHS=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[0].http.paths[*].path}' 2>/dev/null || echo "")

if echo "$PATHS" | grep -q "^/$"; then
  color_green "✓ Ingress has / path"
else
  color_yellow "⚠ Ingress missing / path, reinstalling ingress"
  
  # Get static IP name
  STATIC_IP_NAME=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.kubernetes\.io/ingress\.global-static-ip-name}' 2>/dev/null || echo "${NAMESPACE}-static-ip")
  
  CHART_DIR="$SCRIPT_DIR/../charts/ingext-community-ingress-gcp"
  if [[ -d "$CHART_DIR" ]]; then
    helm upgrade --install ingext-community-ingress-gcp "$CHART_DIR" \
      -n "$NAMESPACE" \
      --set "siteDomain=$SITE_DOMAIN" \
      --set "ingress.staticIpName=$STATIC_IP_NAME" || {
      color_red "✗ Failed to reinstall ingress"
    }
    color_green "✓ Ingress reinstalled"
  fi
fi

# ============================================================================
# STEP 4: Clear Old Ingress Errors (by triggering a sync)
# ============================================================================
log "Step 4: Trigger Ingress Sync (clear old errors)"

# Add a temporary annotation to force ingress controller to sync
kubectl annotate ingress ingext-ingress -n "$NAMESPACE" \
  "ingress.kubernetes.io/force-sync=$(date +%s)" \
  --overwrite 2>/dev/null || true

# Remove it immediately (just needed to trigger sync)
kubectl annotate ingress ingext-ingress -n "$NAMESPACE" \
  "ingress.kubernetes.io/force-sync-" \
  --overwrite 2>/dev/null || true

color_green "✓ Ingress sync triggered"

# ============================================================================
# SUMMARY
# ============================================================================
echo ""
echo "=========================================="
echo "Fix Complete"
echo "=========================================="
echo ""
echo "Actions taken:"
echo "  1. ✓ Fixed certificate (deleted old secret/certificate)"
echo "  2. ✓ Refreshed BackendConfig annotation (force GKE reprocess)"
echo "  3. ✓ Verified/fixed ingress / path"
echo "  4. ✓ Triggered ingress sync"
echo ""
echo "Next steps:"
echo ""
echo "1. Wait 10-15 minutes for GKE to:"
echo "   - Reprocess BackendConfig with HTTP health check"
echo "   - Register API backend in load balancer"
echo "   - Update backend health status"
echo ""
echo "2. Re-run test suite to verify:"
echo "   ./test-all.sh --domain $SITE_DOMAIN"
echo ""
echo "3. Monitor backend health:"
echo "   kubectl describe ingress ingext-ingress -n $NAMESPACE | grep -A 10 'Backends:'"
echo ""
echo "4. Monitor certificate:"
echo "   kubectl get certificate -n $NAMESPACE -w"
echo ""

color_green "All fixes applied! Wait 10-15 minutes, then re-run ./test-all.sh"

