# Operator-Grade Phase 3 - Test Plan & Verification

This document outlines the test scenarios and expected behavior for the operator-grade Phase 3 implementation.

## Test 1: Platform Health Gate with No Nodes

### Scenario
Cluster exists but has zero worker nodes (EKS control plane only, or nodes failed to create).

### Test Command
```bash
cd skills/lakehouse-aws
npm run dev -- --action install --approve true
```

### Expected Behavior

1. **Phase 1 completes** but creates a blocker if nodes are missing:
   - Evidence includes: `nodeCount: 0`, `nodesReady: 0`
   - Blocker code: `NO_NODES_CREATED`
   - Message: "EKS cluster created but no worker nodes found. Check eksctl logs."

2. **Phase 2 completes** (S3 bucket creation is independent of nodes)

3. **Phase 3 stops immediately** at platform health check:
   - Status: `blocked_phase` (not `error`)
   - Phase: `compute`
   - Blockers include:
     - Code: `NO_NODES_AVAILABLE`
     - Message: "Cluster has no worker nodes. Phase 1 may have failed to create node group."
     - Code: `PHASE1_INCOMPLETE`
     - Message: "Phase 1 may not have completed successfully. Re-run Phase 1 or check eksctl logs."
   - Next action: `fix` with phase: `foundation`

4. **Evidence structure**:
```json
{
  "phase3": {
    "platform": {
      "nodesTotal": 0,
      "nodesReady": 0,
      "corednsReady": false,
      "platformHealthy": false
    },
    "karpenter": {
      "release": { "exists": false, "status": "unknown", "revision": 0 },
      "existed": false,
      "installed": false,
      "needsRepair": false,
      "repairAttempted": false,
      "repairSucceeded": false,
      "version": "unknown",
      "namespace": "kube-system",
      "controllerReady": false,
      "scriptRan": false,
      "pendingPods": []
    }
  }
}
```

### Verification Points
- ✅ Phase 3 does NOT proceed past platform health check
- ✅ Status is `blocked_phase` not `error`
- ✅ Remediation message points to Phase 1
- ✅ No Karpenter installation is attempted
- ✅ Evidence shows platform is unhealthy

### Code References
- Platform health check: `src/tools/platform.ts:checkPlatformHealth()`
- Phase 3 logic: `src/steps/install/phase3-compute.ts` lines 67-85
- Status handling: `src/install.ts` lines 112-130

---

## Test 2: Auto-Repair for Failed Helm Release

### Scenario
Karpenter Helm release exists but has status "failed" (e.g., previous installation timed out or failed mid-deployment).

### Setup
To simulate this scenario, manually create a failed Helm release:
```bash
# Install Karpenter with very short timeout to force failure
helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
  --version 1.8.3 \
  --namespace kube-system \
  --create-namespace \
  --set settings.clusterName=testcluster \
  --wait --timeout 5s
```

### Test Command
```bash
cd skills/lakehouse-aws
npm run dev -- --action install --approve true
```

### Expected Behavior

1. **Phase 3 detects failed release**:
   - `checkKarpenterInstalled()` returns:
     - `exists: true`
     - `installed: false`
     - `needsRepair: true`
     - `status: "failed"`

2. **Auto-repair is triggered**:
   - Evidence: `repairAttempted: true`
   - Runs `repairKarpenter()` with 10-minute timeout
   - Uses `helm upgrade --install` with full parameters

3. **If repair succeeds**:
   - Evidence: `repairSucceeded: true`
   - Evidence: `installed: true`
   - Evidence: `release.status: "deployed"`
   - Phase 3 continues to readiness check

4. **If repair fails**:
   - Evidence: `repairSucceeded: false`
   - Status: `error`
   - Blocker code: `KARPENTER_REPAIR_FAILED`
   - Message includes last 5 lines of stderr

### Evidence Structure (Success Case)
```json
{
  "karpenter": {
    "release": { "exists": true, "status": "deployed", "revision": 2 },
    "existed": true,
    "installed": true,
    "needsRepair": true,
    "repairAttempted": true,
    "repairSucceeded": true,
    "version": "1.8.3",
    "namespace": "kube-system",
    "controllerReady": true,
    "scriptRan": false,
    "pendingPods": []
  }
}
```

### Verification Points
- ✅ Failed Helm release is detected
- ✅ Auto-repair is attempted automatically
- ✅ Repair uses longer timeout (10m vs default)
- ✅ Evidence tracks repair attempt and result
- ✅ Phase continues if repair succeeds
- ✅ Phase stops with error if repair fails

### Code References
- Status detection: `src/tools/karpenter.ts:checkKarpenterInstalled()` lines 10-64
- Repair function: `src/tools/karpenter.ts:repairKarpenter()` lines 66-84
- Repair logic: `src/steps/install/phase3-compute.ts` lines 99-122

---

## Test 3: Phase 3 Only Completes When Controller is Ready

### Scenario
Karpenter is installed but pods are Pending or Not Ready (e.g., due to resource constraints, image pull issues, or scheduling problems).

### Test Command
```bash
cd skills/lakehouse-aws
npm run dev -- --action install --approve true
```

### Expected Behavior

1. **Karpenter installs successfully**:
   - Helm status: `deployed`
   - Evidence: `installed: true`
   - Evidence: `scriptRan: true` (if fresh install)

2. **Readiness check fails**:
   - `checkKarpenterReady()` calls: `kubectl rollout status deployment/karpenter`
   - Returns: `ready: false`
   - Evidence: `controllerReady: false`

3. **Pod events are captured**:
   - Calls `getPodsInNamespace()` with label: `app.kubernetes.io/name=karpenter`
   - For each Pending pod, calls `getPodEvents()`
   - Evidence: `pendingPods` array populated with pod names and events

4. **Blocker includes diagnostic information**:
   - Code: `KARPENTER_NOT_READY`
   - Message: "Karpenter controller deployment is not ready."
   - If FailedScheduling event found, message includes:
     ```
     Scheduling issue:
     <event details from kubectl describe>
     
     Check: kubectl describe pod -n kube-system -l app.kubernetes.io/name=karpenter
     ```

5. **Phase 3 returns `ok: false`**:
   - Status: `error` (not blocked_phase, since dependencies are met)
   - Phase progression is blocked

### Evidence Structure (Not Ready Case)
```json
{
  "karpenter": {
    "release": { "exists": true, "status": "deployed", "revision": 1 },
    "existed": false,
    "installed": true,
    "needsRepair": false,
    "repairAttempted": false,
    "repairSucceeded": false,
    "version": "1.8.3",
    "namespace": "kube-system",
    "controllerReady": false,
    "scriptRan": true,
    "pendingPods": [
      {
        "name": "karpenter-7d9f8c5b6d-abc12",
        "events": "Events:\n  Type     Reason            Message\n  ----     ------            -------\n  Warning  FailedScheduling  no nodes available to schedule pods"
      }
    ]
  }
}
```

### Only Ready Case Returns Success
When `controllerReady: true`:
- Phase 3 returns: `ok: true`
- Status: `completed_phase`
- Next phase: `core_services`

### Verification Points
- ✅ Helm status "deployed" is not sufficient for completion
- ✅ Controller deployment readiness is checked
- ✅ Pod events are captured for Pending pods
- ✅ Blockers include actionable diagnostic information
- ✅ Phase 3 only returns ok: true when `controllerReady: true`
- ✅ Status tool shows detailed Karpenter health

### Code References
- Readiness check: `src/tools/karpenter.ts:checkKarpenterReady()` lines 86-92
- Pod events: `src/tools/kubectl.ts:getPodEvents()` lines 19-38
- Pod listing: `src/tools/kubectl.ts:getPodsInNamespace()` lines 40-58
- Phase 3 logic: `src/steps/install/phase3-compute.ts` lines 151-200
- Final gate: `src/steps/install/phase3-compute.ts` line 203

---

## Status Command Verification

After implementing the changes, the status command should show enhanced Karpenter details:

```bash
npm run dev -- --action status
```

### Expected Output (Healthy State)
```json
{
  "kubernetes": {
    "karpenter": {
      "status": "deployed",
      "version": "1.8.3",
      "namespace": "kube-system",
      "controllerReady": true
    }
  },
  "readiness": {
    "phase3Compute": true
  }
}
```

### Expected Output (Degraded State)
```json
{
  "kubernetes": {
    "karpenter": {
      "status": "deployed",
      "version": "1.8.3",
      "namespace": "kube-system",
      "controllerReady": false
    }
  },
  "readiness": {
    "phase3Compute": false
  },
  "nextSteps": [
    "Karpenter is installed but controller is not ready. Check: kubectl describe deployment karpenter -n kube-system"
  ]
}
```

---

## Success Criteria Summary

| Criterion | Implementation | Test |
|-----------|---------------|------|
| Platform health gate | ✅ `checkPlatformHealth()` | Test 1 |
| Helm status checking | ✅ `checkKarpenterInstalled()` returns detailed status | Test 2 |
| Auto-repair function | ✅ `repairKarpenter()` with 10m timeout | Test 2 |
| Pod events capture | ✅ `getPodEvents()` and `getPodsInNamespace()` | Test 3 |
| Readiness gate | ✅ Phase only completes when `controllerReady: true` | Test 3 |
| Blocked vs Error status | ✅ `blocked_phase` for dependency issues, `error` for failures | Test 1 |
| Evidence structure | ✅ Comprehensive platform + karpenter + pods | All tests |
| Actionable blockers | ✅ Includes remediation steps and kubectl commands | All tests |

---

## Running the Tests

### Prerequisites
- AWS CLI configured with profile
- kubectl configured
- eksctl installed
- helm installed
- Sufficient AWS permissions (EKS, S3, IAM)

### Test Sequence

1. **Test Platform Health Gate**:
   ```bash
   # If cluster has no nodes, run directly
   npm run dev -- --action install --approve true --root-domain your-domain.com
   
   # Or, manually drain nodes first:
   kubectl drain --all --ignore-daemonsets --delete-emptydir-data
   kubectl delete nodes --all
   npm run dev -- --action install --approve true --root-domain your-domain.com
   ```

2. **Test Auto-Repair**:
   ```bash
   # Create a failed Helm release
   helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \
     --version 1.8.3 --namespace kube-system --create-namespace \
     --set settings.clusterName=yourcluster --wait --timeout 5s || true
   
   # Verify it's failed
   helm list -n kube-system
   
   # Run install (should auto-repair)
   npm run dev -- --action install --approve true --root-domain your-domain.com
   ```

3. **Test Readiness Gate**:
   ```bash
   # Install with nodes but constrained resources
   # This causes Karpenter pods to be Pending
   npm run dev -- --action install --approve true --root-domain your-domain.com
   
   # Check evidence shows controllerReady: false
   npm run dev -- --action status
   ```

---

## Debugging Commands

If any test fails, use these commands for diagnosis:

```bash
# Check cluster nodes
kubectl get nodes -o wide

# Check Karpenter Helm release
helm list -A
helm status karpenter -n kube-system

# Check Karpenter pods
kubectl get pods -n kube-system -l app.kubernetes.io/name=karpenter
kubectl describe pod -n kube-system -l app.kubernetes.io/name=karpenter

# Check Karpenter deployment
kubectl get deployment karpenter -n kube-system
kubectl rollout status deployment/karpenter -n kube-system

# Check pod events
kubectl get events -n kube-system --field-selector involvedObject.kind=Pod

# Check CoreDNS
kubectl get deployment coredns -n kube-system
```

---

## Rollback Procedure

If any test leaves the system in a bad state:

```bash
# Uninstall Karpenter
helm uninstall karpenter -n kube-system

# Delete cluster (if needed)
eksctl delete cluster --name yourcluster --region your-region

# Clean up S3 bucket
aws s3 rb s3://your-bucket --force
```
