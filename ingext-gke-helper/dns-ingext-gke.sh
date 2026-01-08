#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Ingext GKE DNS Helper
#
# Helps with DNS configuration and verification for Ingext on GKE.
# Gets the ingress public IP, checks DNS resolution, and monitors
# certificate challenge status.
#
# Usage:
#   ./dns-ingext-gke.sh --domain ingext.example.com [--namespace ingext]
#
# Requirements:
#   - kubectl
#   - nslookup or dig (for DNS resolution checks)
###############################################################################

print_help() {
  cat <<EOF
Ingext GKE DNS Helper

Usage:
  ./dns-ingext-gke.sh [options]

Required options:
  --domain <fqdn>                  Public site domain (e.g. ingext.example.com)

Optional options:
  --namespace <name>               Kubernetes namespace (default: ingext)
  --wait                           Wait until DNS is properly configured
  --wait-timeout <seconds>         Timeout for --wait (default: 300)
  --help                           Show this help message and exit

Environment variables (optional, flags override):
  SITE_DOMAIN
  NAMESPACE

Example:
  ./dns-ingext-gke.sh --domain ingext.example.com
  ./dns-ingext-gke.sh --domain ingext.example.com --wait
EOF
}

# -------- Defaults --------
NAMESPACE="${NAMESPACE:-ingext}"
WAIT_MODE=0
WAIT_TIMEOUT="${WAIT_TIMEOUT:-300}"

# -------- Parse arguments --------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      SITE_DOMAIN="$2"
      shift 2
      ;;
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --wait)
      WAIT_MODE=1
      shift
      ;;
    --wait-timeout)
      WAIT_TIMEOUT="$2"
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

# -------- Required arguments validation --------
: "${SITE_DOMAIN:?--domain is required}"

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

check_dns_resolution() {
  local domain="$1"
  local expected_ip="$2"
  
  # Try dig first, fall back to nslookup
  if command -v dig >/dev/null 2>&1; then
    RESOLVED_IP=$(dig +short "$domain" 2>/dev/null | head -n1 || echo "")
  elif command -v nslookup >/dev/null 2>&1; then
    RESOLVED_IP=$(nslookup "$domain" 2>/dev/null | grep -A1 "Name:" | grep "Address:" | awk '{print $2}' | head -n1 || echo "")
  else
    echo "$(color_yellow "Neither dig nor nslookup available, skipping DNS resolution check")"
    return 1
  fi
  
  if [[ -z "$RESOLVED_IP" ]]; then
    return 1
  fi
  
  if [[ "$RESOLVED_IP" == "$expected_ip" ]]; then
    return 0
  else
    return 1
  fi
}

# -------- Dependency checks --------
need kubectl

# -------- Check kubectl connectivity --------
if ! kubectl cluster-info >/dev/null 2>&1; then
  echo "ERROR: Cannot connect to Kubernetes cluster"
  echo "Make sure kubectl is configured correctly"
  exit 1
fi

# -------- Get Ingress Public IP --------
log "Getting ingress public IP from cluster"
ING_IP=$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)

if [[ -z "$ING_IP" ]]; then
  echo "$(color_red "ERROR: Could not get ingress public IP")"
  echo ""
  echo "Possible reasons:"
  echo "  1. Ingress not yet created"
  echo "  2. Load balancer still provisioning"
  echo "  3. Wrong namespace specified"
  echo ""
  echo "Check ingress status:"
  echo "  kubectl get ingress -n $NAMESPACE -o wide"
  exit 1
fi

echo "Ingress Public IP: $(color_green "$ING_IP")"

# -------- DNS Configuration Instructions --------
log "DNS Configuration"
echo "Domain: $SITE_DOMAIN"
echo ""
echo "Create a DNS A-record:"
echo "  $SITE_DOMAIN  ->  $ING_IP"
echo ""
echo "DNS record type: A"
echo "Name: $SITE_DOMAIN (or @ if configuring root domain)"
echo "Value: $ING_IP"
echo "TTL: 300 (or your provider's default)"

# -------- Check Current DNS Resolution --------
log "Current DNS Resolution Status"
if check_dns_resolution "$SITE_DOMAIN" "$ING_IP"; then
  echo "$(color_green "✓ DNS is correctly configured")"
  echo "  $SITE_DOMAIN resolves to $ING_IP"
  DNS_READY=1
else
  RESOLVED_IP=$(dig +short "$SITE_DOMAIN" 2>/dev/null | head -n1 || nslookup "$SITE_DOMAIN" 2>/dev/null | grep -A1 "Name:" | grep "Address:" | awk '{print $2}' | head -n1 || echo "N/A")
  if [[ -z "$RESOLVED_IP" ]] || [[ "$RESOLVED_IP" == "N/A" ]]; then
    echo "$(color_yellow "✗ DNS not yet configured or not propagated")"
    echo "  $SITE_DOMAIN does not resolve"
  else
    echo "$(color_red "✗ DNS points to wrong IP")"
    echo "  $SITE_DOMAIN resolves to $RESOLVED_IP (expected $ING_IP)"
  fi
  DNS_READY=0
fi

# -------- Certificate Challenge Status --------
log "Certificate Challenge Status"
if kubectl get crd certificates.cert-manager.io >/dev/null 2>&1; then
  CHALLENGES=$(kubectl get challenge -n "$NAMESPACE" 2>/dev/null || true)
  if [[ -n "$CHALLENGES" ]] && echo "$CHALLENGES" | grep -q "NAME"; then
    echo "$CHALLENGES"
    echo ""
    PENDING=$(kubectl get challenge -n "$NAMESPACE" --no-headers 2>/dev/null | grep -c "pending\|processing" || echo "0")
    if [[ "$PENDING" -gt 0 ]]; then
      echo "$(color_yellow "Active challenges: $PENDING")"
      echo "Certificate issuance may be waiting for DNS propagation"
    else
      echo "$(color_green "No pending challenges")"
    fi
  else
    echo "$(color_green "No active challenges")"
  fi
  
  CERT_STATUS=$(kubectl get certificate -n "$NAMESPACE" -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "Unknown")
  if [[ "$CERT_STATUS" == "True" ]]; then
    echo "Certificate Ready: $(color_green "Yes")"
  else
    echo "Certificate Ready: $(color_yellow "No")"
    if [[ "$DNS_READY" == "0" ]]; then
      echo "  Certificate cannot be issued until DNS is configured correctly"
    fi
  fi
else
  echo "$(color_yellow "cert-manager CRDs not found")"
fi

# -------- Wait Mode --------
if [[ "$WAIT_MODE" == "1" ]]; then
  log "Waiting for DNS to be configured (timeout: ${WAIT_TIMEOUT}s)"
  START_TIME=$(date +%s)
  ELAPSED=0
  
  while [[ $ELAPSED -lt $WAIT_TIMEOUT ]]; do
    if check_dns_resolution "$SITE_DOMAIN" "$ING_IP"; then
      echo ""
      echo "$(color_green "✓ DNS is now correctly configured!")"
      echo "  $SITE_DOMAIN resolves to $ING_IP"
      exit 0
    fi
    
    sleep 5
    ELAPSED=$(($(date +%s) - START_TIME))
    echo -n "."
  done
  
  echo ""
  echo "$(color_red "Timeout waiting for DNS configuration")"
  echo "DNS may still be propagating. Check again later."
  exit 1
fi

# -------- Summary --------
echo ""
echo "=========================================="
echo "DNS Status Summary"
echo "=========================================="
echo "Domain: $SITE_DOMAIN"
echo "Expected IP: $ING_IP"
if [[ "$DNS_READY" == "1" ]]; then
  echo "DNS Status: $(color_green "Configured")"
else
  echo "DNS Status: $(color_yellow "Not configured or not propagated")"
fi
echo ""
echo "Next steps:"
if [[ "$DNS_READY" == "0" ]]; then
  echo "  1. Create DNS A-record: $SITE_DOMAIN -> $ING_IP"
  echo "  2. Wait for DNS propagation (usually 5-15 minutes)"
  echo "  3. Run this script again to verify:"
  echo "     ./dns-ingext-gke.sh --domain $SITE_DOMAIN --namespace $NAMESPACE"
  echo "  4. Or use --wait flag to monitor:"
  echo "     ./dns-ingext-gke.sh --domain $SITE_DOMAIN --namespace $NAMESPACE --wait"
else
  echo "  ✓ DNS is configured correctly"
  echo "  Certificate should be issued automatically by cert-manager"
  echo "  Check certificate status:"
  echo "    kubectl get certificate -n $NAMESPACE"
fi
echo ""
echo "After DNS is configured and certificate is issued:"
echo "  https://$SITE_DOMAIN"
echo ""


