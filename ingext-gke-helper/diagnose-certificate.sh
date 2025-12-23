#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Certificate Diagnostic Script
#
# Diagnoses certificate issuance issues by checking:
# - DNS resolution
# - cert-manager status
# - Certificate and challenge status
# - Ingress annotations
# - ClusterIssuer status
#
# Usage:
#   ./diagnose-certificate.sh [--namespace ingext] [--domain gcp.k8.ingext.io]
###############################################################################

print_help() {
  cat <<EOF
Certificate Diagnostic Script

Usage:
  ./diagnose-certificate.sh [options]

Optional options:
  --namespace <name>               Kubernetes namespace (default: ingext)
  --domain <fqdn>                  Public site domain (default: from ingext-gke.env)
  --help                           Show this help message and exit

Environment variables (optional, flags override):
  NAMESPACE
  SITE_DOMAIN

Example:
  ./diagnose-certificate.sh --namespace ingext --domain gcp.k8.ingext.io
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
echo "Certificate Diagnostic Report"
echo "=========================================="
echo "Domain: $SITE_DOMAIN"
echo "Namespace: $NAMESPACE"
echo ""

# -------- 1. Check DNS Resolution --------
log "1. DNS Resolution Check"
ING_IP=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")

if [[ -z "$ING_IP" ]]; then
  color_red "✗ Ingress IP not found"
  echo "   The ingress may still be provisioning (takes 2-5 minutes)"
else
  color_green "✓ Ingress IP: $ING_IP"
  
  # Check DNS resolution
  if command -v nslookup >/dev/null 2>&1; then
    DNS_RESULT=$(nslookup "$SITE_DOMAIN" 2>&1 | grep -A 2 "Name:" || echo "")
    if echo "$DNS_RESULT" | grep -q "$ING_IP"; then
      color_green "✓ DNS resolves correctly to $ING_IP"
    else
      color_yellow "⚠ DNS does not resolve to ingress IP"
      echo "   Current DNS resolution:"
      nslookup "$SITE_DOMAIN" 2>&1 | head -10 || echo "   (Could not resolve)"
      echo ""
      echo "   ACTION REQUIRED: Create DNS A-record:"
      echo "   $SITE_DOMAIN -> $ING_IP"
    fi
  else
    color_yellow "⚠ nslookup not available, skipping DNS check"
  fi
fi

# -------- 2. Check cert-manager --------
log "2. cert-manager Status"
if kubectl get namespace cert-manager >/dev/null 2>&1; then
  CERT_MANAGER_PODS=$(kubectl get pods -n cert-manager --no-headers 2>/dev/null | wc -l || echo "0")
  if [[ "$CERT_MANAGER_PODS" -gt 0 ]]; then
    CERT_MANAGER_READY=$(kubectl get pods -n cert-manager --no-headers 2>/dev/null | grep -c "Running" || echo "0")
    if [[ "$CERT_MANAGER_READY" -gt 0 ]]; then
      color_green "✓ cert-manager is running ($CERT_MANAGER_READY pods)"
    else
      color_yellow "⚠ cert-manager pods exist but not all are Running"
      kubectl get pods -n cert-manager
    fi
  else
    color_red "✗ cert-manager namespace exists but no pods found"
  fi
else
  color_red "✗ cert-manager namespace not found"
  echo "   ACTION REQUIRED: Install cert-manager"
  echo "   helm repo add jetstack https://charts.jetstack.io"
  echo "   helm install cert-manager jetstack/cert-manager --namespace cert-manager --create-namespace --set crds.enabled=true"
fi

# -------- 3. Check ClusterIssuer --------
log "3. ClusterIssuer Status"
if kubectl get clusterissuer letsencrypt-prod >/dev/null 2>&1; then
  ISSUER_READY=$(kubectl get clusterissuer letsencrypt-prod -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "Unknown")
  if [[ "$ISSUER_READY" == "True" ]]; then
    color_green "✓ ClusterIssuer 'letsencrypt-prod' is Ready"
  else
    color_yellow "⚠ ClusterIssuer 'letsencrypt-prod' status: $ISSUER_READY"
    kubectl describe clusterissuer letsencrypt-prod | tail -20
  fi
else
  color_red "✗ ClusterIssuer 'letsencrypt-prod' not found"
  echo "   ACTION REQUIRED: Install cert issuer"
  echo "   helm install ingext-community-certissuer oci://public.ecr.aws/ingext/ingext-community-certissuer -n $NAMESPACE --set email=YOUR_EMAIL"
fi

# -------- 4. Check Ingress Annotations --------
log "4. Ingress Annotations"
if kubectl get ingress ingext-ingress -n "$NAMESPACE" >/dev/null 2>&1; then
  CERT_ISSUER_ANN=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.cert-manager\.io/cluster-issuer}' 2>/dev/null || echo "")
  HTTP01_ANN=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.acme\.cert-manager\.io/http01-edit-in-place}' 2>/dev/null || echo "")
  
  if [[ -n "$CERT_ISSUER_ANN" ]]; then
    color_green "✓ cert-manager.io/cluster-issuer: $CERT_ISSUER_ANN"
  else
    color_red "✗ cert-manager.io/cluster-issuer annotation missing"
    echo "   ACTION REQUIRED: Add annotation to ingress"
  fi
  
  if [[ "$HTTP01_ANN" == "true" ]]; then
    color_green "✓ acme.cert-manager.io/http01-edit-in-place: true"
  else
    color_yellow "⚠ acme.cert-manager.io/http01-edit-in-place not set to 'true'"
  fi
  
  TLS_SECRET=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.spec.tls[0].secretName}' 2>/dev/null || echo "")
  if [[ -n "$TLS_SECRET" ]]; then
    echo "   TLS secret name: $TLS_SECRET"
  else
    color_red "✗ TLS secret name not configured in ingress spec"
  fi
else
  color_red "✗ Ingress 'ingext-ingress' not found in namespace '$NAMESPACE'"
fi

# -------- 5. Check Certificate Resource --------
log "5. Certificate Resource"
CERT_NAME=$(kubectl get certificate -n "$NAMESPACE" -o name 2>/dev/null | head -1 || echo "")
if [[ -n "$CERT_NAME" ]]; then
  CERT_READY=$(kubectl get "$CERT_NAME" -n "$NAMESPACE" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "Unknown")
  CERT_REASON=$(kubectl get "$CERT_NAME" -n "$NAMESPACE" -o jsonpath='{.status.conditions[?(@.type=="Ready")].reason}' 2>/dev/null || echo "")
  
  if [[ "$CERT_READY" == "True" ]]; then
    color_green "✓ Certificate is Ready"
  else
    color_yellow "⚠ Certificate status: $CERT_READY"
    if [[ -n "$CERT_REASON" ]]; then
      echo "   Reason: $CERT_REASON"
    fi
    echo ""
    echo "   Certificate details:"
    kubectl get "$CERT_NAME" -n "$NAMESPACE" -o yaml | grep -A 10 "status:" || true
  fi
else
  color_red "✗ No Certificate resource found in namespace '$NAMESPACE'"
  echo "   This is expected if cert-manager hasn't created it yet"
  echo "   It should be created automatically when:"
  echo "   1. DNS resolves to the ingress IP"
  echo "   2. Ingress has correct cert-manager annotations"
fi

# -------- 6. Check Challenges --------
log "6. Certificate Challenges"
CHALLENGES=$(kubectl get challenge -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l || echo "0")
if [[ "$CHALLENGES" -gt 0 ]]; then
  echo "   Found $CHALLENGES challenge(s):"
  kubectl get challenge -n "$NAMESPACE"
  echo ""
  echo "   Challenge details:"
  for CHALLENGE in $(kubectl get challenge -n "$NAMESPACE" -o name); do
    echo ""
    echo "   $CHALLENGE:"
    kubectl get "$CHALLENGE" -n "$NAMESPACE" -o jsonpath='{.status.state}' 2>/dev/null && echo "" || true
    kubectl describe "$CHALLENGE" -n "$NAMESPACE" | grep -A 5 "Status:" || true
  done
else
  color_yellow "⚠ No challenges found"
  echo "   Challenges are created when:"
  echo "   1. Certificate resource exists"
  echo "   2. DNS resolves correctly"
  echo "   3. cert-manager can reach the domain"
fi

# -------- Summary and Recommendations --------
echo ""
echo "=========================================="
echo "Summary and Recommendations"
echo "=========================================="

if [[ -z "$ING_IP" ]]; then
  echo "1. Wait for ingress IP assignment (2-5 minutes)"
fi

if ! echo "$DNS_RESULT" 2>/dev/null | grep -q "$ING_IP"; then
  echo "2. Configure DNS A-record: $SITE_DOMAIN -> $ING_IP"
  echo "   Wait 5-15 minutes for DNS propagation"
fi

if [[ "$CERT_READY" != "True" ]] 2>/dev/null; then
  echo "3. After DNS is configured, certificate should be issued automatically"
  echo "   Monitor with: kubectl get certificate -n $NAMESPACE -w"
  echo "   Check challenges: kubectl get challenge -n $NAMESPACE"
fi

echo ""
echo "For more details, check:"
echo "  kubectl describe certificate -n $NAMESPACE"
echo "  kubectl describe challenge -n $NAMESPACE"
echo "  kubectl logs -n cert-manager -l app=cert-manager"

