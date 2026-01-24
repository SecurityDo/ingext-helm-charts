# Status Skill - Usage Guide

## Overview

The Status skill provides comprehensive visibility into your Lakehouse AWS deployment, showing what's deployed, what's ready to deploy, and what actions are needed next.

## Usage

```bash
npm run dev -- \
  --action status \
  --exec docker \
  --profile default \
  --region us-east-2 \
  --cluster your-cluster-name \
  --root-domain your-domain.com \
  --domain lakehouse.k8.your-domain.com \
  --namespace ingext \
  --bucket your-bucket-name
```

### Minimum Required Flags

```bash
npm run dev -- \
  --action status \
  --exec docker \
  --cluster your-cluster-name
```

All other flags have defaults:
- `--profile default`
- `--region us-east-2`
- `--namespace ingext`

## Output Structure

The skill returns a comprehensive JSON object with the following sections:

### 1. Cluster Status

```json
{
  "cluster": {
    "name": "testskillcluster",
    "status": "deployed",
    "details": {
      "eksStatus": "ACTIVE",
      "nodeCount": 2,
      "nodes": [
        { "name": "node-1", "status": "Ready" },
        { "name": "node-2", "status": "Ready" }
      ],
      "kubernetesVersion": "v1.34.0"
    }
  }
}
```

**Status Values:**
- `deployed` - Cluster is active and accessible
- `degraded` - Cluster is in CREATING or UPDATING state
- `missing` - Cluster doesn't exist
- `unknown` - Unable to determine status

### 2. Infrastructure Status

```json
{
  "infrastructure": {
    "s3": {
      "status": "deployed",
      "bucketName": "ingextlakehouse134158693493",
      "exists": true
    },
    "route53": {
      "status": "deployed",
      "zoneId": "/hostedzone/Z098...",
      "zoneName": "ingext.io."
    },
    "certificate": {
      "status": "deployed",
      "arn": "arn:aws:acm:...",
      "domain": "*.k8.ingext.io",
      "validFor": ["*.k8.ingext.io"]
    }
  }
}
```

### 3. Kubernetes Resources

```json
{
  "kubernetes": {
    "addons": {
      "status": "deployed",
      "items": [
        { "name": "eks-pod-identity-agent", "status": "deployed" },
        { "name": "aws-ebs-csi-driver", "status": "deployed" },
        { "name": "aws-mountpoint-s3-csi-driver", "status": "deployed" }
      ]
    },
    "storageClass": {
      "status": "deployed",
      "name": "ingext-aws-gp3"
    },
    "namespaces": [
      { "name": "ingext", "status": "deployed" },
      { "name": "kube-system", "status": "deployed" }
    ],
    "workloads": {
      "deployments": [
        {
          "name": "ingext-api",
          "namespace": "ingext",
          "ready": 2,
          "desired": 2,
          "status": "deployed"
        }
      ],
      "statefulSets": [],
      "pods": [
        {
          "name": "ingext-api-abc123",
          "namespace": "ingext",
          "status": "Running",
          "ready": true
        }
      ]
    }
  }
}
```

### 4. Helm Releases

```json
{
  "helm": {
    "releases": [
      {
        "name": "ingext-aws-gp3",
        "namespace": "kube-system",
        "chart": "ingext-aws-gp3-0.1.0",
        "status": "deployed",
        "revision": 1
      }
    ]
  }
}
```

### 5. Phase Readiness

```json
{
  "readiness": {
    "phase1Foundation": true,
    "phase2Storage": false,
    "phase3Compute": false,
    "phase4CoreServices": false,
    "phase5Stream": false,
    "phase6Datalake": false,
    "phase7Ingress": false
  }
}
```

**Readiness Logic:**
- `phase1Foundation` - Cluster deployed + addons deployed + StorageClass deployed
- `phase2Storage` - Phase 1 + S3 bucket exists
- `phase3Compute` - Phase 2 + Karpenter installed
- `phase4CoreServices` - Phase 3 + Core services (etcd, Redis, etc.)
- `phase5Stream` - Phase 4 + Stream applications
- `phase6Datalake` - Phase 5 + Datalake applications
- `phase7Ingress` - Phase 6 + Ingress/Load Balancer

### 6. Next Steps

```json
{
  "nextSteps": [
    "Ready for Phase 2: Storage (S3 bucket and IAM)"
  ]
}
```

The skill automatically generates actionable next steps based on the current deployment state.

## Examples

### Fresh Environment (Nothing Deployed)

```json
{
  "cluster": { "status": "missing" },
  "readiness": { "phase1Foundation": false },
  "nextSteps": [
    "Run: npm run dev -- --approve true (Phase 1: Foundation)",
    "Run Phase 1: Foundation to create EKS cluster"
  ]
}
```

### After Phase 1 Complete

```json
{
  "cluster": { "status": "deployed" },
  "infrastructure": {
    "s3": { "status": "missing" }
  },
  "readiness": { 
    "phase1Foundation": true,
    "phase2Storage": false
  },
  "nextSteps": [
    "Ready for Phase 2: Storage (S3 bucket and IAM)"
  ]
}
```

### Fully Deployed System

```json
{
  "cluster": { "status": "deployed" },
  "readiness": {
    "phase1Foundation": true,
    "phase2Storage": true,
    "phase3Compute": true,
    "phase4CoreServices": true,
    "phase5Stream": true,
    "phase6Datalake": true,
    "phase7Ingress": true
  },
  "nextSteps": [
    "✅ All phases complete! Lakehouse is fully deployed."
  ]
}
```

## Integration with AI Agent

The status skill is designed to be read by AI agents to understand the current state and decide what to do next:

```typescript
// AI can check readiness
if (status.readiness.phase1Foundation === false) {
  // Run Phase 1
} else if (status.readiness.phase2Storage === false) {
  // Run Phase 2
} // ... etc
```

## Use Cases

1. **Pre-flight Check**: Before running install, check what already exists
2. **Progress Tracking**: Monitor deployment progress across phases
3. **Debugging**: Identify which components are deployed vs. missing
4. **Resume Installation**: Determine which phase to start from after interruption
5. **Health Monitoring**: Check cluster and workload health

## Performance

- Execution time: ~30-40 seconds for full check
- Works in Docker mode (no host dependencies)
- Caches nothing (always shows real-time state)

## Limitations

- Only checks resources in specified namespace
- Doesn't check application-level health (e.g., HTTP endpoints)
- Doesn't validate data integrity
- Limited to resources the skill knows about

## Troubleshooting

### "Cluster status: missing" but cluster exists

**Cause**: AWS credentials not properly configured

**Fix**: 
```bash
aws configure --profile default
# or
aws sso login --profile default
```

### Addon status shows "missing" but deployed via eksctl

**Cause**: Addon pods don't have the expected label

**Fix**: The status check looks for `app.kubernetes.io/name=<addon-name>` labels. Verify your addon pods have these labels.

### StorageClass shows "missing" but Helm release exists

**Workaround**: The readiness check accounts for this - it considers both kubectl and Helm status. Phase 1 will still show as complete if the Helm release is deployed.

## See Also

- [Preflight Skill](./README.md) - Validate readiness before install
- [Install Skill](./IMPLEMENTATION_SUMMARY.md) - Deploy Lakehouse components
- [SKILLS_PLAN.md](./SKILLS_PLAN.md) - Roadmap for future skills
