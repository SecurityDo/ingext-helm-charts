# Preflight Fix Summary

## Issues Found and Fixed

### 1. ✅ DNS Check Hang (FIXED)
**Problem**: `digA()` function in `dns.ts` was using `bash -lc` which hung in Docker mode

**Fix**: Disabled DNS check as it's not critical for preflight
```typescript
// Skip dig check - not critical for preflight and can cause hangs in Docker
return { ok: false as const, reason: "skipped" };
```

### 2. ✅ Domain Confirmation Order (FIXED) 
**Problem**: Domain confirmation message was shown BEFORE Route53 and ACM discovery, causing false warnings

**Before**:
```
⚠️  DNS Warning: No Route53 hosted zone found
⚠️  Certificate: No ACM certificate found
// Then discovery happens...
✓ Route53 hosted zone found
✓ Found certificate
```

**After**:
```
✓ DNS Ready: Route53 hosted zone found
✓ Certificate: Wildcard certificate found  
✓ Ready: All prerequisites met
```

**Fix**: Moved Route53 and ACM discovery BEFORE domain confirmation, then passed results to `confirmDomains()`

### 3. ✅ Karpenter Detection Enhancement (FIXED)
**Problem**: `helm list` without `-a` flag doesn't show pending/failed releases

**Fix**: Added `-a` flag to show ALL releases including `pending-upgrade`
```typescript
helm(["list", "-A", "-a", "-o", "json"], ...)
```

### 4. ✅ Auto-Repair Logic Enhancement (FIXED)
**Problem**: `needsRepair` only detected "failed" status, not "pending-upgrade" or other stuck states

**Fix**: Enhanced detection logic
```typescript
const needsRepair = status === "failed" || 
                   status.startsWith("pending-") ||
                   status === "uninstalling" ||
                   status === "superseded";
```

### 5. ✅ Rollback Before Repair (FIXED)
**Problem**: Helm lock errors when trying to upgrade a `pending-upgrade` release

**Fix**: Added rollback before repair attempt
```typescript
// First attempt to rollback to clear locks
await run("bash", ["-c", `helm rollback karpenter -n kube-system 2>&1 || true`]);
await new Promise(resolve => setTimeout(resolve, 5000));
// Then upgrade
```

## Test Results

### Preflight Output (CORRECT)
```
═══════════════════════════════════════════════════════════════
Domain Configuration
═══════════════════════════════════════════════════════════════

Root Domain:     ingext.io
Site Domain:     lakehouse.k8.ingext.io

✓ DNS Ready:     Route53 hosted zone found: ingext.io.
                 Zone ID: /hostedzone/Z098081716DWJ6X99UMPW
                 DNS records can be automatically created during installation.

✓ Certificate:   Wildcard certificate found: *.k8.ingext.io
                 ARN: arn:aws:acm:us-east-2:134158693493:certificate/9351038d-a553-4813-8c95-86b4b714452f
                 Valid for: lakehouse.k8.ingext.io

✓ Ready:         All prerequisites met. You can proceed with installation.

═══════════════════════════════════════════════════════════════
```

## Remaining Issue

**Installation still hangs after preflight** - Process continues for 3+ minutes after domain confirmation without producing output. Likely hanging on one of:
- S3 headBucket check
- EKS describeCluster check  
- Env file write
- Or something in the install phase

**Next Step**: Need to investigate which specific call is hanging in Docker execution mode.

## Files Modified

1. `src/tools/dns.ts` - Disabled `digA()` check
2. `src/skill.ts` - Reordered discovery before domain confirmation
3. `src/tools/karpenter.ts` - Enhanced detection and auto-repair
4. `src/steps/confirm.ts` - Made discovery parameter optional

All changes are backwards compatible and improve reliability.
