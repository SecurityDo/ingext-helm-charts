#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Recreate GKE Ingress
#
# Recreates the ingress and associated resources if they were accidentally
# deleted. This script assumes the cluster and core services are already
# installed and running.
#
# Usage:
#   ./recreate-ingress.sh [--namespace ingext] [--domain gcp.k8.ingext.io]
#
# Requirements:
#   - kubectl
#   - helm
#   - gcloud (for static IP)
###############################################################################

print_help() {
  cat <<EOF
Recreate GKE Ingress

Usage:
  ./recreate-ingress.sh [options]

Optional options:
  --namespace <name>               Kubernetes namespace (default: ingext)
  --domain <fqdn>                  Public site domain (default: from ingext-gke.env)
  --static-ip-name <name>          Static IP name (default: ingext-static-ip)
  --help                           Show this help message and exit

Environment variables (optional, flags override):
  NAMESPACE
  SITE_DOMAIN
  STATIC_IP_NAME

Example:
  ./recreate-ingress.sh --namespace ingext --domain gcp.k8.ingext.io
EOF
}

# -------- Defaults --------
NAMESPACE="${NAMESPACE:-ingext}"
STATIC_IP_NAME="${STATIC_IP_NAME:-ingext-static-ip}"

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
    --static-ip-name)
      STATIC_IP_NAME="$2"
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
  echo "Make sure kubectl is configured correctly"
  exit 1
fi

# -------- Check namespace exists --------
if ! kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  echo "ERROR: Namespace '$NAMESPACE' does not exist"
  echo "Please run the installer first: ./install-ingext-gke.sh"
  exit 1
fi

# -------- Check API service exists --------
log "Verify API service exists"
if ! kubectl get service api -n "$NAMESPACE" >/dev/null 2>&1; then
  echo "ERROR: API service not found in namespace '$NAMESPACE'"
  echo "Please ensure the core installation is complete"
  exit 1
fi

# -------- Check BackendConfig exists --------
log "Verify BackendConfig exists"
if ! kubectl get backendconfig api-backend-config -n "$NAMESPACE" >/dev/null 2>&1; then
  log "BackendConfig not found, creating it"
  kubectl apply -f - <<EOF
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
    type: TCP
    port: 8002
EOF
  echo "BackendConfig created"
else
  echo "BackendConfig already exists"
fi

# -------- Annotate API service --------
log "Annotate API service with BackendConfig"
kubectl annotate service api -n "$NAMESPACE" \
  cloud.google.com/backend-config='{"default": "api-backend-config"}' \
  --overwrite || {
  echo "WARNING: Failed to annotate service (may already be annotated)"
}

# -------- Check/create static IP --------
log "Check static IP: $STATIC_IP_NAME"
if ! gcloud compute addresses describe "$STATIC_IP_NAME" --global >/dev/null 2>&1; then
  log "Static IP not found, creating it"
  gcloud compute addresses create "$STATIC_IP_NAME" --global || {
    echo "ERROR: Failed to create static IP"
    exit 1
  }
  echo "Static IP created"
else
  STATIC_IP=$(gcloud compute addresses describe "$STATIC_IP_NAME" --global --format="value(address)")
  echo "Static IP exists: $STATIC_IP"
fi

# -------- Install ingress chart --------
log "Install GCP ingress (siteDomain=$SITE_DOMAIN)"
CHART_DIR="$SCRIPT_DIR/../charts/ingext-community-ingress-gcp"
if [[ -d "$CHART_DIR" ]]; then
  helm upgrade --install ingext-community-ingress-gcp "$CHART_DIR" \
    -n "$NAMESPACE" \
    --set "siteDomain=$SITE_DOMAIN" \
    --set "ingress.staticIpName=$STATIC_IP_NAME" || {
    echo "ERROR: Failed to install ingress chart"
    echo "Check that:"
    echo "  1. BackendConfig exists: kubectl get backendconfig -n $NAMESPACE"
    echo "  2. API service exists: kubectl get service api -n $NAMESPACE"
    echo "  3. Chart directory exists: $CHART_DIR"
    exit 1
  }
  echo "Ingress chart installed"
else
  echo "ERROR: GCP ingress chart not found at $CHART_DIR"
  echo "Please ensure you're running from the ingext-helm-charts repository root"
  exit 1
fi

# -------- Show ingress status --------
log "Show ingress status"
kubectl get ingress -n "$NAMESPACE" -o wide || true

# -------- Wait for IP assignment --------
log "Wait for ingress IP assignment (may take 2-5 minutes)"
ING_IP=""
for i in {1..30}; do
  ING_IP=$(kubectl get ingress ingext-ingress -n "$NAMESPACE" -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || echo "")
  if [[ -n "$ING_IP" ]]; then
    break
  fi
  echo "Waiting for IP assignment... ($i/30)"
  sleep 10
done

if [[ -n "$ING_IP" ]]; then
  echo ""
  color_green "Ingress IP: $ING_IP"
  echo ""
  echo "Next steps:"
  echo "1. Configure DNS A-record: $SITE_DOMAIN -> $ING_IP"
  echo "2. Wait for DNS propagation (5-15 minutes)"
  echo "3. Check certificate status: kubectl get certificate -n $NAMESPACE"
  echo "4. Monitor certificate challenges: kubectl get challenge -n $NAMESPACE"
else
  color_yellow "Ingress IP not yet assigned"
  echo "This is normal - it can take 2-5 minutes for GKE to assign the IP"
  echo "Check status with: kubectl get ingress ingext-ingress -n $NAMESPACE"
fi

echo ""
color_green "Ingress recreation complete!"


