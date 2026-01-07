#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Fix Ingress Paths - Restore Application Routes
#
# Fixes ingress when cert-manager's http01-edit-in-place removes application paths.
# This script ensures both ACME challenge paths AND application paths exist.
#
# Usage:
#   ./fix-ingress-paths.sh [--namespace ingext] [--domain gcp.k8.ingext.io]
###############################################################################

print_help() {
  cat <<EOF
Fix Ingress Paths - Restore Application Routes

Usage:
  ./fix-ingress-paths.sh [options]

Optional options:
  --namespace <name>               Kubernetes namespace (default: ingext)
  --domain <fqdn>                  Public site domain (default: from ingext-gke.env)
  --help                           Show this help message and exit

Environment variables (optional, flags override):
  NAMESPACE
  SITE_DOMAIN

Example:
  ./fix-ingress-paths.sh --namespace ingext --domain gcp.k8.ingext.io
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
echo "Fix Ingress Paths - Restore Application Routes"
echo "=========================================="
echo "Domain: $SITE_DOMAIN"
echo "Namespace: $NAMESPACE"
echo ""

# -------- Step 1: Get current ingress and extract ACME challenge paths --------
log "Step 1: Extract existing ACME challenge paths"
CURRENT_INGRESS=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o yaml 2>/dev/null || echo "")

if [[ -z "$CURRENT_INGRESS" ]]; then
  color_red "✗ Ingress not found"
  exit 1
fi

# Extract ACME challenge paths (cert-manager adds these)
ACME_PATHS=$(echo "$CURRENT_INGRESS" | grep -A 5 "cm-acme-http-solver" | grep "path:" | sed 's/.*path: //' || echo "")

if [[ -n "$ACME_PATHS" ]]; then
  color_yellow "Found ACME challenge paths (will preserve these)"
  echo "$ACME_PATHS" | while read -r path; do
    echo "   - $path"
  done
else
  color_green "No ACME challenge paths found (cert-manager will add them when needed)"
fi

# Get static IP name if it exists
STATIC_IP_NAME=$(echo "$CURRENT_INGRESS" | grep "ingress.global-static-ip-name" | sed 's/.*: //' || echo "${NAMESPACE}-static-ip")

# -------- Step 2: Reinstall ingress with all paths --------
log "Step 2: Reinstall ingress with application paths (ACME paths will be preserved by cert-manager)"
CHART_DIR="$SCRIPT_DIR/../charts/ingext-community-ingress-gcp"

if [[ ! -d "$CHART_DIR" ]]; then
  color_red "✗ Ingress chart not found at $CHART_DIR"
  exit 1
fi

color_yellow "Reinstalling ingress..."
helm upgrade --install ingext-community-ingress-gcp "$CHART_DIR" \
  -n "$NAMESPACE" \
  --set "siteDomain=$SITE_DOMAIN" \
  --set "ingress.staticIpName=$STATIC_IP_NAME" || {
  color_red "✗ Failed to reinstall ingress"
  exit 1
}

color_green "✓ Ingress reinstalled"

# -------- Step 3: Wait and verify --------
log "Step 3: Wait for ingress to update (30 seconds)"
sleep 30

# -------- Step 4: Verify paths --------
log "Step 4: Verify ingress paths"
PATHS=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.spec.rules[0].http.paths[*].path}' 2>/dev/null || echo "")

if echo "$PATHS" | grep -q "/api"; then
  color_green "✓ /api path configured"
else
  color_red "✗ /api path missing"
fi

if echo "$PATHS" | grep -q "/services"; then
  color_green "✓ /services path configured"
else
  color_yellow "⚠ /services path missing"
fi

if echo "$PATHS" | grep -q "^/$"; then
  color_green "✓ / path configured"
else
  color_yellow "⚠ / path missing"
fi

# Check for ACME paths
if echo "$PATHS" | grep -q "acme-challenge"; then
  color_green "✓ ACME challenge paths present (cert-manager preserved them)"
else
  color_yellow "⚠ No ACME challenge paths (cert-manager will add them when needed)"
fi

echo ""
echo "   All configured paths:"
echo "$PATHS" | tr ' ' '\n' | while read -r path; do
  if [[ -n "$path" ]]; then
    echo "   - $path"
  fi
done

# -------- Step 5: Show next steps --------
echo ""
echo "=========================================="
echo "Next Steps"
echo "=========================================="
echo ""
echo "1. Wait 2-5 minutes for GKE load balancer to update"
echo ""
echo "2. Test API endpoint:"
echo "   curl -k https://$SITE_DOMAIN/api/auth/login -X POST \\"
echo "     -H 'Content-Type: application/json' -d '{}'"
echo ""
echo "3. Monitor ingress:"
echo "   kubectl get ingress ingext-ingress -n $NAMESPACE -w"
echo ""
echo "4. If cert-manager adds challenge paths again, they should coexist with app paths"
echo "   (This is expected behavior with http01-edit-in-place)"
echo ""
echo "5. Check backend health (may take 10-15 minutes):"
echo "   kubectl describe ingress ingext-ingress -n $NAMESPACE | grep -A 10 'Backends:'"
echo ""

color_green "Ingress paths restored! Wait a few minutes for the load balancer to update."


