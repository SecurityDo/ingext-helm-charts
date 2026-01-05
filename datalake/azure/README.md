# Azure Datalake Setup

This directory contains scripts and documentation for setting up the Ingext datalake on Microsoft Azure using Azure Kubernetes Service (AKS). The setup includes AKS cluster creation, Azure Blob Storage configuration, service account setup with managed identity permissions, and deployment of the Ingext datalake components.

## Overview

The Azure datalake setup automates the deployment of Ingext's datalake infrastructure on Azure, including:

- **AKS Cluster**: Kubernetes cluster with Application Gateway ingress
- **Azure Blob Storage**: Storage account and container for datalake data storage
- **Service Accounts**: Kubernetes service accounts with Azure Managed Identity for Blob Storage access
- **Datalake Components**: Ingext datalake manager, workers, and search services

## Prerequisites

Before starting, ensure you have the following installed and configured:

### Required Tools

- **Azure CLI** (v2.0+) - [Installation Guide](https://docs.microsoft.com/cli/azure/install-azure-cli)
- **kubectl** - [Installation Guide](https://kubernetes.io/docs/tasks/tools/)
- **Helm** (v3+) - [Installation Guide](https://helm.sh/docs/intro/install/)
- **bash** (version 4.0+)

### Azure Configuration

1. **Azure Subscription**: An active Azure subscription with appropriate permissions
2. **Azure Login**: Logged in to Azure CLI (`az login`)
3. **Permissions**: Your Azure user/role needs permissions for:
   - AKS cluster creation and management
   - Resource group creation and management
   - Storage account creation and management
   - Managed identity creation and role assignment
   - Network and Application Gateway configuration

### Verify Prerequisites

```bash
# Check Azure CLI
az --version

# Check kubectl
kubectl version --client

# Check Helm
helm version

# Verify Azure login
az account show
```

## Quick Start

The setup process follows this order:

1. **Preflight Check** (Recommended) - Verify prerequisites and collect configuration
2. **Prepare AKS Cluster** - Create cluster with Application Gateway
3. **Create Blob Storage** - Set up storage account and container for datalake
4. **Setup Service Account** - Configure Kubernetes service account with Blob Storage permissions
5. **Install Ingext Datalake** - Deploy datalake components

### Recommended: Run Preflight First

Before starting the installation, run the preflight wizard to verify prerequisites and collect all configuration:

```bash
./preflight-azure-datalake.sh
```

This interactive script will:
- Verify Azure login and subscription access
- Check provider registrations (ContainerService, Network, Storage)
- Collect all required configuration (resource group, cluster name, storage account, etc.)
- Perform best-effort checks (quotas, storage account name availability)
- Generate an environment file (`ingext-datalake-azure.env`) with all settings

After preflight completes, source the environment file and run the setup scripts:

```bash
source ./ingext-datalake-azure.env

# Run the setup scripts (no arguments needed - they use environment variables)
./aks_setup.sh
./create_blob_storage.sh
./setup_ingext_serviceaccount.sh
./setup_aks_nodepools.sh
```

### Manual Execution Order

If you prefer to run scripts manually without preflight:

```bash
# 1. Setup AKS cluster (takes 10-15 minutes)
./aks_setup.sh <resourceGroup> <location> <clusterName> <nodeCount>

# 2. Create Blob Storage account and container
./create_blob_storage.sh <resourceGroup> <location> <storageAccountName> <containerName> <expireDays>

# 3. Setup service account with managed identity
./setup_ingext_serviceaccount.sh <resourceGroup> <clusterName> <namespace> <storageAccountName>

# 4. Setup node pools for datalake workloads
./setup_aks_nodepools.sh <resourceGroup> <clusterName> <location>

# 5. Install Ingext datalake (see azure_install.md for details)
# Follow the installation steps in azure_install.md
```

## Scripts Documentation

### preflight-azure-datalake.sh

**Purpose**: Interactive wizard to verify prerequisites, collect configuration, and perform best-effort checks before installation.

**What it does**:
- Verifies Azure login and subscription access
- Allows subscription selection/switching
- Collects all required configuration interactively
- Checks Azure provider registrations (ContainerService, Network, Storage)
- Checks compute quotas in the selected region
- Validates storage account name format and availability
- Asks readiness questions (billing, permissions, quota, DNS)
- Generates environment file with all settings

**Usage**:
```bash
./preflight-azure-datalake.sh
OUTPUT_ENV=./my.env ./preflight-azure-datalake.sh
```

**Parameters**:
- `OUTPUT_ENV` (optional): Path to output environment file (default: `./ingext-datalake-azure.env`)

**What it collects**:
- Azure region and resource group
- AKS cluster name, node count, and VM size
- Storage account name and container name
- Object expiration days
- Kubernetes namespace

**What it checks**:
- Azure subscription validity and access
- Provider registrations (Microsoft.ContainerService, Microsoft.Network, Microsoft.Storage)
- Compute quotas in the selected region
- Storage account name availability

**Example**:
```bash
./preflight-azure-datalake.sh
# Follow the interactive prompts
# Then source the generated file:
source ./ingext-datalake-azure.env
```

**Verification**:
The script provides real-time feedback on all checks. Review the summary at the end for any warnings.

---

### aks_setup.sh

**Purpose**: Creates an AKS cluster with Application Gateway add-on enabled for ingress.

**What it does**:
- Creates a resource group (if it doesn't exist)
- Creates an AKS cluster with managed identity
- Enables Application Gateway ingress add-on
- Updates kubeconfig for cluster access
- Configures Azure RBAC

**Usage**:
```bash
# Using environment variables (recommended after preflight):
source ./ingext-datalake-azure.env
./aks_setup.sh

# Using command-line arguments:
./aks_setup.sh <resourceGroup> <location> <clusterName> <nodeCount>

# Mixing (env vars + overrides):
source ./ingext-datalake-azure.env
./aks_setup.sh ingext-rg eastus  # overrides RESOURCE_GROUP and LOCATION
```

**Parameters**:
- `resourceGroup`: Azure resource group name (e.g., `ingext-rg`)
- `location`: Azure region (e.g., `eastus`, `westus2`)
- `clusterName`: Name for the AKS cluster (e.g., `ingext-lake`)
- `nodeCount`: Number of nodes in the default node pool (e.g., `3`)

**Environment Variables** (optional):
- `NODE_VM_SIZE`: VM size for nodes (default: `standard_dc2s_v3`)
- `APPGW_NAME`: Application Gateway name (default: `ingext-agw`)
- `APPGW_SUBNET_CIDR`: Subnet CIDR for Application Gateway (default: `10.225.0.0/16`)

**Example**:
```bash
./aks_setup.sh ingext-rg eastus ingext-lake 3
```

**What it creates**:
- Resource group
- AKS cluster with managed identity
- Application Gateway for ingress
- Default node pool with specified node count

**Estimated Time**: 10-15 minutes

**Verification**:
```bash
# Check cluster status
kubectl cluster-info

# Verify nodes
kubectl get nodes

# Check Application Gateway
az network application-gateway list --resource-group <resourceGroup>
```

---

### create_blob_storage.sh

**Purpose**: Creates an Azure Storage Account and Blob Container for datalake storage.

**What it does**:
- Creates an Azure Storage Account (Standard_LRS, StorageV2, Hot tier)
- Creates a blob container within the storage account
- Configures storage account security settings
- Sets up basic lifecycle management

**Usage**:
```bash
# Using environment variables (recommended after preflight):
source ./ingext-datalake-azure.env
./create_blob_storage.sh

# Using command-line arguments:
./create_blob_storage.sh <resourceGroup> <location> <storageAccountName> <containerName> <expireDays>
```

**Parameters**:
- `resourceGroup`: Azure resource group name
- `location`: Azure region where storage will be created
- `storageAccountName`: Storage account name (must be 3-24 characters, lowercase alphanumeric)
- `containerName`: Blob container name
- `expireDays`: Number of days after which objects expire (e.g., `30`)

**Example**:
```bash
./create_blob_storage.sh ingext-rg eastus ingextdatalake datalake 30
```

**What it creates**:
- Azure Storage Account (Standard_LRS, StorageV2)
- Blob container with the specified name
- Storage account with security best practices (TLS 1.2 minimum, public access disabled)

**Important Notes**:
- Storage account names must be globally unique and 3-24 characters
- The script automatically converts the name to lowercase and removes special characters
- For full lifecycle management, configure Azure Storage Lifecycle Management in the Azure Portal

**Verification**:
```bash
# List storage accounts
az storage account list --resource-group <resourceGroup>

# List containers
az storage container list \
  --account-name <storageAccountName \
  --account-key <key>
```

---

### setup_aks_nodepools.sh

**Purpose**: Creates AKS node pools for datalake workloads (merge and search pools), similar to AWS's Karpenter NodePool setup.

**What it does**:
- Creates `pool-merge` node pool for merge workloads
- Creates `pool-search` node pool for search workloads
- Enables cluster autoscaler on both pools
- Applies node labels and taints for workload isolation
- Configures min/max node counts for autoscaling

**Usage**:
```bash
# Using environment variables (recommended after preflight):
source ./ingext-datalake-azure.env
./setup_aks_nodepools.sh

# Using command-line arguments:
./setup_aks_nodepools.sh <resourceGroup> <clusterName> <location>
```

**Parameters**:
- `resourceGroup`: Azure resource group name
- `clusterName`: AKS cluster name
- `location`: Azure region

**Environment Variables** (optional):
- `MERGE_VM_SIZE`: VM size for merge pool (default: `Standard_D4s_v3`)
- `MERGE_MIN_COUNT`: Minimum nodes for merge pool (default: `1`)
- `MERGE_MAX_COUNT`: Maximum nodes for merge pool (default: `3`)
- `SEARCH_VM_SIZE`: VM size for search pool (default: `Standard_D4s_v3`)
- `SEARCH_MIN_COUNT`: Minimum nodes for search pool (default: `1`)
- `SEARCH_MAX_COUNT`: Maximum nodes for search pool (default: `2`)

**Example**:
```bash
./setup_aks_nodepools.sh ingext-rg ingext-lake eastus
```

**With custom VM sizes**:
```bash
export MERGE_VM_SIZE="Standard_D8s_v3"
export SEARCH_VM_SIZE="Standard_D4s_v3"
./setup_aks_nodepools.sh ingext-rg ingext-lake eastus
```

**What it creates**:
- Node pool: `pool-merge` with cluster autoscaler enabled
- Node pool: `pool-search` with cluster autoscaler enabled
- Node labels: `node-pool=pool-merge` and `node-pool=pool-search`
- Node taints: `node-pool=pool-merge:NoSchedule` and `node-pool=pool-search:NoSchedule`

**Important Notes**:
- Pods must have matching tolerations to schedule on these pools
- Cluster autoscaler will scale pools based on pod resource requests
- Node pools are Azure-managed resources (not Kubernetes CRDs like AWS Karpenter)
- This script is idempotent - it skips creation if pools already exist

**Verification**:
```bash
# List node pools
az aks nodepool list \
  --resource-group <resourceGroup> \
  --cluster-name <clusterName> \
  --output table

# Check nodes
kubectl get nodes --show-labels | grep node-pool

# Check node taints
kubectl describe nodes | grep -A 5 Taints
```

---

### setup_ingext_serviceaccount.sh

**Purpose**: Creates a Kubernetes service account with Azure Managed Identity and permissions to access Blob Storage.

**What it does**:
- Creates or retrieves a User-Assigned Managed Identity
- Assigns "Storage Blob Data Contributor" role to the managed identity
- Enables OIDC issuer and Workload Identity on AKS (if not already enabled)
- Creates federated identity credential linking service account to managed identity
- Creates/updates Kubernetes service account with workload identity annotations

**Usage**:
```bash
# Using environment variables (recommended after preflight):
source ./ingext-datalake-azure.env
./setup_ingext_serviceaccount.sh

# Using command-line arguments:
./setup_ingext_serviceaccount.sh <resourceGroup> <clusterName> <namespace> <storageAccountName>
```

**Parameters**:
- `resourceGroup`: Azure resource group name
- `clusterName`: AKS cluster name
- `namespace`: Kubernetes namespace (typically `ingext`)
- `storageAccountName`: Storage account name (must match the account created earlier)

**Example**:
```bash
./setup_ingext_serviceaccount.sh ingext-rg ingext-lake ingext ingextdatalake
```

**What it creates**:
- User-Assigned Managed Identity: `ingext-<namespace>-sa-identity`
- Role assignment: "Storage Blob Data Contributor" on the storage account
- Federated identity credential linking service account to managed identity
- Kubernetes service account with workload identity annotations

**Important Notes**:
- The service account name follows the pattern: `<namespace>-sa`
- Pods using this service account must have the label: `azure.workload.identity/use: "true"`
- OIDC issuer and Workload Identity are automatically enabled if not already configured
- The managed identity is created in the same resource group as the cluster

**Verification**:
```bash
# Check service account
kubectl get serviceaccount -n <namespace>

# Verify managed identity
az identity show \
  --resource-group <resourceGroup> \
  --name ingext-<namespace>-sa-identity

# Check role assignments
az role assignment list \
  --assignee <identity-client-id> \
  --scope /subscriptions/<sub-id>/resourceGroups/<rg>/providers/Microsoft.Storage/storageAccounts/<account>
```

---

## Installation Steps

For detailed installation instructions, including deploying the Ingext datalake components, see [azure_install.md](./azure_install.md).

The installation process includes:

1. **AKS Cluster Setup** (via `aks_setup.sh`)
2. **Blob Storage Creation** (via `create_blob_storage.sh`)
3. **Service Account Configuration** (via `setup_ingext_serviceaccount.sh`)
4. **Datalake Configuration**:
   - Install `ingext-lake-config` Helm chart with `storageType=blob`
   - Setup node pools for datalake workloads (using Azure node pools)
   - Install datalake components (manager, worker, search service)

Refer to `azure_install.md` for complete Helm commands and configuration options.

## Status Check

Use the status check script to see the current installation status of all components:

```bash
# Run as a script
./install-status-check.sh

# Or source and use as a function
source ./install-status-check.sh
check_datalake_status
```

The status check displays:
- **Left Column**: Resource name
- **Right Column**: Status (color-coded)
  - 🟢 **Green** (✓): Complete/Healthy
  - 🟡 **Yellow** (⚠): Partial/Needs Attention
  - 🔴 **Red** (✗): Missing/Not Found

It checks:
- AKS cluster status and node count
- Kubernetes namespace
- Blob storage account and container
- Service account and managed identity
- Node pools (pool-merge, pool-search)
- All Helm releases (datalake components)
- Running pods

## Verification

After completing the setup, verify each component:

### Verify AKS Cluster
```bash
kubectl cluster-info
kubectl get nodes
az aks show --resource-group <resourceGroup> --name <clusterName>
```

### Verify Blob Storage
```bash
az storage account show \
  --resource-group <resourceGroup> \
  --name <storageAccountName>

az storage container list \
  --account-name <storageAccountName> \
  --auth-mode login
```

### Verify Service Account
```bash
kubectl get serviceaccount -n <namespace>
kubectl describe serviceaccount <namespace>-sa -n <namespace>
```

### Verify Managed Identity
```bash
az identity show \
  --resource-group <resourceGroup> \
  --name ingext-<namespace>-sa-identity

az role assignment list \
  --assignee <identity-client-id>
```

### Verify Datalake Components
```bash
kubectl get pods -n <namespace> | grep -E "lake|search"
kubectl get statefulset,deployment -n <namespace>
```

## Troubleshooting

### Common Issues

#### Azure Login Required

**Problem**: Scripts fail with authentication errors.

**Solution**:
- Login to Azure: `az login`
- Verify login: `az account show`
- Set default subscription if needed: `az account set --subscription <subscription-id>`

#### Storage Account Name Invalid

**Problem**: Storage account creation fails due to invalid name.

**Solution**:
- Storage account names must be 3-24 characters, lowercase, alphanumeric only
- The script automatically sanitizes the name, but ensure it's unique globally
- Use a unique prefix or include timestamp: `ingextdatalake$(date +%s | cut -c6-)`

#### AKS Cluster Creation Fails

**Problem**: `az aks create` fails with permission or quota errors.

**Solution**:
- Verify subscription has AKS quota: `az vm list-usage --location <location>`
- Check provider registration: `az provider show --namespace Microsoft.ContainerService`
- Ensure you have Contributor or Owner role on the subscription/resource group
- Try a different VM size if quota is exceeded

#### Workload Identity Not Working

**Problem**: Pods cannot access Blob Storage using managed identity.

**Solution**:
- Verify OIDC issuer is enabled: `az aks show --query oidcIssuerProfile.issuerUrl`
- Check federated identity credential exists
- Ensure pods have the label: `azure.workload.identity/use: "true"`
- Verify service account has the correct annotation: `azure.workload.identity/client-id`
- Check role assignment: `az role assignment list --assignee <identity-client-id>`

#### Application Gateway Not Accessible

**Problem**: Ingress IP not available or not responding.

**Solution**:
- Check Application Gateway status: `az network application-gateway list --resource-group <resourceGroup>`
- Verify ingress resource: `kubectl get ingress -n <namespace>`
- Check Application Gateway backend health
- Ensure DNS A-record points to the Application Gateway public IP

### Getting Help

- Check script logs for detailed error messages
- Review Azure Activity Log for resource creation issues
- Verify all prerequisites are installed and configured
- Ensure Azure credentials have sufficient permissions
- Check [Azure AKS Documentation](https://docs.microsoft.com/azure/aks/)

## Azure-Specific Considerations

### Managed Identity vs IAM Roles

Azure uses **Managed Identities** instead of IAM roles:
- User-Assigned Managed Identities are created and managed separately
- Federated Identity Credentials link Kubernetes service accounts to managed identities
- Role assignments use Azure RBAC instead of IAM policies

### Storage Options

Azure Blob Storage is the equivalent of AWS S3:
- Storage accounts are regional resources
- Containers are similar to S3 buckets
- Lifecycle management requires Azure Storage Lifecycle Management policies

### Node Pools

Azure uses native node pools instead of Karpenter:
- Node pools are managed via Azure CLI or Azure Portal
- Cluster autoscaler can be enabled per node pool
- Different VM sizes and configurations per pool

### Networking

Azure uses Azure CNI networking:
- Pods get IPs from the VNet subnet
- Application Gateway integrates with AKS for ingress
- Network policies can be enabled for pod-to-pod communication

## Additional Resources

- [Azure Kubernetes Service Documentation](https://docs.microsoft.com/azure/aks/)
- [Azure Blob Storage Documentation](https://docs.microsoft.com/azure/storage/blobs/)
- [Azure Workload Identity Documentation](https://azure.github.io/azure-workload-identity/docs/)
- [Main Ingext Installation Guide](../README.md)

## Script Execution Order Summary

For a complete setup, execute scripts in this order:

### Option 1: Using Preflight (Recommended)

```bash
# 1. Run preflight wizard (interactive)
./preflight-azure-datalake.sh

# 2. Source the generated environment file
source ./ingext-datalake-azure.env

# 3. Run setup scripts (no arguments needed - they use environment variables)
./aks_setup.sh
./create_blob_storage.sh
./setup_ingext_serviceaccount.sh
./setup_aks_nodepools.sh

# 4. Follow azure_install.md for datalake component installation
```

### Option 2: Manual Execution

```bash
# 1. AKS Cluster (10-15 minutes)
./aks_setup.sh <resourceGroup> <location> <cluster-name> <node-count>

# 2. Blob Storage
./create_blob_storage.sh <resourceGroup> <location> <storage-account-name> <container-name> <expire-days>

# 3. Service Account
./setup_ingext_serviceaccount.sh <resourceGroup> <cluster-name> <namespace> <storage-account-name>

# 4. Node Pools
./setup_aks_nodepools.sh <resourceGroup> <cluster-name> <location>

# 5. Follow azure_install.md for datalake component installation
```

Make all scripts executable before running:
```bash
chmod +x *.sh
```

