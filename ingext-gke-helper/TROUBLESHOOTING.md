# GKE Installation Troubleshooting Guide

## Quick Recovery: Recreate Missing Ingress

If the ingress was accidentally deleted, use the recovery script:

```bash
cd /workspace/ingext-gke-helper
./recreate-ingress.sh --domain gcp.k8.ingext.io
```

Or manually recreate it:

```bash
cd /workspace/ingext-gke-helper
source ./ingext-gke.env

# Verify BackendConfig exists
kubectl get backendconfig api-backend-config -n "$NAMESPACE"

# Verify API service exists and is annotated
kubectl get service api -n "$NAMESPACE"
kubectl annotate service api -n "$NAMESPACE" \
  cloud.google.com/backend-config='{"default": "api-backend-config"}' \
  --overwrite

# Recreate ingress via Helm
helm upgrade --install ingext-community-ingress-gcp ../charts/ingext-community-ingress-gcp \
  -n "$NAMESPACE" \
  --set "siteDomain=$SITE_DOMAIN" \
  --set "ingress.staticIpName=ingext-static-ip"
```

## Common Issues and Solutions

### API Backend Not Showing as Healthy

**Symptom:** Ingress shows only `fluency8` and `default-http-backend` as HEALTHY, but not the API backend.

**Root Cause:** GKE load balancer health checks can take 10-15 minutes to propagate, especially after BackendConfig changes.

**Solutions:**

1. **Wait for health check propagation (10-15 minutes)**
   ```bash
   kubectl describe ingress ingext-ingress -n ingext | grep -A 3 "Backends:"
   ```

2. **Verify BackendConfig is correct:**
   ```bash
   kubectl get backendconfig api-backend-config -n ingext -o yaml
   # Should show type: TCP (not HTTP)
   ```

3. **Verify service annotation:**
   ```bash
   kubectl get service api -n ingext -o yaml | grep backend-config
   ```

4. **Test if API works despite health check status:**
   ```bash
   # Get the ingress IP
   ING_IP=$(kubectl get ingress ingext-ingress -n ingext -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
   
   # Test API directly
   curl -k https://$ING_IP/api/auth/login -X POST \
     -H "Content-Type: application/json" \
     -H "Host: gcp.k8.ingext.io" \
     -d '{}'
   ```

5. **If health check still fails after 15 minutes:**
   - Check GCP Console: Network Services > Load Balancing
   - Look at the backend service health status
   - Verify the API pod is actually running: `kubectl get pods -n ingext | grep api`

### Ingress IP Not Appearing

**Symptom:** Ingress shows no IP address in the ADDRESS column.

**Solutions:**

1. **Wait 2-5 minutes** - GKE load balancer provisioning takes time

2. **Check static IP exists:**
   ```bash
   gcloud compute addresses list --global --filter="name:ingext-static-ip"
   ```

3. **Verify static IP annotation:**
   ```bash
   kubectl get ingress ingext-ingress -n ingext -o yaml | grep static-ip-name
   ```

4. **Check ingress events:**
   ```bash
   kubectl describe ingress ingext-ingress -n ingext | tail -20
   ```

5. **If IP still doesn't appear after 10 minutes:**
   - Check GCP Console for load balancer status
   - Verify all backend services are configured
   - Try recreating the ingress (last resort)

### Site Returns 404 for /api/* Requests

**Symptom:** Site loads but API calls return 404 (e.g., `/api/auth/login`, `/api/ds/get_site_info`).

**Root Cause:** GKE Ingress requires all paths for the same host to be under a single rule. If paths are split across multiple rules, routing may fail.

**Quick Fix:**
```bash
# Use the comprehensive fix script
./fix-all-issues.sh --domain gcp.k8.ingext.io
```

This will:
- Fix ingress path configuration (consolidate paths under single rule)
- Fix certificate issues
- Verify API routing

**Manual Solutions:**

1. **Verify ingress has all paths under single rule:**
   ```bash
   kubectl get ingress ingext-ingress -n ingext -o yaml | grep -A 30 "rules:"
   # All paths should be under ONE rule, not multiple rules
   ```

2. **If ingress has multiple rules, reinstall it:**
   ```bash
   # Reinstall ingress chart (paths will be consolidated)
   helm upgrade --install ingext-community-ingress-gcp ../charts/ingext-community-ingress-gcp \
     -n ingext \
     --set "siteDomain=gcp.k8.ingext.io" \
     --set "ingress.staticIpName=ingext-static-ip"
   ```

3. **Verify service names match:**
   ```bash
   kubectl get svc -n ingext | grep -E "api|platform|fluency"
   # Should show: api, platform-service, fluency8
   ```

4. **Check ingress rules:**
   ```bash
   kubectl describe ingress ingext-ingress -n ingext | grep -A 20 "Rules:"
   # Should show all paths (/api, /services, /) under one rule
   ```

5. **Test API service directly:**
   ```bash
   kubectl port-forward svc/api -n ingext 8002:8002
   # Then test: curl http://localhost:8002/api/auth/login -X POST -d '{}'
   ```

6. **Check if API pod is ready:**
   ```bash
   kubectl get pods -n ingext | grep api
   kubectl logs api-0 -n ingext --tail=50
   ```

7. **Check ingress backend health:**
   ```bash
   kubectl describe ingress ingext-ingress -n ingext | grep -A 5 "Backends:"
   # API backend should show as HEALTHY (may take 10-15 minutes)
   ```

### Certificate Not Issuing

**Symptom:** Certificate stays in "False" READY status or no certificate resource exists.

**Quick Diagnostic:**
```bash
./diagnose-certificate.sh --domain gcp.k8.ingext.io
```

This script checks:
- DNS resolution
- cert-manager status
- ClusterIssuer status
- Ingress annotations
- Certificate resource status
- Challenge status

**Solutions:**

1. **DNS must be configured first:**
   ```bash
   ./dns-ingext-gke.sh --domain gcp.k8.ingext.io
   ```
   - Create DNS A-record: `gcp.k8.ingext.io -> <ingress-ip>`
   - Wait 5-15 minutes for DNS propagation
   - Verify: `nslookup gcp.k8.ingext.io` should return the ingress IP

2. **Verify cert-manager is running:**
   ```bash
   kubectl get pods -n cert-manager
   # All pods should be Running
   ```

3. **Verify ClusterIssuer exists and is Ready:**
   ```bash
   kubectl get clusterissuer letsencrypt-prod
   kubectl describe clusterissuer letsencrypt-prod
   # Status should show Ready=True
   ```

4. **Check ingress annotations:**
   ```bash
   kubectl get ingress ingext-ingress -n ingext -o yaml | grep -A 5 annotations
   # Should have:
   #   cert-manager.io/cluster-issuer: letsencrypt-prod
   #   acme.cert-manager.io/http01-edit-in-place: "true"
   ```

5. **Check certificate status:**
   ```bash
   kubectl get certificate -n ingext
   kubectl describe certificate ingext-tls-secret -n ingext
   ```

6. **Check challenges:**
   ```bash
   kubectl get challenge -n ingext
   kubectl describe challenge -n ingext
   ```
   - Challenges are created automatically when DNS resolves
   - They should transition from Pending -> Processing -> Valid

7. **If certificate resource doesn't exist:**
   - Verify DNS resolves correctly
   - Check ingress annotations are correct
   - cert-manager should create the Certificate resource automatically
   - If it doesn't, check cert-manager logs:
     ```bash
     kubectl logs -n cert-manager -l app=cert-manager
     ```

8. **If certificate shows "IncorrectIssuer" or HTTP-01 challenge fails:**
   ```bash
   # Use the fix script to delete and recreate resources
   ./fix-certificate.sh --domain gcp.k8.ingext.io
   ```
   This will:
   - Delete the TLS secret with wrong issuer annotation
   - Delete existing challenges
   - Delete the Certificate resource
   - Verify ingress annotations
   - cert-manager will automatically recreate everything

9. **HTTP-01 challenge getting HTML instead of token:**
   - This happens when `/.well-known/acme-challenge/` is caught by the catch-all `/` rule
   - With `acme.cert-manager.io/http01-edit-in-place: "true"`, cert-manager should add the challenge path automatically
   - Wait 1-2 minutes for cert-manager to edit the ingress
   - If it still fails, delete and recreate the certificate (see step 8)

### Installation Hangs on Pod Wait

**Symptom:** Installer hangs waiting for pods to be ready.

**Solution:** Already fixed - the wait function now excludes Completed jobs. If it still hangs:
- Press Ctrl+C to continue
- Check pod status manually: `kubectl get pods -n ingext`
- The installer should continue past the wait

## Quick Diagnostic Commands

```bash
# Full status check
./status-ingext-gke.sh --namespace ingext

# Check DNS and certificate
./dns-ingext-gke.sh --domain gcp.k8.ingext.io

# Check ingress details
kubectl describe ingress ingext-ingress -n ingext

# Check backend health
kubectl get ingress ingext-ingress -n ingext -o jsonpath='{.metadata.annotations.ingress\.kubernetes\.io/backends}' | jq '.'

# Check all services
kubectl get svc -n ingext

# Check all pods
kubectl get pods -n ingext -o wide
```

## Known Limitations

1. **GKE Health Check Propagation:** Can take 10-15 minutes after BackendConfig changes
2. **Load Balancer Provisioning:** Takes 2-5 minutes for IP assignment
3. **DNS Propagation:** Can take 5-15 minutes after DNS record creation
4. **Certificate Issuance:** Requires DNS to be fully propagated first

## Getting Help

If issues persist:
1. Check GCP Console for load balancer and backend service status
2. Review pod logs: `kubectl logs -n ingext <pod-name>`
3. Check ingress events: `kubectl describe ingress ingext-ingress -n ingext`
4. Verify all prerequisites from `preflight-gcp.sh` are met

