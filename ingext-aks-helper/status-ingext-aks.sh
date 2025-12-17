#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Ingext AKS Status Checker
#
# Checks the status of Ingext installation on AKS, including cluster status,
# Helm releases, pods, ingress, certificates, and services.
#
# Usage:
#   ./status-ingext-aks.sh [--namespace ingext]
#
# Requirements:
#   - az (Azure CLI)
#   - kubectl
#   - helm
###############################################################################

print_help() {
  cat <<EOF
Ingext AKS Status Checker

Usage:
  ./status-ingext-aks.sh [options]

Optional options:
  --namespace <name>               Kubernetes namespace (default: ingext)
  --resource-group <name>           Azure resource group name (for cluster status)
  --cluster-name <name>             AKS cluster name (for cluster status)
  --help                           Show this help message and exit

Environment variables (optional, flags override):
  NAMESPACE
  RESOURCE_GROUP
  CLUSTER_NAME

Example:
  ./status-ingext-aks.sh --namespace ingext
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
    --resource-group)
      RESOURCE_GROUP="$2"
      shift 2
      ;;
    --cluster-name)
      CLUSTER_NAME="$2"
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

check_status() {
  local status="$1"
  if [[ "$status" == "Running" ]] || [[ "$status" == "Ready" ]] || [[ "$status" == "Succeeded" ]]; then
    color_green "$status"
  elif [[ "$status" == "Pending" ]] || [[ "$status" == "ContainerCreating" ]] || [[ "$status" == "Init" ]]; then
    color_yellow "$status"
  else
    color_red "$status"
  fi
}

# -------- Dependency checks --------
for bin in kubectl helm; do
  need "$bin"
done

# -------- Check kubectl connectivity --------
if ! kubectl cluster-info >/dev/null 2>&1; then
  echo "ERROR: Cannot connect to Kubernetes cluster"
  echo "Make sure kubectl is configured correctly"
  exit 1
fi

# -------- AKS Cluster Status --------
if [[ -n "${RESOURCE_GROUP:-}" ]] && [[ -n "${CLUSTER_NAME:-}" ]]; then
  need az
  log "AKS Cluster Status"
  if az account show >/dev/null 2>&1; then
    CLUSTER_STATUS=$(az aks show --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --query "powerState.code" -o tsv 2>/dev/null || echo "Unknown")
    if [[ "$CLUSTER_STATUS" == "Running" ]]; then
      echo "Cluster: $(color_green "$CLUSTER_NAME") - $(color_green "$CLUSTER_STATUS")"
    else
      echo "Cluster: $(color_red "$CLUSTER_NAME") - $(color_red "$CLUSTER_STATUS")"
    fi
  else
    echo "Not logged in to Azure, skipping cluster status check"
  fi
fi

# -------- Namespace Check --------
log "Namespace: $NAMESPACE"
if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
  echo "Namespace exists: $(color_green "Yes")"
else
  echo "Namespace exists: $(color_red "No")"
  echo "Installation may not be complete or namespace is different"
  exit 1
fi

# -------- Helm Releases --------
log "Helm Releases in namespace '$NAMESPACE'"
if helm list -n "$NAMESPACE" 2>/dev/null | grep -q "NAME"; then
  helm list -n "$NAMESPACE"
else
  echo "$(color_yellow "No Helm releases found")"
fi

# -------- Pod Status --------
log "Pod Status in namespace '$NAMESPACE'"
PODS=$(kubectl get pods -n "$NAMESPACE" -o wide 2>/dev/null || true)
if [[ -n "$PODS" ]]; then
  echo "$PODS"
  echo ""
  echo "Pod Status Summary:"
  READY_COUNT=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null | grep -c "Running" || echo "0")
  TOTAL_COUNT=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$READY_COUNT" == "$TOTAL_COUNT" ]] && [[ "$TOTAL_COUNT" -gt 0 ]]; then
    echo "  Ready: $(color_green "$READY_COUNT/$TOTAL_COUNT")"
  elif [[ "$TOTAL_COUNT" -gt 0 ]]; then
    echo "  Ready: $(color_yellow "$READY_COUNT/$TOTAL_COUNT")"
  else
    echo "  Ready: $(color_red "0/0")"
  fi
else
  echo "$(color_red "No pods found")"
fi

# -------- Ingress Status --------
log "Ingress Status"
INGRESS=$(kubectl get ingress -n "$NAMESPACE" -o wide 2>/dev/null || true)
if [[ -n "$INGRESS" ]]; then
  echo "$INGRESS"
  echo ""
  ING_IP=$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
  ING_HOST=$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].spec.rules[0].host}' 2>/dev/null || true)
  if [[ -n "$ING_IP" ]]; then
    echo "Public IP: $(color_green "$ING_IP")"
  else
    echo "Public IP: $(color_yellow "Not yet assigned")"
  fi
  if [[ -n "$ING_HOST" ]]; then
    echo "Domain: $ING_HOST"
  fi
else
  echo "$(color_yellow "No ingress found")"
fi

# -------- Certificate Status --------
log "Certificate Status (cert-manager)"
if kubectl get crd certificates.cert-manager.io >/dev/null 2>&1; then
  CERTS=$(kubectl get certificate -n "$NAMESPACE" 2>/dev/null || true)
  if [[ -n "$CERTS" ]] && echo "$CERTS" | grep -q "NAME"; then
    echo "$CERTS"
    echo ""
    CERT_READY=$(kubectl get certificate -n "$NAMESPACE" -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "Unknown")
    if [[ "$CERT_READY" == "True" ]]; then
      echo "Certificate Ready: $(color_green "Yes")"
    else
      echo "Certificate Ready: $(color_yellow "No")"
      echo "Check challenges: kubectl get challenge -n $NAMESPACE"
    fi
  else
    echo "$(color_yellow "No certificates found")"
  fi
else
  echo "$(color_yellow "cert-manager CRDs not found")"
fi

# -------- Service Status --------
log "Service Status"
SERVICES=$(kubectl get svc -n "$NAMESPACE" 2>/dev/null || true)
if [[ -n "$SERVICES" ]]; then
  echo "$SERVICES"
else
  echo "$(color_yellow "No services found")"
fi

# -------- Summary --------
echo ""
echo "=========================================="
echo "Status Check Complete"
echo "=========================================="
echo ""
echo "Useful commands:"
echo "  # View pod logs"
echo "  kubectl logs -n $NAMESPACE -f ingext-api-0"
echo "  kubectl logs -n $NAMESPACE -f ingext-platform-0"
echo ""
echo "  # Check certificate challenges"
echo "  kubectl get challenge -n $NAMESPACE"
echo "  kubectl describe challenge -n $NAMESPACE"
echo ""
echo "  # Check DNS status"
echo "  ./dns-ingext-aks.sh --namespace $NAMESPACE"
echo ""

