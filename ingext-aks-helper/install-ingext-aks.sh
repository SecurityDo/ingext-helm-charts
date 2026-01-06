#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Ingext AKS Installer
#
# Installs Ingext on Azure Kubernetes Service (AKS) following the instructions
# from https://github.com/SecurityDo/ingext-helm-charts
#
# Usage:
#   ./install-ingext-aks.sh \
#     --location eastus \
#     --resource-group ingext-rg \
#     --cluster-name ingext-aks \
#     --domain ingext.example.com \
#     --email admin@example.com
#
# Requirements:
#   - az (Azure CLI)
#   - kubectl
#   - helm
###############################################################################

print_help() {
  cat <<EOF
Ingext AKS Installer

Usage:
  ./install-ingext-aks.sh [options]

Required options:
  --location <azure-region>        Azure region (e.g. eastus, westus2)
  --resource-group <name>          Azure resource group name
  --cluster-name <name>            AKS cluster name
  --domain <fqdn>                  Public site domain (e.g. ingext.example.com)
  --email <email>                  Email for certificate issuer

Optional options:
  --namespace <name>               Kubernetes namespace (default: ingext)
  --node-count <number>            AKS node count (default: 2)
  --node-vm-size <size>            AKS node VM size (default: Standard_D2s_v3)
  --skip-aks-create                Skip AKS creation (use existing cluster)
  --help                           Show this help message and exit

Environment variables (optional, flags override):
  LOCATION
  RESOURCE_GROUP
  CLUSTER_NAME
  SITE_DOMAIN
  CERT_EMAIL
  NAMESPACE
  NODE_COUNT

Example:
  ./install-ingext-aks.sh \\
    --location eastus \\
    --resource-group ingext-rg \\
    --cluster-name ingext-aks \\
    --domain ingext.example.com \\
    --email admin@example.com
EOF
}

# -------- Defaults (non-critical only) --------
NAMESPACE="${NAMESPACE:-ingext}"
NODE_COUNT="${NODE_COUNT:-2}"
NODE_VM_SIZE="${NODE_VM_SIZE:-Standard_D4as_v5}"
SKIP_AKS_CREATE=0
APPGW_NAME="${APPGW_NAME:-ingext-agw}"
APPGW_SUBNET_CIDR="${APPGW_SUBNET_CIDR:-10.225.0.0/16}"

# -------- Parse arguments --------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --location)
      LOCATION="$2"
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
    --domain)
      SITE_DOMAIN="$2"
      shift 2
      ;;
    --email)
      CERT_EMAIL="$2"
      shift 2
      ;;
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --node-count)
      NODE_COUNT="$2"
      shift 2
      ;;
    --node-vm-size)
      NODE_VM_SIZE="$2"
      shift 2
      ;;
    --skip-aks-create)
      SKIP_AKS_CREATE=1
      shift
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
: "${LOCATION:?--location is required}"
: "${RESOURCE_GROUP:?--resource-group is required}"
: "${CLUSTER_NAME:?--cluster-name is required}"
: "${SITE_DOMAIN:?--domain is required}"
: "${CERT_EMAIL:?--email is required}"

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

wait_ns_pods_ready() {
  local ns="$1"
  local timeout="${2:-900s}"
  log "Waiting for pods in namespace '$ns' to be Ready (timeout $timeout)"
  kubectl wait --for=condition=Ready pods --all -n "$ns" --timeout="$timeout" || true
  kubectl get pods -n "$ns" -o wide || true
}

# -------- Dependency checks --------
for bin in az kubectl helm; do
  need "$bin"
done

# -------- Deployment summary --------
cat <<EOF

================ Deployment Plan ================
Azure Region:        $LOCATION
Resource Group:      $RESOURCE_GROUP
AKS Cluster:         $CLUSTER_NAME
Node Count:          $NODE_COUNT
Node VM Size:        $NODE_VM_SIZE
Namespace:           $NAMESPACE
Site Domain:         $SITE_DOMAIN
Cert Email:          $CERT_EMAIL
Skip AKS Create:     $SKIP_AKS_CREATE
================================================

EOF

read -rp "Proceed with deployment? (y/N): " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || {
  echo "Deployment cancelled."
  exit 2
}

# -------- Installation steps --------

log "Azure login (skipped if already logged in)"
if ! az account show >/dev/null 2>&1; then
  az login
fi

log "Create resource group: $RESOURCE_GROUP in $LOCATION"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" >/dev/null || {
  echo "WARNING: Resource group may already exist, continuing..."
}

if [[ "$SKIP_AKS_CREATE" == "1" ]]; then
  log "SKIP_AKS_CREATE=1 set, skipping az aks create"
else
  log "Create AKS cluster: $CLUSTER_NAME (App Gateway enabled)"
  log "Using VM size: $NODE_VM_SIZE"
  
  AKS_OUTPUT=$(az aks create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER_NAME" \
    --location "$LOCATION" \
    --node-count "$NODE_COUNT" \
    --node-vm-size "$NODE_VM_SIZE" \
    --generate-ssh-keys \
    --network-plugin azure \
    --enable-addons ingress-appgw \
    --appgw-name "$APPGW_NAME" \
    --appgw-subnet-cidr "$APPGW_SUBNET_CIDR" 2>&1) || {
    
    if echo "$AKS_OUTPUT" | grep -q "VM size.*is not allowed"; then
      echo ""
      echo "ERROR: VM size '$NODE_VM_SIZE' is not available for AKS in your subscription."
      echo ""
      echo "NOTE: AKS has different restrictions than general VM availability."
      echo "The error message above shows the ACTUAL available sizes for AKS."
      echo ""
      
      # Try to extract available sizes from the error message
      AVAILABLE_SIZES=$(echo "$AKS_OUTPUT" | grep -oP "The available VM sizes are '[^']*'" | sed "s/The available VM sizes are '//;s/'$//" | tr ',' '\n' | sed 's/^[[:space:]]*//' | head -n 20 || true)
      
      if [[ -n "$AVAILABLE_SIZES" ]]; then
        echo "Available VM sizes for AKS in your subscription:"
        echo "$AVAILABLE_SIZES" | while read -r size; do
          if [[ -n "$size" ]]; then
            echo "  - $size"
          fi
        done
        echo ""
        echo "Try one of these sizes. Common recommendations:"
        echo "$AVAILABLE_SIZES" | grep -E "standard_dc[248]ds_v3|standard_dc[248]s_v3|standard_m[0-9]+s_v2" | head -n 5 | while read -r size; do
          if [[ -n "$size" ]]; then
            echo "  ./install-ingext-aks.sh --node-vm-size $size"
          fi
        done
      else
        echo "To find available sizes, check the full error message above."
        echo "Look for the line starting with 'The available VM sizes are'"
        echo ""
        echo "Or try common alternatives:"
        echo "  ./install-ingext-aks.sh --node-vm-size standard_dc2ds_v3"
        echo "  ./install-ingext-aks.sh --node-vm-size standard_dc4ds_v3"
        echo "  ./install-ingext-aks.sh --node-vm-size standard_m64s_v2"
      fi
      
      echo ""
      echo "To see all VM sizes (general availability, not AKS-specific):"
      echo "  ./list-vm-sizes.sh --location $LOCATION"
      exit 1
    elif echo "$AKS_OUTPUT" | grep -q "already exists"; then
      echo "WARNING: AKS cluster already exists"
      echo "If cluster exists, use --skip-aks-create on next run"
    else
      echo "WARNING: AKS cluster creation may have failed"
      echo "Error output:"
      echo "$AKS_OUTPUT"
      echo ""
      echo "If cluster exists, use --skip-aks-create on next run"
    fi
  }
fi

log "Get kubectl credentials"
az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --overwrite-existing

log "Create namespace: $NAMESPACE"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

log "Install dependencies: Redis, OpenSearch, VictoriaMetrics"
helm upgrade --install ingext-stack oci://public.ecr.aws/ingext/ingext-stack -n "$NAMESPACE"

log "Install etcd single node"
helm upgrade --install etcd-single oci://public.ecr.aws/ingext/etcd-single -n "$NAMESPACE"

log "Install etcd defrag cronjob"
helm upgrade --install etcd-single-cronjob oci://public.ecr.aws/ingext/etcd-single-cronjob -n "$NAMESPACE"

wait_ns_pods_ready "$NAMESPACE" "900s"

log "Install Ingext config (siteDomain=$SITE_DOMAIN)"
helm upgrade --install ingext-community-config oci://public.ecr.aws/ingext/ingext-community-config \
  -n "$NAMESPACE" \
  --set "siteDomain=$SITE_DOMAIN"

log "Run initialization jobs"
helm upgrade --install ingext-community-init oci://public.ecr.aws/ingext/ingext-community-init -n "$NAMESPACE"

log "Install main application"
helm upgrade --install ingext-community oci://public.ecr.aws/ingext/ingext-community -n "$NAMESPACE"

wait_ns_pods_ready "$NAMESPACE" "1200s"

log "Install cert-manager (required for Azure cert handling)"
helm repo add jetstack https://charts.jetstack.io >/dev/null
helm repo update >/dev/null
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true

wait_ns_pods_ready "cert-manager" "600s"

log "Install cert issuer (email=$CERT_EMAIL)"
helm upgrade --install ingext-community-certissuer oci://public.ecr.aws/ingext/ingext-community-certissuer \
  -n "$NAMESPACE" \
  --set "email=$CERT_EMAIL"

log "Install Azure ingress (siteDomain=$SITE_DOMAIN)"
helm upgrade --install ingext-community-ingress-azure oci://public.ecr.aws/ingext/ingext-community-ingress-azure \
  -n "$NAMESPACE" \
  --set "siteDomain=$SITE_DOMAIN"

log "Show ingresses"
kubectl get ingress -n "$NAMESPACE" -o wide || true

log "Try to determine public IP from ingress (may take a few minutes to populate)"
ING_IP="$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"

echo ""
echo "=========================================="
echo "Installation Complete!"
echo "=========================================="
echo ""

if [[ -n "${ING_IP:-}" ]]; then
  echo "Ingress public IP detected: $ING_IP"
  echo ""
  echo "Next step: create a DNS A-record:"
  echo "  $SITE_DOMAIN  ->  $ING_IP"
else
  echo "Ingress IP not available yet."
  echo "Run this until an IP shows up:"
  echo "  kubectl get ingress -n $NAMESPACE -o wide"
  echo ""
  echo "Or use the status script:"
  echo "  ./status-ingext-aks.sh --namespace $NAMESPACE"
  echo ""
  echo "Then create a DNS A-record:"
  echo "  $SITE_DOMAIN  ->  <PUBLIC_IP>"
fi

echo ""
echo "Useful commands:"
echo "  # Check installation status"
echo "  ./status-ingext-aks.sh --namespace $NAMESPACE"
echo ""
echo "  # Check DNS and certificate status"
echo "  ./dns-ingext-aks.sh --domain $SITE_DOMAIN --namespace $NAMESPACE"
echo ""
echo "Certificate troubleshooting:"
echo "  kubectl get certificate -n $NAMESPACE"
echo "  kubectl get challenge -n $NAMESPACE"
echo "  kubectl describe challenge -n $NAMESPACE"
echo ""
echo "After DNS is set and cert is issued, open:"
echo "  https://$SITE_DOMAIN"
echo ""
echo "Login credentials:"
echo "  user: admin@ingext.io"
echo "  pass: ingext"
echo ""
echo "View logs:"
echo "  kubectl logs -n $NAMESPACE -f ingext-api-0"
echo "  kubectl logs -n $NAMESPACE -f ingext-platform-0"
echo ""

