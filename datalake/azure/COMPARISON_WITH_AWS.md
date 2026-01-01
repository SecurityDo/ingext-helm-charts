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
   - Currently missing: No equivalent to `setup_karpenter.sh`
   - Node pools created via Azure CLI commands (manual/imperative)

## What's Missing in Azure

To make Azure operate more similarly to AWS, the following are needed:

### 1. Node Pool Setup Script

**Missing**: A script similar to `setup_karpenter.sh` that automates node pool creation.

**Needed**: `setup_aks_nodepools.sh` that:
- Creates the merge node pool (pool-merge) with appropriate VM sizes
- Creates the search node pool (pool-search) with appropriate VM sizes
- Enables cluster autoscaler on both pools
- Sets appropriate min/max counts
- Applies node labels and taints (similar to AWS Karpenter NodePools)

### 2. Declarative Node Pool Management

**Current State**: Azure uses imperative `az aks nodepool add` commands

**AWS Equivalent**: Helm charts that create Karpenter NodePools declaratively

**Options for Azure**:
- **Option A**: Create a Helm chart that uses Kubernetes Jobs to run Azure CLI commands
- **Option B**: Create a script that wraps Azure CLI commands (simpler, more practical)
- **Option C**: Use Azure Resource Manager (ARM) templates or Terraform (more complex)

**Recommendation**: Option B - Create a script similar to AWS's approach but using Azure CLI

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

**Azure Current Workflow**:
```bash
./aks_setup.sh
./create_blob_storage.sh
./setup_ingext_serviceaccount.sh
# Missing: setup_aks_nodepools.sh
az aks nodepool add ...                  # ← Manual CLI commands
az aks nodepool add ...                  # ← Manual CLI commands
```

**Azure Target Workflow** (to match AWS):
```bash
./aks_setup.sh
./create_blob_storage.sh
./setup_ingext_serviceaccount.sh
./setup_aks_nodepools.sh                 # ← NEW: Similar to setup_karpenter.sh
# Or use Helm if we create a chart
```

## Similarities (What's Already Aligned)

✅ Both have cluster setup scripts (`eks_setup.sh` / `aks_setup.sh`)  
✅ Both have storage creation scripts (`create_s3_bucket.sh` / `create_blob_storage.sh`)  
✅ Both have service account setup scripts  
✅ Both use similar Helm charts for datalake components  
✅ Both have preflight scripts  
✅ Both have comprehensive README documentation  

## Recommended Implementation

To make Azure operate similarly to AWS, implement:

### 1. Create `setup_aks_nodepools.sh`

This script should:
- Accept parameters: resourceGroup, clusterName, location
- Create pool-merge node pool with:
  - VM size: Standard_D4s_v3 (or configurable)
  - Cluster autoscaler enabled
  - Min: 1, Max: 3
  - Node labels: `node-pool=pool-merge`
  - Taints: `node-pool=pool-merge:NoSchedule`
- Create pool-search node pool with:
  - VM size: Standard_D4s_v3 (or configurable)
  - Cluster autoscaler enabled
  - Min: 1, Max: 2
  - Node labels: `node-pool=pool-search`
  - Taints: `node-pool=pool-search:NoSchedule`

### 2. Update `azure_install.md`

Replace manual `az aks nodepool add` commands with:
```bash
./setup_aks_nodepools.sh <resourceGroup> <clusterName> <location>
```

### 3. Update README.md

Add documentation for `setup_aks_nodepools.sh` similar to how AWS documents `setup_karpenter.sh`

### 4. Update Preflight Script

Add prompts for node pool VM sizes and autoscaler settings

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

The Azure setup can be made **functionally similar** to AWS by:
1. ✅ Creating `setup_aks_nodepools.sh` script
2. ✅ Updating documentation to match AWS workflow
3. ✅ Making node pool creation part of the automated setup

However, the **underlying architecture** will remain different:
- AWS uses Karpenter (Kubernetes-native, more flexible)
- Azure uses Cluster Autoscaler (Azure-native, simpler but less flexible)

Both approaches achieve the same goal (automatic node scaling) but through different mechanisms.

