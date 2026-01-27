# `lakehouse url` Command

Get the URL for your lakehouse deployment, including the ALB hostname and configured domain.

## Usage

```bash
lakehouse url
```

## Examples

### Basic Usage

Get the ALB URL:

```bash
lakehouse url
```

**Output:**
```
🌐 Lakehouse URL
============================================================

https://lakehouse.k8.ingext.io
   Domain: lakehouse.k8.ingext.io
   ALB Hostname: alb-xxx-xxx.us-east-2.elb.amazonaws.com

💡 Tip: Use --test to verify ALB connectivity:
   lakehouse url --test

============================================================
```

### Test ALB Readiness and DNS

Test if the ALB is ready and DNS is configured correctly:

```bash
lakehouse url --test
```

This will:
- Check if ALB hostname is assigned
- Verify ALB is in "active" state in AWS
- Test HTTP connectivity to the ALB
- **Test DNS resolution** (if domain is configured)
- **Check Route53 DNS record** points to the correct ALB

### Wait for Provisioning

If the ALB is still provisioning, wait for it to be ready:

```bash
lakehouse url --wait
```

This will wait up to 5 minutes for the ALB to finish provisioning.

### Combined Options

Wait and test:

```bash
lakehouse url --wait --test
```

## Options

- `--test` - Test ALB connectivity, readiness, and DNS resolution
- `--wait` - Wait for ALB to finish provisioning (up to 5 minutes)
- `--namespace <namespace>` - Specify namespace (default: auto-detected)
- `--exec docker` - Run in Docker mode

### What `--test` Checks

When you use `--test`, the command verifies:

1. **ALB Status**
   - ALB hostname is assigned
   - ALB is in "active" state in AWS
   - HTTP connectivity works

2. **DNS Configuration** (if domain is configured)
   - DNS resolves correctly
   - Route53 DNS record exists
   - DNS record points to the correct ALB

3. **Troubleshooting Tips**
   - If DNS doesn't resolve, shows how to fix it
   - If DNS points to wrong ALB, shows how to update it
   - Provides cache-clearing instructions if needed

## Output

The command outputs:
1. **Primary URL** (to stdout for scripting):
   - If domain is configured: `https://<site-domain>`
   - Otherwise: `https://<alb-hostname>`

2. **Detailed information** (to stderr):
   - Domain (if configured)
   - ALB hostname
   - Readiness status (if `--test` is used)

## Scripting

The URL is printed to stdout, making it easy to use in scripts:

```bash
# Get URL and open in browser
open $(lakehouse url)

# Get URL and curl it
curl $(lakehouse url)/health-check

# Store URL in variable
URL=$(lakehouse url)
echo "Lakehouse is at: $URL"
```

## Related Commands

- `lakehouse status` - Full status check including ALB
- `lakehouse install` - Install/upgrade lakehouse
- `npx tsx scripts/test-alb-readiness.ts` - Detailed ALB readiness testing

## Troubleshooting

### ALB Hostname Not Assigned

If you see:
```
❌ ALB hostname not yet assigned.
```

**Solutions:**
1. Wait 2-5 minutes (ALB provisioning takes time)
2. Check ingress: `kubectl get ingress -n ingext`
3. Use `--wait` to wait automatically: `lakehouse url --wait`

### ALB Not Ready

If `--test` shows the ALB is not ready:

**Check:**
1. Backend pods: `kubectl get pods -n ingext`
2. ALB target group health in AWS Console
3. Security groups allow traffic

### DNS Does Not Resolve

If `--test` shows DNS doesn't resolve:

**Solutions:**
1. Create/update DNS record:
   ```bash
   npx tsx scripts/configure-dns.ts
   ```
2. Wait 1-5 minutes for DNS propagation
3. Clear local DNS cache:
   ```bash
   # macOS
   sudo dscacheutil -flushcache
   sudo killall -HUP mDNSResponder
   ```

### DNS Points to Wrong ALB

If `--test` shows DNS points to a different ALB:

**Solution:**
```bash
npx tsx scripts/configure-dns.ts
```

This will update the DNS record to point to the current ALB.

### Domain Not Configured

If no domain is shown, configure DNS:

```bash
npx tsx scripts/configure-dns.ts
```

Or manually create a DNS record pointing to the ALB hostname.
