# Lakehouse AWS Skill - Current Status

## ✅ What's Complete

### Preflight Skill (Fully Functional)
**Location**: `src/skill.ts` + `bin/run.ts`

**What it does:**
1. ✅ **AWS Authentication** (`src/steps/auth.ts`)
   - Validates AWS credentials FIRST before any operations
   - Provides clear error messages and remediation steps
   - Returns AWS identity (account ID, ARN)

2. ✅ **Domain Configuration** (`src/steps/confirm.ts`)
   - Requests root domain from user (e.g., `ingext.io`, `example.com`)
   - Constructs site domain as `lakehouse.k8.{rootDomain}` if not provided
   - Shows clear confirmation message explaining domains
   - Validates domain formats

3. ✅ **Variable Validation** (`src/steps/collect.ts`)
   - Validates all required variables (cert ARN, cluster name, etc.)
   - Checks domain formats
   - Validates node configuration
   - Provides specific remediation for each issue

4. ✅ **Resource Checks**
   - Checks S3 bucket existence
   - Checks EKS cluster status
   - Checks DNS A records (optional)

5. ✅ **Environment File Generation**
   - Writes `lakehouse-aws.env` with all configuration
   - Includes both `ROOT_DOMAIN` and `SITE_DOMAIN`
   - Only writes if preflight passes

**Current Structure:**
```
src/
  ├── skill.ts              # Main preflight orchestration
  ├── schema.ts             # Input validation schema
  ├── steps/
  │   ├── auth.ts           # ✅ AWS authentication
  │   ├── collect.ts        # ✅ Variable validation
  │   ├── confirm.ts        # ✅ Domain confirmation
  │   └── writeEnv.ts       # (exists but not used yet)
  └── tools/
      ├── aws.ts            # ✅ AWS CLI wrappers
      ├── dns.ts            # ✅ DNS checks
      ├── file.ts            # ✅ File operations
      └── shell.ts           # ✅ Shell command execution
```

**Usage:**
```bash
npm run dev -- \
  --profile default \
  --region us-east-2 \
  --cluster ingext-lakehouse \
  --root-domain ingext.io \
  --cert-arn arn:aws:acm:... \
  --overwrite-env true
```

## 🚧 What's Next (Priority Order)

### 1. Install Skill - Phase 1: Foundation (HIGHEST PRIORITY)
**Goal**: Create EKS cluster and install foundational components

**What needs to be built:**
- New skill file: `src/install.ts` (or separate install skill)
- Tools needed:
  - `tools/eksctl.ts` - EKS cluster operations
  - `tools/kubectl.ts` - Kubernetes operations  
  - `tools/helm.ts` - Helm chart operations
- Steps needed:
  - `steps/install/phase1-foundation.ts`
    - Create/verify EKS cluster via eksctl
    - Install EKS addons (pod-identity-agent, EBS CSI driver)
    - Create StorageClass (GP3)
    - Install S3 CSI driver
    - Update kubeconfig

**Reference**: `lakehouse-aws/install-lakehouse.sh` lines 86-121

### 2. Install Skill - Phases 2-7
**Phases to implement:**
- Phase 2: Storage (S3 bucket, IAM roles/policies)
- Phase 3: Compute (Karpenter setup)
- Phase 4: Core Services (Redis, OpenSearch, etcd)
- Phase 5: Application Stream (ingext-community charts)
- Phase 6: Application Datalake (ingext-lake charts)
- Phase 7: Ingress (ALB, Load Balancer Controller)

**Reference**: `lakehouse-aws/install-lakehouse.sh` lines 123-264

### 3. Status Skill
**Goal**: Check health of all deployed components

**What needs to be built:**
- New skill: `src/status.ts`
- Tools: `tools/kubectl.ts` (for pod status)
- Steps:
  - Check EKS cluster status
  - Check S3 bucket status
  - Check Kubernetes pod status
  - Check Load Balancer status
  - Check ACM certificate status

**Reference**: `lakehouse-aws/lakehouse-status.sh`

### 4. Logs Skill
**Goal**: Retrieve logs for troubleshooting

**What needs to be built:**
- New skill: `src/logs.ts`
- Tools: `tools/kubectl.ts` (for log retrieval)
- Support filtering by component (api, platform, lake, etc.)

**Reference**: `lakehouse-aws/lakehouse-logs.sh`

### 5. Cleanup Skill
**Goal**: Tear down entire deployment

**What needs to be built:**
- New skill: `src/cleanup.ts`
- Tools: `tools/eksctl.ts`, `tools/helm.ts`, `tools/aws.ts`
- Requires confirmation before destructive operations

**Reference**: `lakehouse-aws/cleanup-lakehouse.sh`

### 6. Helper Skills (Lower Priority)
- ACM Certificate Setup (guided certificate request)
- Route53 DNS Setup (guided DNS configuration)
- Add User Access (grant EKS access)

## 📋 Current Capabilities

### What the AI Can Do Right Now:
1. ✅ **Validate readiness** - Check AWS auth, required variables, domain config
2. ✅ **Generate config** - Create `lakehouse-aws.env` file
3. ✅ **Confirm domains** - Show user what domains will be used
4. ✅ **Check resources** - Verify S3/EKS/DNS status

### What the AI Cannot Do Yet:
1. ❌ **Install anything** - No install skill yet
2. ❌ **Check status** - No status skill yet
3. ❌ **View logs** - No logs skill yet
4. ❌ **Cleanup** - No cleanup skill yet

## 🎯 Recommended Next Steps

**Immediate Focus**: Build Install Skill Phase 1 (Foundation)

This is the most critical missing piece because:
- Preflight validates everything is ready
- But there's no way to actually install yet
- Phase 1 creates the EKS cluster (foundation for everything else)

**After Phase 1**: Continue with remaining install phases, then status/logs/cleanup

## 📝 Notes

- All defaults match the bash scripts (`preflight-lakehouse.sh`, `install-lakehouse.sh`)
- Domain handling now properly requests root domain and constructs site domain
- Preflight skill is production-ready and fully tested
- Architecture is modular (steps + tools) for easy extension
