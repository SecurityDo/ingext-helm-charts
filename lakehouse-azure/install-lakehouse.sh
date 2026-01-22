#!/usr/bin/env bash

set -euo pipefail

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

# -------- 1. Load Environment --------
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
    exit 1
  }
}

for bin in az kubectl helm; do
  need "$bin"
done

# -------- 2. Deployment Summary --------
cat <<EOF

================ Deployment Plan ================
Azure Region:      $LOCATION
Resource Group:    $RESOURCE_GROUP
AKS Cluster:       $CLUSTER_NAME
Storage Account:   $STORAGE_ACCOUNT
Blob Container:    $STORAGE_CONTAINER
Node Count:        $NODE_COUNT
Node VM Size:      $NODE_VM_SIZE
Namespace:         $NAMESPACE
Site Domain:       $SITE_DOMAIN
Cert Email:        $CERT_EMAIL
================================================

EOF

read -rp "Proceed with Lakehouse deployment? (y/N): " CONFIRM
[[ "$CONFIRM" =~ ^[Yy]$ ]] || {
  echo "Deployment cancelled."
  exit 2
}

# -------- 3. Phase 1: Foundation (AKS) --------
log "Phase 1: Foundation - Checking/Creating Resource Group '$RESOURCE_GROUP'..."
if ! az group show --name "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
else
  log "Resource Group '$RESOURCE_GROUP' already exists."
fi

log "Phase 1: Foundation - Checking/Creating AKS Cluster '$CLUSTER_NAME'..."
if ! az aks show --name "$CLUSTER_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  AKS_OUTPUT=$(az aks create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$CLUSTER_NAME" \
    --location "$LOCATION" \
    --node-count "$NODE_COUNT" \
    --node-vm-size "$NODE_VM_SIZE" \
    --enable-oidc-issuer \
    --enable-workload-identity \
    --generate-ssh-keys \
    --network-plugin azure \
    --enable-addons ingress-appgw \
    --appgw-name "${CLUSTER_NAME}agw" \
    --appgw-subnet-cidr "10.225.0.0/16" 2>&1) || {
    
    if echo "$AKS_OUTPUT" | grep -q "VM size.*is not allowed"; then
      echo ""
      echo "ERROR: VM size '$NODE_VM_SIZE' is not available for AKS in your subscription."
      echo ""
      echo "NOTE: AKS has different restrictions than general VM availability."
      echo "The error message above shows the ACTUAL available sizes for AKS."
      echo ""
      
      # Try to extract available sizes from the error message
      AVAILABLE_SIZES=$(echo "$AKS_OUTPUT" | grep -oP "The available VM sizes are '[^']*'" | sed "s/The available VM sizes are '//;s/'$//" | tr ',' '\n' | sed 's/^[[:space:]]*//' | head -n 15 || true)
      
      if [[ -n "$AVAILABLE_SIZES" ]]; then
        echo "Available VM sizes for AKS in your subscription:"
        echo "$AVAILABLE_SIZES" | while read -r size; do
          if [[ -n "$size" ]]; then echo "  - $size"; fi
        done
        echo ""
        echo "Please run preflight again and select a supported size."
      fi
      exit 1
    else
      echo "ERROR: AKS cluster creation failed."
      echo "$AKS_OUTPUT"
      exit 1
    fi
  }
else
  log "Cluster '$CLUSTER_NAME' already exists. Skipping creation."
fi

az aks get-credentials --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME" --overwrite-existing

# -------- 3. Phase 2: Storage (Storage Account & Workload Identity) --------
log "Phase 2: Storage - Checking Storage Account '$STORAGE_ACCOUNT'..."
if ! az storage account show --name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az storage account create \
    --name "$STORAGE_ACCOUNT" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Standard_LRS \
    --kind StorageV2 \
    --allow-blob-public-access false
else
  log "Storage Account '$STORAGE_ACCOUNT' already exists."
fi

log "Phase 2: Storage - Checking Blob Container '$STORAGE_CONTAINER'..."
# Get storage account key for container check/creation
STORAGE_KEY=$(az storage account keys list --account-name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" --query "[0].value" -o tsv)
if ! az storage container show --name "$STORAGE_CONTAINER" --account-name "$STORAGE_ACCOUNT" --account-key "$STORAGE_KEY" >/dev/null 2>&1; then
  az storage container create --name "$STORAGE_CONTAINER" --account-name "$STORAGE_ACCOUNT" --account-key "$STORAGE_KEY"
else
  log "Blob Container '$STORAGE_CONTAINER' already exists."
fi

log "Phase 2: Storage - Configuring Workload Identity..."
USER_ASSIGNED_IDENTITY_NAME="ingext${NAMESPACE}identity"
if ! az identity show --name "$USER_ASSIGNED_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az identity create --name "$USER_ASSIGNED_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP"
fi

IDENTITY_CLIENT_ID=$(az identity show --name "$USER_ASSIGNED_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query clientId -o tsv)
IDENTITY_ID=$(az identity show --name "$USER_ASSIGNED_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" --query id -o tsv)

# Assign Storage Blob Data Contributor role to the identity
az role assignment create \
    --role "Storage Blob Data Contributor" \
    --assignee "$IDENTITY_CLIENT_ID" \
    --scope "/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.Storage/storageAccounts/$STORAGE_ACCOUNT" 2>/dev/null || true

# Federated Credential for Service Account
OIDC_ISSUER=$(az aks show --name "$CLUSTER_NAME" --resource-group "$RESOURCE_GROUP" --query "oidcIssuerProfile.issuerUrl" -o tsv)
if ! az identity federated-credential show --name "ingextfedcred" --identity-name "$USER_ASSIGNED_IDENTITY_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az identity federated-credential create \
    --name "ingextfedcred" \
    --identity-name "$USER_ASSIGNED_IDENTITY_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --issuer "$OIDC_ISSUER" \
    --subject "system:serviceaccount:$NAMESPACE:${NAMESPACE}-sa"
fi

# -------- 4. Phase 3: Core Services --------
log "Phase 4: Core Services - Installing Stack..."
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

# Login to ECR Public
az acr login --name ingext --expose-token --query accessToken -o tsv | helm registry login public.ecr.aws --username 000000000000 --password-stdin 2>/dev/null || true

helm upgrade --install ingext-stack oci://public.ecr.aws/ingext/ingext-stack -n "$NAMESPACE"
helm upgrade --install etcd-single oci://public.ecr.aws/ingext/etcd-single -n "$NAMESPACE"
helm upgrade --install etcd-single-cronjob oci://public.ecr.aws/ingext/etcd-single-cronjob -n "$NAMESPACE"

# setup token in app-secret for shell cli access
random_str=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 15 || true)
kubectl create secret generic app-secret \
    --namespace "$NAMESPACE" \
    --from-literal=token="tok_$random_str" \
    --dry-run=client -o yaml | kubectl apply -f -

# -------- 5. Phase 4: Application (Stream) --------
log "Phase 5: Application - Installing Ingext Stream..."
# Create the service account with workload identity annotation
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${NAMESPACE}-sa
  namespace: $NAMESPACE
  annotations:
    azure.workload.identity/client-id: "$IDENTITY_CLIENT_ID"
EOF

helm upgrade --install ingext-community-config oci://public.ecr.aws/ingext/ingext-community-config \
  -n "$NAMESPACE" --set "siteDomain=$SITE_DOMAIN"

helm upgrade --install ingext-community-init oci://public.ecr.aws/ingext/ingext-community-init -n "$NAMESPACE"
helm upgrade --install ingext-community oci://public.ecr.aws/ingext/ingext-community -n "$NAMESPACE"

# -------- 6. Phase 5: Application (Datalake) --------
log "Phase 6: Application - Installing Ingext Datalake..."
helm upgrade --install ingext-lake-config oci://public.ecr.aws/ingext/ingext-lake-config -n "$NAMESPACE" \
  --set storageType=blob --set blob.accountName="$STORAGE_ACCOUNT" --set blob.containerName="$STORAGE_CONTAINER"

# Node Pools (using standard node pool for now, as Azure doesn't have a direct Karpenter equivalent yet)
# We use the ingext-aks-pool chart to define labels/taints if needed
helm upgrade --install ingext-aks-pool oci://public.ecr.aws/ingext/ingext-aks-pool

helm upgrade --install ingext-manager-role oci://public.ecr.aws/ingext/ingext-manager-role -n "$NAMESPACE"
helm upgrade --install ingext-blob-lake oci://public.ecr.aws/ingext/ingext-blob-lake -n "$NAMESPACE" \
  --set storageAccount.name="$STORAGE_ACCOUNT" --set storageAccount.container="$STORAGE_CONTAINER"

helm upgrade --install ingext-lake oci://public.ecr.aws/ingext/ingext-lake -n "$NAMESPACE"

# -------- 7. Phase 6: Ingress --------
log "Phase 7: Ingress - Setting up Cert Manager..."
helm repo add jetstack https://charts.jetstack.io && helm repo update
helm upgrade --install cert-manager jetstack/cert-manager \
  --namespace cert-manager --create-namespace --set installCRDs=true

log "Installing Azure Ingress & Cert Issuer..."
helm upgrade --install ingext-community-certissuer oci://public.ecr.aws/ingext/ingext-community-certissuer \
  -n "$NAMESPACE" --set "email=$CERT_EMAIL"

helm upgrade --install ingext-ingress oci://public.ecr.aws/ingext/ingext-community-ingress-azure \
  -n "$NAMESPACE" --set "siteDomain=$SITE_DOMAIN"

log "========================================================"
log "✅ Azure Lakehouse Installation Complete!"
log "========================================================"
echo "Next step: Configure your DNS A-record to the Application Gateway public IP."
kubectl get ingress -n "$NAMESPACE"
