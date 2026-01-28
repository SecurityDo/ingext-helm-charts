#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Ingext GKE Installer
#
# Installs Ingext on Google Kubernetes Engine (GKE) following the instructions
# from https://github.com/SecurityDo/ingext-helm-charts
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

k8sProvider=gcp
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
    echo "💡 TIP: Run './start-docker-shell.sh' or './ingext-gcp-shell.sh' to launch a pre-configured toolbox."
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
  kubectl wait --for=condition=Ready pods --all -n "$ns" --timeout="$timeout" --field-selector=status.phase!=Succeeded || true
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
gcloud services enable container.googleapis.com compute.googleapis.com cloudresourcemanager.googleapis.com --project="$PROJECT_ID" 2>/dev/null || true

if [[ "$SKIP_GKE_CREATE" == "1" ]]; then
  log "SKIP_GKE_CREATE=1 set, skipping gcloud container clusters create"
else
  log "Create GKE regional cluster: $CLUSTER_NAME"
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
  
  if [[ -n "$VPC_NETWORK" ]]; then CLUSTER_CMD="$CLUSTER_CMD --network=$VPC_NETWORK"; fi
  if [[ -n "$SUBNET" ]]; then CLUSTER_CMD="$CLUSTER_CMD --subnetwork=$SUBNET"; fi
  
  GKE_OUTPUT=$(eval "$CLUSTER_CMD" 2>&1) || {
    if echo "$GKE_OUTPUT" | grep -q "already exists"; then
      echo "WARNING: GKE cluster already exists"
    else
      echo "ERROR: GKE cluster creation failed."
      echo "$GKE_OUTPUT"
      exit 1
    fi
  }
fi

log "Get kubectl credentials"
gcloud container clusters get-credentials "$CLUSTER_NAME" --region="$REGION" --project="$PROJECT_ID"

# refresh aws public ecr login (needed for Ingext charts)
if command -v aws >/dev/null 2>&1; then
  if aws sts get-caller-identity >/dev/null 2>&1; then
    log "Refreshing AWS ECR Public login..."
    aws ecr-public get-login-password --region us-east-1 | helm registry login --username AWS --password-stdin public.ecr.aws || true
  else
    log "AWS CLI not authenticated. Clearing stale tokens to allow anonymous pull..."
    helm registry logout public.ecr.aws >/dev/null 2>&1 || true
  fi
fi



log "Create namespace: $NAMESPACE"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

log "Create service account: ${NAMESPACE}-sa"
kubectl create serviceaccount "${NAMESPACE}-sa" -n "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# setup token in app-secret for shell cli access
random_str=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 15 || true)
kubectl create secret generic app-secret \
    --namespace "$NAMESPACE" \
    --from-literal=token="tok_$random_str" \
    --dry-run=client -o yaml | kubectl apply -f -

log "Install dependencies: Redis, OpenSearch, VictoriaMetrics"
helm upgrade --install ingext-stack oci://public.ecr.aws/ingext/ingext-stack -n "$NAMESPACE"
helm upgrade --install etcd-single oci://public.ecr.aws/ingext/etcd-single -n "$NAMESPACE"
helm upgrade --install etcd-single-cronjob oci://public.ecr.aws/ingext/etcd-single-cronjob -n "$NAMESPACE"

wait_ns_pods_ready "$NAMESPACE" "900s"

log "Install Ingext config (siteDomain=$SITE_DOMAIN)"
helm upgrade --install ingext-community-config oci://public.ecr.aws/ingext/ingext-community-config \
  -n "$NAMESPACE" --set "siteDomain=$SITE_DOMAIN" --set k8sProvider="$k8sProvider"

log "Run initialization jobs"
helm upgrade --install ingext-community-init oci://public.ecr.aws/ingext/ingext-community-init -n "$NAMESPACE"

log "setup service account role"
helm install ingext-manager-role oci://public.ecr.aws/ingext/ingext-manager-role -n "$NAMESPACE"

log "Install main application"
helm upgrade --install ingext-community oci://public.ecr.aws/ingext/ingext-community -n "$NAMESPACE" --set k8sProvider="$k8sProvider"

wait_ns_pods_ready "$NAMESPACE" "1200s"

log "Install cert-manager"
helm repo add jetstack https://charts.jetstack.io >/dev/null
helm repo update >/dev/null
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set installCRDs=true

wait_ns_pods_ready "cert-manager" "600s"

log "Install cert issuer (email=$CERT_EMAIL)"
helm upgrade --install ingext-community-certissuer oci://public.ecr.aws/ingext/ingext-community-certissuer \
  -n "$NAMESPACE" --set "email=$CERT_EMAIL"

log "Create static IP for Ingress"
STATIC_IP_NAME="${NAMESPACE}staticip"
if ! gcloud compute addresses describe "$STATIC_IP_NAME" --global --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud compute addresses create "$STATIC_IP_NAME" --global --project="$PROJECT_ID"
fi

log "Create BackendConfig for API service health checks"
cat <<EOF | kubectl apply -f -
apiVersion: cloud.google.com/v1
kind: BackendConfig
metadata:
  name: apibackendconfig
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
for i in {1..12}; do
  if kubectl get service api -n "$NAMESPACE" >/dev/null 2>&1; then
    kubectl annotate service api -n "$NAMESPACE" \
      cloud.google.com/backend-config='{"default": "apibackendconfig"}' \
      --overwrite 2>/dev/null && break
  fi
  sleep 5
done

log "Install GCP ingress (siteDomain=$SITE_DOMAIN)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$SCRIPT_DIR/../charts/ingext-community-ingress-gcp"
helm upgrade --install ingext-ingress "$CHART_DIR" \
  -n "$NAMESPACE" --set "siteDomain=$SITE_DOMAIN" --set "ingress.staticIpName=$STATIC_IP_NAME"

log "========================================================"
log "✅ GKE Installation Complete!"
log "========================================================"
echo "Next step: Configure your DNS A-record to the static IP."
kubectl get ingress -n "$NAMESPACE"
