#!/bin/bash
set -e

###############################################################################
# Azure Lakehouse Installer (Integrated Stream + Datalake)
#
# Orchestrates the full lifecycle:
# 1. Foundation (AKS, Resource Group, StorageClass)
# 2. Storage (Storage Account, Blob Container, Workload Identity)
# 3. Core Services (Redis, OpenSearch, etc.)
# 4. Application (Stream + Datalake)
# 5. Ingress (App Gateway, Cert Manager)
###############################################################################

# --- 1. CONFIGURATION ---
if [[ ! -f "./lakehouse-azure.env" ]]; then
  echo "ERROR: lakehouse-azure.env not found. Run ./preflight-lakehouse.sh first."
  exit 1
fi

source ./lakehouse-azure.env


log() {
  echo ""
  echo "==> $*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing dependency: $1"
    echo "💡 TIP: Run './start-docker-shell.sh' to launch a pre-configured toolbox with all dependencies installed."
    exit 1
  }
}

for bin in az kubectl helm; do
  need "$bin"
done

wait_ns_pods_ready() {
  local ns="$1"
  local timeout="${2:-900s}"
  log "Waiting for pods in namespace '$ns' to be Ready (timeout $timeout)"
  kubectl wait --for=condition=Ready pods --all -n "$ns" --timeout="$timeout" || true
  kubectl get pods -n "$ns" -o wide || true
}


k8sProvider=azure
#CLUSTER_NAME="azlake6"
#RESOURCE_GROUP="ingext-$CLUSTER_NAME-rg"
#LOCATION="eastus"

#NODE_COUNT=3
## dsv6 # Supports Premium SSD v2 with default quota of 10
#NODE_VM_SIZE="Standard_D2s_v6"

#SITE_DOMAIN="$CLUSTER_NAME.aks.ingext.io"
#CERT_EMAIL="kun@fluencysecurity.com"
# Networking
VNET_NAME="aks-vnet"
VNET_CIDR="10.224.0.0/12"
NODE_SUBNET_NAME="aks-subnet"
NODE_SUBNET_CIDR="10.224.0.0/16"
APPGW_NAME="ingext-$CLUSTER_NAME-gateway"
APPGW_SUBNET_NAME="appgw-subnet"
APPGW_SUBNET_CIDR="10.225.0.0/24"

# Resources
#STORAGE_ACCOUNT_NAME="ingext$CLUSTER_NAME" # Must be globally unique
STORAGE_ACCOUNT_NAME=$STORAGE_ACCOUNT
CONTAINER_NAME="shared-data"

MANAGED_IDENTITY_NAME="ingext-$CLUSTER_NAME-identity"

## default namespace
#NAMESPACE="ingext"
## don't change
SERVICE_ACCOUNT_NAME="$NAMESPACE-sa"

echo "-----------------------------------------------------"
echo "DESTROYING & REBUILDING CLUSTER: $CLUSTER_NAME"
echo "-----------------------------------------------------"

# --- 2. NETWORK SETUP ---
#echo "Creating Network Resources..."
#az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none || true

log "Phase 1: Foundation - Checking/Creating Resource Group '$RESOURCE_GROUP'..."
if ! az group show --name "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
else
  log "Resource Group '$RESOURCE_GROUP' already exists."
fi


az network vnet create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$VNET_NAME" \
    --address-prefixes "$VNET_CIDR" \
    --location "$LOCATION" \
    --output none

az network vnet subnet create \
    --resource-group "$RESOURCE_GROUP" \
    --vnet-name "$VNET_NAME" \
    --name "$NODE_SUBNET_NAME" \
    --address-prefix "$NODE_SUBNET_CIDR" \
    --output none

az network vnet subnet create \
    --resource-group "$RESOURCE_GROUP" \
    --vnet-name "$VNET_NAME" \
    --name "$APPGW_SUBNET_NAME" \
    --address-prefix "$APPGW_SUBNET_CIDR" \
    --output none

NODE_SUBNET_ID=$(az network vnet subnet show -g "$RESOURCE_GROUP" --vnet-name "$VNET_NAME" -n "$NODE_SUBNET_NAME" --query id -o tsv)
APPGW_SUBNET_ID=$(az network vnet subnet show -g "$RESOURCE_GROUP" --vnet-name "$VNET_NAME" -n "$APPGW_SUBNET_NAME" --query id -o tsv)

# --- 3. CREATE AKS ---
echo "Creating AKS Cluster (This takes ~4-5 mins)..."

# Formatted with line breaks. Ensure NO spaces exist after the backslashes!
az aks create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER_NAME" \
    --location "$LOCATION" \
    --node-count "$NODE_COUNT" \
    --node-vm-size "$NODE_VM_SIZE" \
    --generate-ssh-keys \
    --tier Standard \
    --network-plugin azure \
    --network-plugin-mode overlay \
    --vnet-subnet-id "$NODE_SUBNET_ID" \
    --pod-cidr "192.168.0.0/16" \
    --enable-addons ingress-appgw \
    --appgw-subnet-id "$APPGW_SUBNET_ID" \
    --appgw-name "$APPGW_NAME" \
    --enable-blob-driver \
    --enable-oidc-issuer \
    --enable-workload-identity \
    --zones 1 2 3 \
    --node-provisioning-mode Auto \
    --output none

echo "Getting Credentials..."
az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --context "$CLUSTER_NAME" --overwrite-existing

# --- 4. STORAGE SETUP ---
echo "Setting up Storage..."
az storage account create \
    --name "$STORAGE_ACCOUNT_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Standard_LRS \
    --kind StorageV2 \
    --output none

# Assign Current User as Owner for keyless container creation
CURRENT_USER_ID=$(az ad signed-in-user show --query id -o tsv)
STORAGE_ID=$(az storage account show -n "$STORAGE_ACCOUNT_NAME" -g "$RESOURCE_GROUP" --query id -o tsv)
az role assignment create --assignee "$CURRENT_USER_ID" --role "Storage Blob Data Owner" --scope "$STORAGE_ID" --output none

az storage container create \
    --name "$CONTAINER_NAME" \
    --account-name "$STORAGE_ACCOUNT_NAME" \
    --auth-mode login \
    --output none

# --- 5. IDENTITY SETUP ---
echo "Creating Managed Identity..."
az identity create -n "$MANAGED_IDENTITY_NAME" -g "$RESOURCE_GROUP" --output none

IDENTITY_ID=$(az identity show -g "$RESOURCE_GROUP" -n "$MANAGED_IDENTITY_NAME" --query principalId -o tsv)
CLIENT_ID=$(az identity show -g "$RESOURCE_GROUP" -n "$MANAGED_IDENTITY_NAME" --query clientId -o tsv)
OIDC_ISSUER=$(az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" --query "oidcIssuerProfile.issuerUrl" -o tsv)

echo "Waiting 60 seconds for Identity propagation..."
sleep 60

echo "Assigning Roles..."
az role assignment create --assignee "$IDENTITY_ID" --role "Storage Blob Data Contributor" --scope "$STORAGE_ID" --output none
az role assignment create --assignee "$IDENTITY_ID" --role "Storage Account Key Operator Service Role" --scope "$STORAGE_ID" --output none

echo "Federating Identity..."
az identity federated-credential create \
    --name "app-federation" \
    --identity-name "$MANAGED_IDENTITY_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --issuer "$OIDC_ISSUER" \
    --subject "system:serviceaccount:${NAMESPACE}:${SERVICE_ACCOUNT_NAME}" \
    --output none


# --- 6. Setup access key for shared storage ---
echo "Create namespace $NAMESPACE..."
kubectl create namespace "$NAMESPACE" || true

# 7.1. Get the Storage Account Key (The "Master Password" for the storage)
echo "Setting up Shared Storage Access Key..."
KEY=$(az storage account keys list \
    --resource-group "$RESOURCE_GROUP" \
    --account-name "$STORAGE_ACCOUNT_NAME" \
    --query "[0].value" -o tsv)

# 7.2. Create the Secret in your namespace
kubectl create secret generic blob-secret \
    --namespace "$NAMESPACE" \
    --from-literal=azurestorageaccountname="$STORAGE_ACCOUNT_NAME" \
    --from-literal=azurestorageaccountkey="$KEY"


# setup token in app-secret for shell cli access
echo "set app-secret..."
random_str=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 15 || true)
#echo "$random_str"
kubectl create secret generic app-secret \
    --namespace "$NAMESPACE" \
    --from-literal=token="tok_$random_str"

# 8. Authenticate Helm (Important for OCI)
echo "-> Logging into ECR Public..."

# Try to login, but silence errors and continue if it fails
#aws ecr-public get-login-password --region us-east-1 2>/dev/null | \
#helm registry login --username AWS --password-stdin public.ecr.aws || true

# Ingext charts are hosted on AWS Public ECR. 
# We try to refresh the login if AWS CLI is configured to avoid rate limits,
# but we skip it if no credentials are found to allow pure Azure installs.
if command -v aws >/dev/null 2>&1; then
  if aws sts get-caller-identity >/dev/null 2>&1; then
    log "Refreshing AWS ECR Public login (for Helm charts)..."
    aws ecr-public get-login-password --region us-east-1 | helm registry login --username AWS --password-stdin public.ecr.aws || true
  else
    log "AWS CLI not authenticated. Clearing stale tokens to allow anonymous pull..."
    helm registry logout public.ecr.aws >/dev/null 2>&1 || true
  fi
fi





# 9. Install premium SSD v2 storage class 
echo "Installing Premium SSD v2 Storage Class..."
helm install ingext-azure-premiumssdv2 oci://public.ecr.aws/ingext/ingext-azure-premiumssdv2

# 10. Install the Service Account for ingext
echo "Installing Ingext Service Account..."
helm install ingext-serviceaccount oci://public.ecr.aws/ingext/ingext-serviceaccount \
  --namespace "$NAMESPACE" \
  --set serviceAccount.azureClientId="$CLIENT_ID"

# 11. Install the Ingext Stack
echo "Installing Ingext Stack..."
helm install ingext-stack oci://public.ecr.aws/ingext/ingext-stack -n "$NAMESPACE"

helm install etcd-single oci://public.ecr.aws/ingext/etcd-single \
  -n "$NAMESPACE" \
  --set persistence.storageClass=premium-ssd-v2

helm install etcd-single-cronjob oci://public.ecr.aws/ingext/etcd-single-cronjob -n "$NAMESPACE"

echo "Waiting 60 seconds for elastic/etcd to be ready..."
sleep 60

# 12. Install the Ingext Stream
echo "Installing Ingext Stream..."
helm install ingext-community-config oci://public.ecr.aws/ingext/ingext-community-config \
  -n "$NAMESPACE" \
  --set siteDomain="$SITE_DOMAIN" \
  --set k8sProvider="$k8sProvider"

helm install ingext-community-init oci://public.ecr.aws/ingext/ingext-community-init \
  -n "$NAMESPACE"

helm install ingext-community oci://public.ecr.aws/ingext/ingext-community \
  -n "$NAMESPACE" \
  --set k8sProvider="$k8sProvider"


# 12. Install the cert-manager and cert issuer
echo "Installing cert-manager and Cert Issuer..."
helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true

helm install ingext-community-certissuer oci://public.ecr.aws/ingext/ingext-community-certissuer \
  -n "$NAMESPACE" \
  --set email="$CERT_EMAIL"

# 13. Install the Ingress Controller
echo "Installing Ingress Controller..."
helm install ingext-community-ingress-azure oci://public.ecr.aws/ingext/ingext-community-ingress-azure \
  -n "$NAMESPACE" \
  --set siteDomain="$SITE_DOMAIN"

# 14. Install the Ingest Lake Config and Pools
echo "Installing Ingext DataLake configuration..."
helm install ingext-lake-config oci://public.ecr.aws/ingext/ingext-lake-config \
  -n "$NAMESPACE" \
  --set storageType=blob \
  --set blob.storageAccount="$STORAGE_ACCOUNT_NAME"

echo "Install ingext worker pool..."
echo "Installing Ingest Worker Pool..."
helm upgrade --install ingext-merge-pool oci://public.ecr.aws/ingext/ingext-aks-pool \
  --set poolName=pool-merge \
  --set clusterName="$CLUSTER_NAME"

echo "Install ingext search pool..."
echo "Installing Ingest Search Pool..."
helm upgrade --install ingext-search-pool oci://public.ecr.aws/ingext/ingext-aks-pool \
  --set poolName=pool-search \
  --set clusterName="$CLUSTER_NAME" \
  --set cpuLimit=128 \
  --set memoryLimit=512Gi

# 15. Install the Ingest Manager Role and the shared storage
helm install ingext-manager-role oci://public.ecr.aws/ingext/ingext-manager-role -n "$NAMESPACE"

helm install ingext-blob-lake oci://public.ecr.aws/ingext/ingext-blob-lake \
  -n "$NAMESPACE" \
  --set blob.resourceGroup="$RESOURCE_GROUP" \
  --set blob.storageAccountName="$STORAGE_ACCOUNT_NAME" \
  --set blob.containerName="$CONTAINER_NAME" \
  --set blob.azureClientId="$CLIENT_ID"

# 16. Install the Ingest DataLake Helm Chart
echo "Installing Ingest DataLake..."
helm install ingext-lake oci://public.ecr.aws/ingext/ingext-lake \
  -n "$NAMESPACE" \
  --set k8sProvider="$k8sProvider"

echo "-----------------------------------------------------"
echo "CLUSTER READY!"
echo "Name: $CLUSTER_NAME"
echo "Storage Account: $STORAGE_ACCOUNT_NAME"
echo "Identity: $MANAGED_IDENTITY_NAME"
echo "Karpenter: Managed (Active)"
echo "-----------------------------------------------------"

# set config for ingext cli
ingext config set --cluster "$CLUSTER_NAME" --context "${CLUSTER_NAME}" --provider azure --namespace $NAMESPACE

echo "Next step: Configure your DNS A-record to the Application Gateway public IP."
kubectl get ingress -n "$NAMESPACE"
