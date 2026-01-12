# Azure DNS Setup Guide

After running `install-lakehouse.sh`, you need to point your domain to the Azure Application Gateway created by the installer.

## Step 1: Obtain the Public IP

Wait about 2-5 minutes for the Application Gateway and the Ingress Controller to finish provisioning. Then, run:

```bash
kubectl get ingress -n ingext
```

You should see an IP address in the `ADDRESS` column:

```text
NAME              CLASS            HOSTS                 ADDRESS          PORTS   AGE
ingext-ingress    azure-ingress    ingext.example.com    20.12.34.56      80      5m
```

## Step 2: Create a DNS A-Record

Go to your DNS provider (Azure DNS, Cloudflare, GoDaddy, etc.) and create an **A-record** for your domain (e.g., `ingext.example.com`).

- **Type**: `A`
- **Name**: `ingext` (or the prefix for your subdomain)
- **Value**: The IP address obtained in Step 1 (e.g., `20.12.34.56`)
- **TTL**: `300` (5 minutes)

## Step 3: Verify TLS Propagation

Once the DNS record is created, the `cert-manager` in your cluster will attempt to validate the domain and issue a Let's Encrypt certificate.

You can watch the certificate status:

```bash
kubectl get certificate -n ingext
```

When the `READY` column shows `True`, you can log in to your Ingext console via HTTPS:

`https://ingext.example.com`

---

## Troubleshooting

### 1. Ingress Address is Empty
If the `ADDRESS` field stays empty for more than 10 minutes:
- Check the Ingress Controller logs: `./lakehouse-logs.sh agic`
- Ensure the Application Gateway was created successfully: `az network application-gateway list -g <your-rg>`

### 2. Certificate is not Ready
If the certificate is stuck:
- Check the challenge status: `kubectl describe challenge -n ingext`
- Ensure your DNS A-record is correctly resolving to the Gateway IP: `dig +short your.domain.com`
EOF
