# Azure Datalake Setup Status

## Current Installation Status

### ✅ Completed

1. **AKS Cluster** - `ingext-lake`
   - **Status**: Running and healthy
   - **Resource Group**: `ingext-rg` (or `ingext-datalake-rg` if new setup)
   - **Location**: `eastus`
   - **Kubernetes Version**: v1.33.5
   - **Nodes**: 2 nodes ready (default node pool: `aks-nodepool1`)
   - **Cluster Access**: Configured and accessible via kubectl

2. **Kubernetes Namespace**
   - **Namespace**: `ingext` - Created and active

### ❌ Not Completed / Pending

1. **Blob Storage Account**
   - **Status**: Not created
   - **Action Required**: Run `./create_blob_storage.sh`
   - **Expected**: Storage account and container for datalake

2. **Service Account with Managed Identity**
   - **Status**: Not configured
   - **Action Required**: Run `./setup_ingext_serviceaccount.sh`
   - **Expected**: 
     - Managed Identity for Blob Storage access
     - Kubernetes service account with workload identity
     - Role assignments for storage access

3. **Dedicated Node Pools**
   - **Status**: Not created
   - **Action Required**: Run `./setup_aks_nodepools.sh`
   - **Expected**:
     - `pool-merge` node pool (for merge workloads)
     - `pool-search` node pool (for search workloads)
   - **Note**: Currently only default node pool exists

4. **Datalake Components** (Helm Charts)
   - **Status**: Not installed
   - **Action Required**: Follow `azure_install.md` for installation
   - **Components Needed**:
     - `ingext-lake-config` - Storage configuration
     - `ingext-manager-role` - Manager roles
     - `ingext-s3-lake` - S3/Blob lake integration
     - `ingext-lake-mgr` - Lake manager
     - `ingext-lake-worker` - Lake workers
     - `ingext-search-service` - Search service

## Next Steps (In Order)

### Step 1: Create Blob Storage
```bash
cd /workspace/datalake/azure
source ./ingext-datalake-azure.env  # If you have the env file
./create_blob_storage.sh
```

### Step 2: Setup Service Account
```bash
./setup_ingext_serviceaccount.sh
```

### Step 3: Setup Node Pools
```bash
./setup_aks_nodepools.sh
```

### Step 4: Install Datalake Components
Follow the instructions in `azure_install.md`:
```bash
# Configure datalake storage
helm install ingext-lake-config oci://public.ecr.aws/ingext/ingext-lake-config -n ingext \
  --set storageType=blob \
  --set blob.storageAccount=<storageAccountName>

# Install datalake components
helm install ingext-manager-role oci://public.ecr.aws/ingext/ingext-manager-role -n ingext
helm install ingext-s3-lake oci://public.ecr.aws/ingext/ingext-s3-lake -n ingext \
  --set bucket.name=<storageAccountName> \
  --set bucket.region=<location>
helm install ingext-lake-mgr oci://public.ecr.aws/ingext/ingext-lake-mgr -n ingext
helm install ingext-lake-worker oci://public.ecr.aws/ingext/ingext-lake-worker -n ingext
helm install ingext-search-service oci://public.ecr.aws/ingext/ingext-search-service -n ingext
```

## Current Cluster Resources

- **Default Node Pool**: `aks-nodepool1` (2 nodes, Ready)
- **Namespaces**: `ingext` (created, empty)
- **System Pods**: All running (CoreDNS, Application Gateway, CSI drivers, etc.)

## Issues Encountered

1. **Quota Error** (if attempting new cluster in `ingext-datalake-rg`):
   - Insufficient vCPU quota in `eastus` region
   - **Resolution**: Use existing cluster in `ingext-rg` or request quota increase

2. **Storage Account**: Needs to be created before service account setup

3. **Node Pools**: Need dedicated pools for datalake workloads (merge and search)

## Quick Status Check Commands

```bash
# Check cluster status
kubectl cluster-info
kubectl get nodes

# Check namespace
kubectl get namespace ingext

# Check if storage account exists (requires Azure CLI)
az storage account list --resource-group <resource-group>

# Check node pools
az aks nodepool list --resource-group <resource-group> --cluster-name ingext-lake

# Check Helm releases
helm list -n ingext

# Check pods
kubectl get pods -n ingext
```

## Summary

**Completed**: AKS cluster is running and healthy, namespace created

**Remaining**: 
1. Blob storage account
2. Service account with managed identity
3. Dedicated node pools
4. All datalake Helm chart installations

**Estimated Time to Complete**: 15-30 minutes (depending on node pool creation time)

