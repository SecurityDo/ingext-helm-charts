# Azure vs AWS Datalake Setup Comparison

This document compares the AWS and Azure datalake setup approaches and identifies what needs to be done to make Azure operate similarly to AWS.

## Key Architectural Differences

### AWS Approach (EKS + Karpenter)

1. **Node Autoscaling**: Uses **Karpenter** - a Kubernetes-native autoscaler
   - Karpenter creates/destroys EC2 instances based on pod scheduling needs
   - Managed via Kubernetes CRDs (NodePool, EC2NodeClass)
   - Declarative management through Helm charts

2. **Node Pool Management**: 
   - Uses Helm chart `ingext-eks-pool` to create Karpenter NodePools
   - NodePools are Kubernetes resources (CRDs)
   - Supports spot and on-demand instances
   - Automatic node provisioning based on pod requirements

3. **Setup Scripts**:
   - `setup_karpenter.sh` - Installs and configures Karpenter
   - Node pools created via Helm: `helm install ingext-merge-pool ...`

### Azure Approach (AKS + Cluster Autoscaler)

1. **Node Autoscaling**: Uses **Cluster Autoscaler** - built into AKS
   - Cluster Autoscaler scales node pools based on resource requests
   - Managed via Azure CLI or Azure Portal
   - Imperative management (Azure CLI commands)

2. **Node Pool Management**:
   - Uses Azure CLI: `az aks nodepool add`
   - Node pools are Azure-managed resources (not Kubernetes CRDs)
   - Supports spot and regular VMs
   - Manual node pool creation required

3. **Setup Scripts**:
   - ✅ `setup_aks_nodepools.sh` - Creates and configures node pools (equivalent to `setup_karpenter.sh`)
   - Node pools created via script (automated, similar to AWS workflow)

## Implementation Status

The following items have been implemented to make Azure operate similarly to AWS:

### 1. Node Pool Setup Script

**✅ IMPLEMENTED**: `setup_aks_nodepools.sh` script has been created and implements all required functionality:

- ✅ Creates the merge node pool (`poolmerge`) with configurable VM sizes
- ✅ Creates the search node pool (`poolsearch`) with configurable VM sizes
- ✅ Enables cluster autoscaler on both pools (`--enable-cluster-autoscaler`)
- ✅ Sets configurable min/max counts (via environment variables)
- ✅ Applies node labels (`node-pool=pool-merge`, `node-pool=pool-search`)
- ✅ Applies node taints (`node-pool=pool-merge:NoSchedule`, `node-pool=pool-search:NoSchedule`)
- ✅ Handles quota errors with helpful guidance
- ✅ Idempotent (can be run multiple times safely)

**Note**: Node pool names use alphanumeric format (`poolmerge`, `poolsearch`) due to Azure naming restrictions, but labels and taints use hyphenated names for compatibility with Helm charts.

### 2. Declarative Node Pool Management

**✅ IMPLEMENTED**: Using Option B - Script-based approach

**Current State**: Azure uses `setup_aks_nodepools.sh` script that wraps Azure CLI commands

**AWS Equivalent**: Helm charts that create Karpenter NodePools declaratively

**Implementation**: 
- Created `setup_aks_nodepools.sh` script (similar to AWS's approach)
- Script is idempotent and handles errors gracefully
- Uses environment variables for configuration (similar to AWS Helm values)
- Provides same functionality as AWS Helm charts, but via script instead of CRDs

**Note**: Azure cannot use pure Kubernetes CRDs for node pools (they're Azure-managed resources), so a script approach is the most practical solution.

### 3. Consistent Workflow

**AWS Workflow**:
```bash
./eks_setup.sh
./create_s3_bucket.sh
./setup_ingext_serviceaccount.sh
./setup_karpenter.sh                    # ← Missing in Azure
helm install ingext-merge-pool ...      # ← Uses Helm
helm install ingext-search-pool ...      # ← Uses Helm
```

**Azure Current Workflow** (✅ Implemented):
```bash
./aks_setup.sh
./create_blob_storage.sh
./setup_ingext_serviceaccount.sh
./setup_aks_nodepools.sh                 # ← IMPLEMENTED: Similar to setup_karpenter.sh
```

**Note**: The workflow now matches AWS in terms of automation and ease of use, even though the underlying mechanisms differ (script vs Helm charts).

## Similarities (What's Already Aligned)

✅ Both have cluster setup scripts (`eks_setup.sh` / `aks_setup.sh`)  
✅ Both have storage creation scripts (`create_s3_bucket.sh` / `create_blob_storage.sh`)  
✅ Both have service account setup scripts  
✅ Both have node pool/autoscaler setup scripts (`setup_karpenter.sh` / `setup_aks_nodepools.sh`)  
✅ Both use similar Helm charts for datalake components  
✅ Both have preflight scripts  
✅ Both have comprehensive README documentation  
✅ Both have Helm installation scripts for datalake components  

## Implementation Summary

✅ **All recommended implementations have been completed:**

### 1. ✅ Created `setup_aks_nodepools.sh`

**Status**: Fully implemented with all required features:
- Accepts parameters: resourceGroup, clusterName, location (or uses environment variables)
- Creates pool-merge node pool (`poolmerge`) with:
  - Configurable VM size (default: `Standard_D2s_v3`)
  - Cluster autoscaler enabled
  - Configurable min/max counts (default: min=1, max=1)
  - Node labels: `node-pool=pool-merge`
  - Taints: `node-pool=pool-merge:NoSchedule`
- Creates pool-search node pool (`poolsearch`) with:
  - Configurable VM size (default: `Standard_D2s_v3`)
  - Cluster autoscaler enabled
  - Configurable min/max counts (default: min=1, max=1)
  - Node labels: `node-pool=pool-search`
  - Taints: `node-pool=pool-search:NoSchedule`
- Additional features:
  - Idempotent (can run multiple times safely)
  - Comprehensive error handling for quota and VM size issues
  - Proactive quota checking and suggestions

### 2. ✅ Updated `azure_install.md`

**Status**: Updated to use `setup_aks_nodepools.sh` script instead of manual CLI commands

### 3. ✅ Updated README.md

**Status**: Comprehensive documentation added for `setup_aks_nodepools.sh`, similar to AWS's `setup_karpenter.sh` documentation

### 4. ✅ Updated Preflight Script

**Status**: `preflight-azure-datalake.sh` includes:
- Prompts for node pool VM sizes (`MERGE_VM_SIZE`, `SEARCH_VM_SIZE`)
- Configuration for min/max counts
- Saves configuration to environment file for use by `setup_aks_nodepools.sh`

## Fundamental Differences (Cannot Be Changed)

These are architectural differences that cannot be made identical:

1. **Karpenter vs Cluster Autoscaler**:
   - AWS: Karpenter is Kubernetes-native, creates nodes on-demand
   - Azure: Cluster Autoscaler is built into AKS, scales existing node pools
   - **Impact**: Azure requires pre-defined node pools, AWS can create nodes dynamically

2. **Node Pool Resources**:
   - AWS: NodePools are Kubernetes CRDs (managed in-cluster)
   - Azure: Node pools are Azure resources (managed via Azure API)
   - **Impact**: Azure cannot use pure Helm charts for node pools (would need Jobs/Operators)

3. **Instance Selection**:
   - AWS: Karpenter can choose from multiple instance types dynamically
   - Azure: Cluster Autoscaler scales within a single VM size per pool
   - **Impact**: Azure needs separate pools for different VM sizes

## Conclusion

✅ **The Azure setup is now functionally similar to AWS:**

1. ✅ `setup_aks_nodepools.sh` script created and fully functional
2. ✅ Documentation updated to match AWS workflow
3. ✅ Node pool creation is part of the automated setup
4. ✅ Preflight script includes node pool configuration
5. ✅ Helm installation script for datalake components
6. ✅ Comprehensive error handling and quota management

**Workflow Parity Achieved:**
- Both platforms now have equivalent automation and ease of use
- Both use similar script-based approaches for setup
- Both have comprehensive documentation and preflight checks

**Architectural Differences (Expected and Acceptable):**
- AWS uses Karpenter (Kubernetes-native, more flexible)
- Azure uses Cluster Autoscaler (Azure-native, simpler but less flexible)

Both approaches achieve the same goal (automatic node scaling) but through different mechanisms. The Azure implementation provides the same user experience and functionality as AWS, adapted to Azure's architecture.

