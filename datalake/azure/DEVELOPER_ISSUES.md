# Azure Datalake Installation Issues - Developer Notes

## Summary
The Ingext datalake Helm charts are currently AWS-specific and do not work on Azure AKS without modifications.

## Issues Identified

### 1. **ingext-s3-lake Chart is AWS-Only**

**Problem:**
- The `ingext-s3-lake` chart hardcodes the AWS S3 CSI driver (`s3.csi.aws.com`) driver
- This driver does not exist on Azure AKS clusters
- The chart creates PersistentVolumes that reference this driver, causing pod mount failures

**Error Observed:**
```
FailedAttachVolume: pod/lake-mgr-0
AttachVolume.Attach failed for volume "s3-lake" : 
timed out waiting for external-attacher of s3.csi.aws.com CSI driver to attach volume
```

**Location:**
- `charts/ingext-s3-lake/templates/s3_lake.yaml` line 19: `driver: s3.csi.aws.com`

**Impact:**
- `ingext-lake-mgr` pods cannot start (stuck in ContainerCreating)
- `ingext-lake-worker` pods cannot start (stuck in ContainerCreating)
- Helm install times out waiting for pods to become ready

### 2. **Missing Azure Blob Storage Support**

**Problem:**
- Azure uses Blob Storage, not S3
- Azure Blob Storage access is handled via:
  - Managed Identity (User-Assigned)
  - Workload Identity (for pods)
  - Service Account with federated identity credentials
- No equivalent CSI driver for Azure Blob Storage exists in the charts

**Current Workaround:**
- We skip `ingext-s3-lake` installation on Azure
- Blob Storage access is configured via Managed Identity (see `setup_ingext_serviceaccount.sh`)
- However, the datalake charts still expect the S3 volume mount

### 3. **Missing ConfigMap Dependency**

**Problem:**
- Pods are looking for `ingext-community-config` ConfigMap
- This ConfigMap is created by `ingext-community-config` chart
- The datalake installation doesn't include this chart

**Error Observed:**
```
FailedMount: pod/lake-worker-6cd8c87f5b-kqrgb
MountVolume.SetUp failed for volume "config-volume" : 
configmap "ingext-community-config" not found
```

**Question:**
- Is `ingext-community-config` required for datalake components?
- Or is this a dependency that should be optional?

## Recommended Solutions

### Option 1: Make Charts Cloud-Agnostic (Preferred)

1. **Add Azure Blob Storage Support to Charts:**
   - Create Azure Blob Storage volume mount option (without CSI driver)
   - Use Azure Blob Storage SDK/API directly in application code
   - Configure via Managed Identity credentials

2. **Make Storage Backend Configurable:**
   - Add `storageBackend` value: `s3` | `blob` | `auto-detect`
   - Conditionally create S3 CSI volumes only for AWS
   - Use native Azure Blob Storage access for Azure

3. **Update Chart Templates:**
   - Make `ingext-s3-lake` optional or cloud-aware
   - Add Azure Blob Storage configuration to `ingext-lake-config`
   - Update `ingext-lake-mgr` and `ingext-lake-worker` to handle both storage backends

### Option 2: Create Azure-Specific Charts

1. **Create `ingext-blob-lake` Chart:**
   - Similar to `ingext-s3-lake` but for Azure Blob Storage
   - Uses Azure Blob Storage SDK instead of CSI driver
   - Configured via Managed Identity

2. **Update Installation Scripts:**
   - Detect cloud provider
   - Install appropriate storage chart (`ingext-s3-lake` for AWS, `ingext-blob-lake` for Azure)

### Option 3: Document Azure Limitations

1. **Update Documentation:**
   - Clearly state that datalake components require AWS S3 CSI driver
   - Provide Azure workaround instructions
   - Or mark Azure as "not supported" for datalake

## Current Workaround

We have modified `install_helm_charts.sh` to:
- Skip `ingext-s3-lake` installation on Azure
- This prevents the CSI driver errors
- However, pods still fail because they expect the volume mount

**Next Steps Needed:**
- Determine if datalake components can work without the S3/Blob volume mount
- Or provide Azure Blob Storage integration in the charts

## Environment Details

- **Cloud Provider:** Azure AKS
- **Kubernetes Version:** v1.33.5
- **Storage Account:** Configured with Managed Identity
- **Service Account:** Configured with Workload Identity
- **Node Pools:** Ready and available (poolmerge, poolsearch)

## Files Modified

- `datalake/azure/install_helm_charts.sh` - Skips `ingext-s3-lake` installation

## Questions for Developer

1. Can `ingext-lake-mgr` and `ingext-lake-worker` work without the S3/Blob volume mount?
2. Is there a way to configure these charts to use Azure Blob Storage directly (via SDK) instead of CSI driver?
3. Is `ingext-community-config` required for datalake components, or can it be optional?
4. What is the recommended approach for multi-cloud support in these charts?

## Contact

If you need more details or logs, please let me know. The installation is currently blocked until these storage backend issues are resolved.

