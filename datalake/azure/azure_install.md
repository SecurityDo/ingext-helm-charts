# ingext-datalake (Azure)

## Prepare AKS cluster

### Create one AKS cluster with Azure CLI

### Save the cluster context for kubectl

### Enable OIDC issuer and Workload Identity

```bash
./aks_setup.sh <resourceGroup> <location> <clusterName> <nodeCount>
```

## Create service account for the application (ingext-switch + datalake)

### Create an Azure Blob Storage account and container for the datalake and shared storage

```bash
./create_blob_storage.sh <resourceGroup> <location> <storageAccountName> <containerName> <expireDays>
```

### Create service account with access permission to the Blob Storage

```bash
./setup_ingext_serviceaccount.sh <resourceGroup> <clusterName> <namespace> <storageAccountName>
```

## Install Ingext stream

### core installation

### azure ingress setup

## Install Ingext datalake

### Setup datalake configurations

```bash
helm install ingext-lake-config oci://public.ecr.aws/ingext/ingext-lake-config -n <namespace> \
  --set storageType=blob \
  --set blob.storageAccount=<storageAccountName>
```

### Setup node pools for the datalake

```bash
./setup_aks_nodepools.sh <resourceGroup> <clusterName> <location>
```

This script creates two node pools:
- **pool-merge**: For merge workloads (min: 1, max: 3 nodes)
- **pool-search**: For search workloads (min: 1, max: 2 nodes)

Both pools have:
- Cluster autoscaler enabled
- Node labels: `node-pool=<pool-name>`
- Taints: `node-pool=<pool-name>:NoSchedule` (pods must have matching tolerations)

**Note**: You can customize VM sizes via environment variables:
```bash
export MERGE_VM_SIZE="Standard_D4s_v3"
export SEARCH_VM_SIZE="Standard_D4s_v3"
./setup_aks_nodepools.sh <resourceGroup> <clusterName> <location>
```

### Install datalake components

```bash
helm install ingext-manager-role oci://public.ecr.aws/ingext/ingext-manager-role -n <namespace>

helm install ingext-s3-lake oci://public.ecr.aws/ingext/ingext-s3-lake -n <namespace> \
  --set bucket.name=<storageAccountName> \
  --set bucket.region=<location>

helm install ingext-lake-mgr oci://public.ecr.aws/ingext/ingext-lake-mgr -n <namespace>

helm install ingext-lake-worker oci://public.ecr.aws/ingext/ingext-lake-worker -n <namespace>

helm install ingext-search-service oci://public.ecr.aws/ingext/ingext-search-service -n <namespace>
```

