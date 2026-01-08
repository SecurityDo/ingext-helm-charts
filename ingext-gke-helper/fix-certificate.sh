#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Fix Certificate Issues
#
# Fixes common certificate issuance issues:
# 1. Deletes existing TLS secret with wrong issuer annotation
# 2. Ensures ingress path ordering allows ACME challenges
#
# Usage:
#   ./fix-certificate.sh [--namespace ingext] [--domain gcp.k8.ingext.io]
###############################################################################

print_help() {
  cat <<EOF
Fix Certificate Issues

Usage:
  ./fix-certificate.sh [options]

Optional options:
  --namespace <name>               Kubernetes namespace (default: ingext)
  --domain <fqdn>                  Public site domain (default: from ingext-gke.env)
  --help                           Show this help message and exit

Environment variables (optional, flags override):
  NAMESPACE
  SITE_DOMAIN

Example:
  ./fix-certificate.sh --namespace ingext --domain gcp.k8.ingext.io
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
echo "Certificate Fix Script"
echo "=========================================="
echo "Domain: $SITE_DOMAIN"
echo "Namespace: $NAMESPACE"
echo ""

# -------- Step 1: Delete existing TLS secret (fixes IncorrectIssuer) --------
log "Step 1: Check and delete existing TLS secret (if needed)"
TLS_SECRET="ingext-tls-secret"
if kubectl get secret "$TLS_SECRET" -n "$NAMESPACE" >/dev/null 2>&1; then
  ISSUER_ANNOTATION=$(kubectl get secret "$TLS_SECRET" -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.cert-manager\.io/issuer-name}' 2>/dev/null || echo "")
  CLUSTER_ISSUER_ANNOTATION=$(kubectl get secret "$TLS_SECRET" -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.cert-manager\.io/cluster-issuer-name}' 2>/dev/null || echo "")
  
  if [[ -n "$ISSUER_ANNOTATION" ]] && [[ -z "$CLUSTER_ISSUER_ANNOTATION" ]]; then
    color_yellow "Found TLS secret with Issuer annotation (not ClusterIssuer)"
    echo "   Deleting secret to allow cert-manager to recreate it with ClusterIssuer"
    kubectl delete secret "$TLS_SECRET" -n "$NAMESPACE"
    color_green "✓ TLS secret deleted"
  elif [[ -z "$CLUSTER_ISSUER_ANNOTATION" ]] || [[ "$CLUSTER_ISSUER_ANNOTATION" != "letsencrypt-prod" ]]; then
    color_yellow "Found TLS secret with incorrect issuer annotation"
    echo "   Deleting secret to allow cert-manager to recreate it"
    kubectl delete secret "$TLS_SECRET" -n "$NAMESPACE"
    color_green "✓ TLS secret deleted"
  else
    color_green "✓ TLS secret has correct ClusterIssuer annotation"
  fi
else
  color_green "✓ No existing TLS secret found (will be created by cert-manager)"
fi

# -------- Step 2: Delete existing challenges (force recreation) --------
log "Step 2: Delete existing challenges (force recreation)"
CHALLENGES=$(kubectl get challenge -n "$NAMESPACE" -o name 2>/dev/null || echo "")
if [[ -n "$CHALLENGES" ]]; then
  echo "   Found existing challenges, deleting them..."
  kubectl delete challenge -n "$NAMESPACE" --all
  color_green "✓ Challenges deleted"
else
  color_green "✓ No existing challenges found"
fi

# -------- Step 3: Delete Certificate resource (force recreation) --------
log "Step 3: Delete Certificate resource (force recreation)"
CERT_NAME=$(kubectl get certificate -n "$NAMESPACE" -o name 2>/dev/null | head -1 || echo "")
if [[ -n "$CERT_NAME" ]]; then
  echo "   Found certificate resource, deleting it..."
  kubectl delete "$CERT_NAME" -n "$NAMESPACE"
  color_green "✓ Certificate resource deleted"
  echo "   cert-manager will recreate it automatically"
else
  color_green "✓ No existing certificate resource found"
fi

# -------- Step 4: Verify ingress has correct annotations --------
log "Step 4: Verify ingress annotations"
if kubectl get ingress ingext-ingress -n "$NAMESPACE" >/dev/null 2>&1; then
  CERT_ISSUER_ANN=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.cert-manager\.io/cluster-issuer}' 2>/dev/null || echo "")
  HTTP01_ANN=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.acme\.cert-manager\.io/http01-edit-in-place}' 2>/dev/null || echo "")
  
  if [[ "$CERT_ISSUER_ANN" == "letsencrypt-prod" ]] && [[ "$HTTP01_ANN" == "true" ]]; then
    color_green "✓ Ingress has correct cert-manager annotations"
  else
    color_red "✗ Ingress missing required annotations"
    echo "   ACTION REQUIRED: Recreate ingress with correct annotations"
    echo "   Run: ./recreate-ingress.sh --domain $SITE_DOMAIN"
    exit 1
  fi
else
  color_red "✗ Ingress not found"
  echo "   ACTION REQUIRED: Recreate ingress"
  echo "   Run: ./recreate-ingress.sh --domain $SITE_DOMAIN"
  exit 1
fi

# -------- Step 5: Wait and monitor --------
log "Step 5: Waiting for cert-manager to recreate resources"
echo "   Waiting 30 seconds for cert-manager to process..."
sleep 30

echo ""
echo "=========================================="
echo "Next Steps"
echo "=========================================="
echo ""
echo "1. Monitor certificate creation:"
echo "   kubectl get certificate -n $NAMESPACE -w"
echo ""
echo "2. Monitor challenges:"
echo "   kubectl get challenge -n $NAMESPACE -w"
echo ""
echo "3. Check certificate details:"
echo "   kubectl describe certificate -n $NAMESPACE"
echo ""
echo "4. If challenges still fail, check:"
echo "   - DNS resolves correctly: nslookup $SITE_DOMAIN"
echo "   - cert-manager logs: kubectl logs -n cert-manager -l app=cert-manager"
echo ""
echo "Note: With 'http01-edit-in-place: true', cert-manager will automatically"
echo "      add the /.well-known/acme-challenge/ path to the ingress."
echo "      This may take 1-2 minutes to propagate."
echo ""

color_green "Certificate fix complete!"


