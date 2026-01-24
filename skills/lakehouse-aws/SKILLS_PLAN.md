# Lakehouse AWS Skills Plan

## Current Status

### ✅ Completed
- **Preflight Skill** (`src/skill.ts`) - Validates AWS auth, required variables, and readiness

## Skills to Create

### 1. Install Skill (Multi-Phase)
The `install-lakehouse.sh` script has 7 distinct phases that should be converted to skills:

#### Phase 1: Foundation (EKS)
- Create/verify EKS cluster
- Install EKS addons (pod-identity-agent, EBS CSI driver)
- Create StorageClass (GP3)
- Install S3 CSI driver
- Update kubeconfig

#### Phase 2: Storage (S3 & IAM)
- Create S3 bucket (if doesn't exist)
- Create IAM policy for S3 access
- Create pod identity association for service account

#### Phase 3: Compute (Karpenter)
- Setup Karpenter (calls external script: `../datalake/aws/setup_karpenter.sh`)

#### Phase 4: Core Services
- Create namespace
- Install service account
- Create app-secret token
- Install: ingext-stack, etcd-single, etcd-single-cronjob
- Wait for pods ready

#### Phase 5: Application (Stream)
- Install: ingext-community-config, ingext-community-init, ingext-community
- Wait for pods ready

#### Phase 6: Application (Datalake)
- Install: ingext-lake-config, ingext-merge-pool, ingext-search-pool
- Install: ingext-manager-role, ingext-s3-lake, ingext-lake

#### Phase 7: Ingress
- Create IAM policy for Load Balancer Controller
- Create pod identity association for LBC
- Install AWS Load Balancer Controller
- Install ingext-ingress with cert ARN
- Configure ingext CLI context

**Recommendation**: Create one `install` skill with 7 phases, or 7 separate phase skills that can be orchestrated.

### 2. Status Skill
Convert `lakehouse-status.sh` to a skill that:
- Checks EKS cluster status
- Checks S3 bucket status
- Checks Kubernetes pod status (Core Services, Stream, Datalake)
- Checks Load Balancer status
- Checks ACM certificate status
- Returns structured JSON with component health

### 3. Logs Skill
Convert `lakehouse-logs.sh` to a skill that:
- Retrieves logs for specific components (api, platform, fluency, lake, lb)
- Supports filtering by component
- Supports error filtering
- Returns structured log output

### 4. Cleanup Skill
Convert `cleanup-lakehouse.sh` to a skill that:
- Uninstalls all Helm releases
- Deletes EKS cluster
- Deletes S3 bucket
- Cleans up IAM roles and policies
- Cleans up EBS volumes
- Requires confirmation before destructive operations

### 5. ACM Certificate Setup Skill (Helper)
Based on `ACM_SETUP.md`, create a skill that:
- Guides user through ACM certificate request
- Validates certificate ARN format
- Checks certificate status
- Provides remediation if certificate is pending

### 6. Route53 DNS Setup Skill (Helper)
Based on `ROUTE53_SETUP.md`, create a skill that:
- Guides user through Route53 DNS configuration
- Creates Alias A record pointing to ALB
- Validates DNS propagation
- Tests HTTPS connection

### 7. Add User Access Skill
Convert `add-user-access.sh` to a skill that:
- Grants IAM user ClusterAdmin access to EKS
- Creates EKS access entry
- Associates cluster admin policy

## Default Values & Suggestions

From `preflight-lakehouse.sh` and `install-lakehouse.sh`:

### Defaults
```typescript
{
  awsProfile: "default",
  awsRegion: "us-east-2",
  clusterName: "ingext-lakehouse",  // sanitized to lowercase alphanumeric
  s3Bucket: "ingext-lakehouse-{accountId}",  // templated from account ID
  siteDomain: "lakehouse.k8.ingext.io",
  namespace: "ingext",  // sanitized to lowercase alphanumeric
  nodeType: "t3.large",
  nodeCount: 2,
  certArn: "",  // required, no default
}
```

### Instance Recommendations
From preflight script:
- **m5a.large (AMD EPYC)** - Recommended for general purpose
- **t3.large (Intel)** - Cost-effective for testing

### EKS Version
- Default: `1.34` (from install script)

### Node Group
- Name: `standardworkers`
- Type: Managed node group

### Readiness Defaults
```typescript
{
  hasBilling: true,
  hasAdmin: true,
  hasDns: true,
}
```

## Instructions for Defaults

### Domain Naming Convention
- Pattern: `{service}.k8.ingext.io`
- Example: `lakehouse.k8.ingext.io`
- AI can suggest: `{cluster-name}.k8.ingext.io` or `{namespace}.k8.ingext.io`

### S3 Bucket Naming
- Pattern: `ingext-lakehouse-{accountId}`
- Sanitized: lowercase, alphanumeric only
- AI can suggest based on cluster name and account ID

### Cluster Naming
- Default: `ingext-lakehouse`
- Sanitized: lowercase, alphanumeric only
- AI can suggest variations if default is taken

### Namespace
- Default: `ingext`
- Sanitized: lowercase, alphanumeric only
- Should match Kubernetes namespace conventions

## Skill Architecture Recommendations

### Install Skill Structure
```
src/
  steps/
    install/
      phase1-foundation.ts    # EKS cluster & addons
      phase2-storage.ts        # S3 & IAM
      phase3-compute.ts        # Karpenter
      phase4-core-services.ts # Redis, OpenSearch, etc.
      phase5-stream.ts         # Ingext Stream
      phase6-datalake.ts      # Ingext Datalake
      phase7-ingress.ts       # ALB & Ingress
```

### Status Skill Structure
```
src/
  steps/
    status/
      check-infrastructure.ts  # EKS, S3
      check-pods.ts            # Kubernetes pods
      check-networking.ts      # ALB, DNS, Cert
```

### Tools Needed
- `tools/kubectl.ts` - Kubernetes operations
- `tools/helm.ts` - Helm chart operations
- `tools/eksctl.ts` - EKS cluster operations
- `tools/iam.ts` - IAM role/policy operations
- `tools/acm.ts` - Certificate operations
- `tools/route53.ts` - DNS operations

## Next Steps

1. **Priority 1**: Install Skill (Phase 1: Foundation) - Most critical
2. **Priority 2**: Status Skill - For monitoring/debugging
3. **Priority 3**: Install Skill (Phases 2-7) - Complete installation
4. **Priority 4**: Logs Skill - For troubleshooting
5. **Priority 5**: Cleanup Skill - For teardown
6. **Priority 6**: Helper Skills (ACM, Route53, Add User) - Nice to have
