# Testing ALB Readiness

This guide explains how to test when the AWS Application Load Balancer (ALB) is ready and working after installation.

## Quick Test

Run the standalone test script:

```bash
cd skills/lakehouse-aws
npx tsx scripts/test-alb-readiness.ts
```

This will:
1. ✅ Check if ALB hostname is assigned in Kubernetes ingress
2. ✅ Verify ALB is in "active" state in AWS
3. ✅ Test HTTP connectivity to the ALB
4. ✅ (Optional) Test DNS resolution

## Options

### Wait for Provisioning

If the ALB is still provisioning, use `--wait` to wait up to 5 minutes:

```bash
npx tsx scripts/test-alb-readiness.ts --wait
```

### Test DNS Resolution

To also test if DNS is configured correctly:

```bash
npx tsx scripts/test-alb-readiness.ts --test-dns
```

### Quiet Mode

Suppress verbose output:

```bash
npx tsx scripts/test-alb-readiness.ts --quiet
```

## What Gets Tested

### 1. ALB Hostname Assignment

Checks if the Kubernetes ingress has an ALB hostname assigned:

```bash
kubectl get ingress -n ingext -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}'
```

**Expected output:**
```
alb-ingext-community-ingress-1272942931.us-east-2.elb.amazonaws.com
```

**If empty:** ALB is still provisioning (wait 2-5 minutes)

### 2. ALB State in AWS

Verifies the ALB is in "active" state using AWS API:

```bash
aws elbv2 describe-load-balancers --query "LoadBalancers[?DNSName=='<hostname>'].State.Code" --output text
```

**Expected:** `active`

**If "provisioning":** ALB is still being created (wait 2-5 minutes)

### 3. HTTP Connectivity Test

Tests if the ALB accepts HTTP connections:

```bash
curl -k -s -o /dev/null -w "%{http_code}" https://<alb-hostname>/health-check
```

**Expected:** HTTP status code 200-499 (2xx, 3xx, 4xx indicate ALB is working)

**If connection fails:** 
- Check if backend pods are running: `kubectl get pods -n ingext`
- Check ALB target group health in AWS Console
- Verify security groups allow traffic

### 4. DNS Resolution (Optional)

Tests if the domain resolves to the ALB:

```bash
dig +short <site-domain>
# or
nslookup <site-domain>
```

**Expected:** Returns the ALB hostname or IP address

**If DNS fails:** Configure DNS to point to the ALB hostname

## Integration with Install

Phase 7 (Ingress) can optionally wait for ALB readiness and test connectivity:

```typescript
// In phase7-ingress.ts
await runPhase7Ingress(env, {
  waitForALB: true,        // Wait for ALB to be provisioned
  testALBConnectivity: true // Test HTTP connectivity
});
```

## Manual Testing

### Check Ingress Status

```bash
kubectl get ingress -n ingext
```

Look for:
- **ADDRESS** column should show the ALB hostname
- If empty, ALB is still provisioning

### Check ALB in AWS Console

1. Go to **EC2 > Load Balancers**
2. Find the ALB (name starts with `albingext...`)
3. Check **State** column - should be "active"
4. Check **Target Groups** - verify targets are healthy

### Test HTTP Connectivity

```bash
# Get ALB hostname
ALB_HOSTNAME=$(kubectl get ingress -n ingext -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}')

# Test connectivity
curl -k https://$ALB_HOSTNAME/health-check
```

**Expected:** HTTP response (200, 401, 404, etc. - any response means ALB is working)

### Test with Domain (if DNS configured)

```bash
curl -k https://<site-domain>/health-check
```

## Troubleshooting

### ALB Hostname Not Appearing

**Symptom:** `kubectl get ingress` shows no ADDRESS

**Solutions:**
1. Wait 2-5 minutes (ALB provisioning takes time)
2. Check AWS Load Balancer Controller logs:
   ```bash
   kubectl logs -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
   ```
3. Verify ALB Controller is running:
   ```bash
   kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-load-balancer-controller
   ```

### ALB State is "provisioning" for > 5 minutes

**Symptom:** ALB hostname exists but AWS shows "provisioning"

**Solutions:**
1. Check AWS Console for errors
2. Verify VPC and subnets are correct
3. Check security groups allow traffic
4. Verify IAM permissions for ALB Controller

### HTTP Test Fails

**Symptom:** ALB hostname exists but `curl` fails

**Solutions:**
1. Check backend pods are running:
   ```bash
   kubectl get pods -n ingext
   ```
2. Check ALB target group health in AWS Console
3. Verify security groups allow traffic from ALB to pods
4. Check ingress rules and paths:
   ```bash
   kubectl describe ingress -n ingext
   ```

### DNS Not Resolving

**Symptom:** Domain doesn't resolve to ALB

**Solutions:**
1. Configure DNS record (CNAME or A record):
   ```bash
   npx tsx scripts/configure-dns.ts
   ```
2. Wait for DNS propagation (can take 5-60 minutes)
3. Check DNS with `dig` or `nslookup`

## Status Command Integration

The `lakehouse status` command shows ALB status:

```bash
npm run dev -- --action status --exec docker
```

Look for the **Networking & SSL** section:
- ✅ **Load Balancer: DEPLOYED** - ALB is ready
- ⏳ **Load Balancer: PROVISIONING** - ALB is still being created
- ❌ **Load Balancer: MISSING** - Ingress not installed

## Example Output

### Successful Test

```
🧪 Testing ALB Readiness
============================================================

Namespace: ingext
Domain: lakehouse.k8.ingext.io

   Checking ingress for ALB hostname...
   Checking ALB state in AWS for alb-xxx-xxx.us-east-2.elb.amazonaws.com...
   Testing HTTP connectivity to alb-xxx-xxx.us-east-2.elb.amazonaws.com...

============================================================
Test Results
============================================================

✅ ALB is READY and working

   Hostname: alb-xxx-xxx.us-east-2.elb.amazonaws.com
   State: ACTIVE
   HTTP Test: 200 (OK)
   DNS Test: Resolves to alb-xxx-xxx.us-east-2.elb.amazonaws.com

   ALB is ready and working. Hostname: alb-xxx-xxx.us-east-2.elb.amazonaws.com
```

### Provisioning (Not Ready)

```
❌ ALB is NOT ready

   State: PROVISIONING

   ALB hostname assigned but ALB is still provisioning in AWS. This typically takes 2-5 minutes.

💡 Tips:
   - ALB provisioning typically takes 2-5 minutes
   - Run with --wait to wait for provisioning
   - Check status: kubectl get ingress -n ingext
```
