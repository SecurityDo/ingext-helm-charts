#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Ingext GKE Installer
#
# Installs Ingext on Google Kubernetes Engine (GKE) following the instructions
# from https://github.com/SecurityDo/ingext-helm-charts
#
# Usage:
#   ./install-ingext-gke.sh \
#     --project my-gcp-project \
#     --region us-east1 \
#     --cluster-name ingext-gke \
#     --domain ingext.example.com \
#     --email admin@example.com
#
#   Or source the env file from preflight:
#   source ./ingext-gke.env
#   ./install-ingext-gke.sh
#
# Requirements:
#   - gcloud (Google Cloud CLI)
#   - kubectl
#   - helm
###############################################################################

# -------- Load from .env file if it exists (before parsing args) --------
ENV_FILE="${ENV_FILE:-./ingext-gke.env}"
if [[ -f "$ENV_FILE" ]]; then
  echo "Loading settings from $ENV_FILE"
  set +u # Temporarily allow unset variables
  source "$ENV_FILE" 2>/dev/null || true
  set -u # Re-enable strict mode
  echo "Loaded: PROJECT_ID=${PROJECT_ID:-not set}, REGION=${REGION:-not set}, CLUSTER_NAME=${CLUSTER_NAME:-not set}"
  echo ""
fi

print_help() {
  cat <<EOF
Ingext GKE Installer

Usage:
  ./install-ingext-gke.sh [options]

Required options:
  --project <project-id>      GCP project ID
  --region <region>           GCP region (e.g. us-east1, us-west1)
  --cluster-name <name>        GKE cluster name
  --domain <fqdn>              Public site domain (e.g. ingext.example.com)
  --email <email>              Email for certificate issuer

Optional options:
  --namespace <name>           Kubernetes namespace (default: ingext)
  --node-count <number>        Node count per zone (default: 2)
  --machine-type <type>        Machine type (default: e2-standard-4)
  --disk-size <size>           Boot disk size in GB per node (default: 20)
  --skip-gke-create            Skip GKE creation (use existing cluster)
  --vpc-network <name>         VPC network name (optional, uses default if not specified)
  --subnet <name>              Subnet name (optional)
  --help                       Show this help message and exit

Environment variables (optional, flags override):
  PROJECT_ID
  REGION
  CLUSTER_NAME
  SITE_DOMAIN
  CERT_EMAIL
  NAMESPACE
  NODE_COUNT
  MACHINE_TYPE
  DISK_SIZE
  VPC_NETWORK
  SUBNET

The script will automatically load values from ./ingext-gke.env if it exists.
You can also source the file manually: source ./ingext-gke.env

Example:
  ./install-ingext-gke.sh \\
    --project my-gcp-project \\
    --region us-east1 \\
    --cluster-name ingext-gke \\
    --domain ingext.example.com \\
    --email admin@example.com
EOF
}

# -------- Defaults (non-critical only) --------
NAMESPACE="${NAMESPACE:-ingext}"
NODE_COUNT="${NODE_COUNT:-2}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-standard-4}"
DISK_SIZE="${DISK_SIZE:-20}"
SKIP_GKE_CREATE=0
VPC_NETWORK="${VPC_NETWORK:-}"
SUBNET="${SUBNET:-}"

# -------- Parse arguments --------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="$2"
      shift 2
      ;;
    --region)
      REGION="$2"
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
    --machine-type)
      MACHINE_TYPE="$2"
      shift 2
      ;;
    --disk-size)
      DISK_SIZE="$2"
      shift 2
      ;;
    --skip-gke-create)
      SKIP_GKE_CREATE=1
      shift
      ;;
    --vpc-network)
      VPC_NETWORK="$2"
      shift 2
      ;;
    --subnet)
      SUBNET="$2"
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
: "${PROJECT_ID:?--project is required}"
: "${REGION:?--region is required}"
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
  # Wait for pods, but exclude Completed jobs (they don't have Ready condition)
  kubectl wait --for=condition=Ready pods --all -n "$ns" --timeout="$timeout" --field-selector=status.phase!=Succeeded || {
    # If wait fails, check if it's because of Completed jobs (which is OK)
    COMPLETED_JOBS=$(kubectl get pods -n "$ns" --field-selector=status.phase=Succeeded --no-headers 2>/dev/null | wc -l || echo "0")
    if [[ "$COMPLETED_JOBS" -gt 0 ]]; then
      log "Some pods are Completed (init jobs) - this is expected"
    fi
  }
  kubectl get pods -n "$ns" -o wide || true
}

# -------- Dependency checks --------
for bin in gcloud kubectl helm; do
  need "$bin"
done

# -------- Deployment summary --------
cat <<EOF

================ Deployment Plan ================
GCP Project:          $PROJECT_ID
GCP Region:           $REGION
GKE Cluster:          $CLUSTER_NAME
Node Count (per zone): $NODE_COUNT
Machine Type:         $MACHINE_TYPE
Disk Size:            ${DISK_SIZE}GB per node
Namespace:            $NAMESPACE
Site Domain:          $SITE_DOMAIN
Cert Email:           $CERT_EMAIL
Skip GKE Create:      $SKIP_GKE_CREATE
VPC Network:          ${VPC_NETWORK:-default}
Subnet:               ${SUBNET:-default}
================================================

EOF

read -rp "Proceed with deployment? (y/N): " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || {
  echo "Deployment cancelled."
  exit 2
}

# -------- Installation steps --------

log "GCP authentication (skipped if already authenticated)"
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" >/dev/null 2>&1; then
  gcloud auth login
fi

log "Set GCP project: $PROJECT_ID"
gcloud config set project "$PROJECT_ID"

# Enable required APIs
log "Enable required GCP APIs"
gcloud services enable container.googleapis.com compute.googleapis.com cloudresourcemanager.googleapis.com --project="$PROJECT_ID" 2>/dev/null || {
  echo "WARNING: Some APIs may already be enabled, continuing..."
}

if [[ "$SKIP_GKE_CREATE" == "1" ]]; then
  log "SKIP_GKE_CREATE=1 set, skipping gcloud container clusters create"
else
  log "Create GKE regional cluster: $CLUSTER_NAME"
  log "Using machine type: $MACHINE_TYPE"
  log "Regional cluster will have nodes in multiple zones for high availability"
  
  # Build cluster creation command
  CLUSTER_CMD="gcloud container clusters create $CLUSTER_NAME \
    --project=$PROJECT_ID \
    --region=$REGION \
    --num-nodes=$NODE_COUNT \
    --machine-type=$MACHINE_TYPE \
    --disk-size=$DISK_SIZE \
    --enable-ip-alias \
    --enable-autoscaling \
    --min-nodes=1 \
    --max-nodes=3 \
    --release-channel=regular"
  
  # Add VPC network if specified
  if [[ -n "$VPC_NETWORK" ]]; then
    CLUSTER_CMD="$CLUSTER_CMD --network=$VPC_NETWORK"
  fi
  
  # Add subnet if specified
  if [[ -n "$SUBNET" ]]; then
    CLUSTER_CMD="$CLUSTER_CMD --subnetwork=$SUBNET"
  fi
  
  GKE_OUTPUT=$(eval "$CLUSTER_CMD" 2>&1) || {
    
    if echo "$GKE_OUTPUT" | grep -q "already exists"; then
      echo "WARNING: GKE cluster already exists"
      echo "If cluster exists, use --skip-gke-create on next run"
    elif echo "$GKE_OUTPUT" | grep -q "quota\|QUOTA\|not available\|NOT_AVAILABLE"; then
      echo ""
      echo "ERROR: Quota exceeded or machine type not available in region."
      echo ""
      
      # Check for specific quota errors and provide targeted solutions
      if echo "$GKE_OUTPUT" | grep -q "SSD_TOTAL_GB\|Insufficient.*quota"; then
        echo "⚠️  SSD Storage Quota Issue Detected"
        echo ""
        echo "The cluster requires more SSD storage than your quota allows."
        echo "Regional clusters create nodes in multiple zones, multiplying storage needs."
        echo ""
        echo "Quick fixes (in order of preference):"
        echo "  1. Reduce node count (reduces total SSD requirements):"
        echo "     ./install-ingext-gke.sh --node-count 1"
        echo ""
        echo "  2. Reduce disk size per node (default is 100GB, you can use 10-30GB):"
        echo "     ./install-ingext-gke.sh --disk-size 20"
        echo "     (With 2 nodes/zone × 3 zones = 6 nodes × 20GB = 120GB total)"
        echo ""
        echo "  3. Use a smaller machine type (less storage per node):"
        echo "     ./install-ingext-gke.sh --machine-type e2-standard-2"
        echo "     or: ./install-ingext-gke.sh --machine-type e2-medium"
        echo ""
        echo "  4. Request quota increase (recommended for production):"
      echo "     a. Via Console:"
      echo "        https://console.cloud.google.com/iam-admin/quotas?usage=USED&project=$PROJECT_ID"
      echo "        - Filter for 'SSD_TOTAL_GB'"
      echo "        - Click 'EDIT QUOTAS' and request increase (e.g., 1000 GB)"
      echo "        - Provide justification: 'GKE regional cluster requires 600GB SSD'"
      echo "     b. Quota requests are typically approved within 24-48 hours"
      echo ""
      else
        echo "Common solutions:"
        echo "  1. Try a different machine type (other settings from env file will be used):"
        echo "     ./install-ingext-gke.sh --machine-type e2-standard-2"
        echo "     or: ./install-ingext-gke.sh --machine-type e2-medium"
        echo ""
        echo "  2. Reduce node count (reduces resource requirements):"
        echo "     ./install-ingext-gke.sh --node-count 1"
        echo ""
        echo "  3. Try a different region (other settings from env file will be used):"
        echo "     ./install-ingext-gke.sh --region us-west1"
        echo ""
      fi
      
      echo "  5. Check quota and available resources:"
      echo "     gcloud compute project-info describe --project=$PROJECT_ID"
      echo "     gcloud compute regions describe $REGION --project=$PROJECT_ID"
      echo ""
      echo "  6. View and manage quotas:"
      echo "     https://console.cloud.google.com/iam-admin/quotas?usage=USED&project=$PROJECT_ID"
      echo ""
      echo "  7. To see available machine types in this region:"
      echo "     ./list-machine-types.sh --region $REGION"
      echo ""
      echo "Note: If you're using the env file (ingext-gke.env), you only need to override"
      echo "      the problematic parameter - other settings will be loaded automatically."
      echo ""
      echo "Full error output:"
      echo "$GKE_OUTPUT"
      exit 1
    else
      echo "WARNING: GKE cluster creation may have failed"
      echo "Error output:"
      echo "$GKE_OUTPUT"
      echo ""
      echo "If cluster exists, use --skip-gke-create on next run"
    fi
  }
fi

log "Install gke-gcloud-auth-plugin (required for kubectl with GKE)"
if ! command -v gke-gcloud-auth-plugin >/dev/null 2>&1; then
  echo "Installing gke-gcloud-auth-plugin..."
  gcloud components install gke-gcloud-auth-plugin --quiet 2>&1 || {
    echo "WARNING: Failed to install gke-gcloud-auth-plugin automatically."
    echo "Please install it manually:"
    echo "  gcloud components install gke-gcloud-auth-plugin"
    echo "Or update gcloud: gcloud components update"
    echo ""
    echo "Then re-run the installer."
    exit 1
  }
fi

log "Get kubectl credentials"
gcloud container clusters get-credentials "$CLUSTER_NAME" --region="$REGION" --project="$PROJECT_ID"

log "Create namespace: $NAMESPACE"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

log "Create service account: ${NAMESPACE}-sa"
kubectl create serviceaccount "${NAMESPACE}-sa" -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

log "Install dependencies: Redis, OpenSearch, VictoriaMetrics"
helm upgrade --install ingext-stack oci://public.ecr.aws/ingext/ingext-stack -n "$NAMESPACE"

# setup token in app-secret for shell cli access
random_str=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 15 || true)
kubectl create secret generic app-secret \
    --namespace "$NAMESPACE" \
    --from-literal=token="tok_$random_str" \
    --dry-run=client -o yaml | kubectl apply -f -

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

log "Install cert-manager (required for GCP cert handling)"
helm repo add jetstack https://charts.jetstack.io >/dev/null
helm repo update >/dev/null
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set crds.enabled=true || {
  echo "ERROR: Failed to install cert-manager"
  echo "This is required for TLS certificate management"
  exit 1
}

wait_ns_pods_ready "cert-manager" "600s"

log "Install cert issuer (email=$CERT_EMAIL)"
helm upgrade --install ingext-community-certissuer oci://public.ecr.aws/ingext/ingext-community-certissuer \
  -n "$NAMESPACE" \
  --set "email=$CERT_EMAIL"

log "Clean up any existing certificate resources (prevent IncorrectIssuer issue)"
# Delete any existing TLS secret with wrong issuer annotation
TLS_SECRET="ingext-tls-secret"
if kubectl get secret "$TLS_SECRET" -n "$NAMESPACE" >/dev/null 2>&1; then
  ISSUER_ANNOTATION=$(kubectl get secret "$TLS_SECRET" -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.cert-manager\.io/issuer-name}' 2>/dev/null || echo "")
  CLUSTER_ISSUER_ANNOTATION=$(kubectl get secret "$TLS_SECRET" -n "$NAMESPACE" -o jsonpath='{.metadata.annotations.cert-manager\.io/cluster-issuer-name}' 2>/dev/null || echo "")
  
  if [[ -n "$ISSUER_ANNOTATION" ]] || [[ -z "$CLUSTER_ISSUER_ANNOTATION" ]] || [[ "$CLUSTER_ISSUER_ANNOTATION" != "letsencrypt-prod" ]]; then
    log "Deleting existing TLS secret with incorrect issuer annotation"
    kubectl delete secret "$TLS_SECRET" -n "$NAMESPACE" 2>/dev/null || true
  fi
fi

# Delete any existing certificate resources and challenges
kubectl delete challenge -n "$NAMESPACE" --all 2>/dev/null || true
CERT_NAME=$(kubectl get certificate -n "$NAMESPACE" -o name 2>/dev/null | head -1 || echo "")
if [[ -n "$CERT_NAME" ]]; then
  log "Deleting existing certificate resource (will be recreated by cert-manager)"
  kubectl delete "$CERT_NAME" -n "$NAMESPACE" 2>/dev/null || true
fi

log "Create static IP for Ingress"
STATIC_IP_NAME="${NAMESPACE}-static-ip"
# Check if static IP already exists
if gcloud compute addresses describe "$STATIC_IP_NAME" --global --project="$PROJECT_ID" >/dev/null 2>&1; then
  log "Static IP '$STATIC_IP_NAME' already exists, reusing it"
  STATIC_IP=$(gcloud compute addresses describe "$STATIC_IP_NAME" --global --project="$PROJECT_ID" --format="value(address)" 2>/dev/null || echo "")
  if [[ -n "$STATIC_IP" ]]; then
    log "Static IP address: $STATIC_IP"
  fi
else
  log "Creating new static IP: $STATIC_IP_NAME"
  gcloud compute addresses create "$STATIC_IP_NAME" --global --project="$PROJECT_ID" || {
    echo "ERROR: Failed to create static IP"
    exit 1
  }
  STATIC_IP=$(gcloud compute addresses describe "$STATIC_IP_NAME" --global --project="$PROJECT_ID" --format="value(address)" 2>/dev/null || echo "")
  if [[ -n "$STATIC_IP" ]]; then
    log "Created static IP: $STATIC_IP"
  fi
fi

log "Create BackendConfig for API service health checks"
# GKE Ingress only supports HTTP/HTTPS/HTTP2 health checks, not TCP
# Using HTTP health check on /api path
cat <<EOF | kubectl apply -f -
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
    type: HTTP
    port: 8002
    requestPath: /api
EOF

log "Wait for API service to exist before annotating"
# Wait up to 60 seconds for the API service to be created
for i in {1..12}; do
  if kubectl get service api -n "$NAMESPACE" >/dev/null 2>&1; then
    log "API service found, annotating with BackendConfig"
    kubectl annotate service api -n "$NAMESPACE" \
      cloud.google.com/backend-config='{"default": "api-backend-config"}' \
      --overwrite 2>/dev/null && break || {
      echo "WARNING: Failed to annotate API service, but continuing..."
      break
    }
  fi
  if [[ $i -lt 12 ]]; then
    sleep 5
  else
    echo "WARNING: API service not found after 60 seconds, annotation will be skipped"
    echo "You may need to annotate it manually after the service is created"
  fi
done

log "Verify BackendConfig exists before creating ingress"
if ! kubectl get backendconfig api-backend-config -n "$NAMESPACE" >/dev/null 2>&1; then
  echo "ERROR: BackendConfig 'api-backend-config' not found in namespace '$NAMESPACE'"
  echo "This should have been created in the previous step."
  exit 1
fi

log "Install GCP ingress (siteDomain=$SITE_DOMAIN)"
# Use local chart since it's not yet published to ECR
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
else
  echo "ERROR: GCP ingress chart not found at $CHART_DIR"
  echo "Please ensure you're running from the ingext-helm-charts repository root"
  exit 1
fi

log "Show ingresses"
kubectl get ingress -n "$NAMESPACE" -o wide || true

log "Try to determine public IP from ingress (may take a few minutes to populate)"
ING_IP=""
# Try multiple times as IP assignment can take 2-5 minutes
for i in {1..6}; do
  ING_IP="$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)"
  if [[ -n "$ING_IP" ]]; then
    log "Ingress IP detected: $ING_IP"
    break
  fi
  if [[ $i -lt 6 ]]; then
    log "Waiting for IP assignment (attempt $i/6)..."
    sleep 30
  fi
done

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
  echo "  ./status-ingext-gke.sh --namespace $NAMESPACE"
  echo ""
  echo "Then create a DNS A-record:"
  echo "  $SITE_DOMAIN  ->  <PUBLIC_IP>"
fi

echo ""
echo "Useful commands:"
echo "  # Check installation status"
echo "  ./status-ingext-gke.sh --namespace $NAMESPACE"
echo ""
echo "  # Check DNS and certificate status"
echo "  ./dns-ingext-gke.sh --domain $SITE_DOMAIN --namespace $NAMESPACE"
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

