#!/bin/bash
set -e

# --- 1. CONFIGURATION ---
k8sProvider=aks
CLUSTER_NAME="azlake6"
RESOURCE_GROUP="ingext-$CLUSTER_NAME-rg"
LOCATION="eastus"

NODE_COUNT=3
## v6 support is tight, so we use v5
NODE_VM_SIZE="Standard_D2ads_v5" # Supports Premium SSD v2

SITE_DOMAIN="$CLUSTER_NAME.aks.ingext.io"
CERT_EMAIL="kun@fluencysecurity.com"
# Networking
VNET_NAME="aks-vnet"
VNET_CIDR="10.224.0.0/12"
NODE_SUBNET_NAME="aks-subnet"
NODE_SUBNET_CIDR="10.224.0.0/16"
APPGW_NAME="ingext-$CLUSTER_NAME-gateway"
APPGW_SUBNET_NAME="appgw-subnet"
APPGW_SUBNET_CIDR="10.225.0.0/24"

# Resources
STORAGE_ACCOUNT_NAME="ingext$CLUSTER_NAME" # Must be globally unique
CONTAINER_NAME="shared-data"

MANAGED_IDENTITY_NAME="ingext-$CLUSTER_NAME-identity"
NAMESPACE="ns-$CLUSTER_NAME"
## don't change
SERVICE_ACCOUNT_NAME="$NAMESPACE-sa"

echo "-----------------------------------------------------"
echo "DESTROYING & REBUILDING CLUSTER: $CLUSTER_NAME"
echo "-----------------------------------------------------"

# --- 2. NETWORK SETUP ---
echo "Creating Network Resources..."
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none || true

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
az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --overwrite-existing

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


# 8. Authenticate Helm (Important for OCI)
echo "-> Logging into ECR Public..."

# Try to login, but silence errors and continue if it fails
aws ecr-public get-login-password --region us-east-1 2>/dev/null | \
helm registry login --username AWS --password-stdin public.ecr.aws || true

#aws ecr-public get-login-password --region us-east-1 | helm registry login --username AWS --password-stdin public.ecr.aws

# 9. Install premium SSD v2 storage class 
echo "Installing Premium SSD v2 Storage Class..."
helm install ingext-azure-premiumssdv2 oci://public.ecr.aws/ingext/ingext-azure-premiumssdv2

# 10. Install the Service Account for ingext
echo "Installing Ingest Service Account..."
helm install ingext-serviceaccount oci://public.ecr.aws/ingext/ingext-serviceaccount \
  --namespace "$NAMESPACE" \
  --set serviceAccount.azureClientId="$CLIENT_ID"

# 11. Install the Ingest Stack
echo "Installing Ingest Stack..."
helm install ingext-stack oci://public.ecr.aws/ingext/ingext-stack -n "$NAMESPACE"

helm install etcd-single oci://public.ecr.aws/ingext/etcd-single \
  -n "$NAMESPACE" \
  --set persistence.storageClass=premium-ssd-v2

helm install etcd-single-cronjob oci://public.ecr.aws/ingext/etcd-single-cronjob -n "$NAMESPACE"

echo "Waiting 60 seconds for elastic/etcd to be ready..."
sleep 60

# 12. Install the Ingest Stream
echo "Installing Ingest Stream..."
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
echo "Installing Ingest DataLake configuration..."
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
