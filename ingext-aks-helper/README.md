# Ingext AKS Installer Suite

A comprehensive set of bash scripts for deploying and managing [Ingext](https://github.com/SecurityDo/ingext-helm-charts) on Azure Kubernetes Service (AKS).

## Overview

This suite provides production-grade scripts for:
- **Preflight checks** - Interactive wizard to verify prerequisites and collect settings
- **Installing** Ingext on AKS with App Gateway add-on
- **Checking** installation status and component health
- **Managing** DNS configuration and certificate issuance
- **Cleaning up** resources when done

All scripts follow the official installation instructions from the [ingext-helm-charts repository](https://github.com/SecurityDo/ingext-helm-charts).

## Prerequisites

Before using these scripts, ensure you have:

- **Azure CLI** (`az`) - [Installation guide](https://docs.microsoft.com/cli/azure/install-azure-cli)
- **kubectl** - [Installation guide](https://kubernetes.io/docs/tasks/tools/)
- **helm** - [Installation guide](https://helm.sh/docs/intro/install/)
- **Azure account** with permissions to create AKS clusters and resource groups
- **DNS domain** that you can configure (for ingress)

## Quick Start

### 0. Preflight Check (Recommended)

Run the interactive wizard to collect settings and verify prerequisites:

```bash
chmod +x preflight-azure.sh

./preflight-azure.sh
```

This will:
- Prompt for all required settings (region, resource group, cluster name, domain, email)
- Check Azure authentication and subscription
- Verify provider registrations
- Check DNS resolution status
- Generate an environment file (`ingext-aks.env`) with your settings

**Note:** A template file (`ingext-aks.env.example`) is provided as a reference. You can also manually edit and source it if you prefer not to use the interactive wizard.

Then source the env file and run the installer:

```bash
source ./ingext-aks.env

./install-ingext-aks.sh \
  --location "$LOCATION" \
  --resource-group "$RESOURCE_GROUP" \
  --cluster-name "$CLUSTER_NAME" \
  --domain "$SITE_DOMAIN" \
  --email "$CERT_EMAIL"
```

### 1. Install Ingext (Direct)

Alternatively, run the installer directly with all arguments:

```bash
chmod +x install-ingext-aks.sh

./install-ingext-aks.sh \
  --location eastus \
  --resource-group ingext-rg \
  --cluster-name ingext-aks \
  --domain ingext.example.com \
  --email admin@example.com
```

The installer will:
1. Create an AKS cluster with App Gateway add-on
2. Install all dependencies (Redis, OpenSearch, VictoriaMetrics, etcd)
3. Deploy Ingext components
4. Set up cert-manager and ingress
5. Display the ingress public IP for DNS configuration

### 2. Check Installation Status

```bash
chmod +x status-ingext-aks.sh

./status-ingext-aks.sh --namespace ingext
```

### 3. Configure DNS

```bash
chmod +x dns-ingext-aks.sh

# Get DNS instructions
./dns-ingext-aks.sh --domain ingext.example.com

# Or wait for DNS to be configured
./dns-ingext-aks.sh --domain ingext.example.com --wait
```

### 4. Access Ingext

After DNS is configured and the certificate is issued:
- URL: `https://ingext.example.com`
- Username: `admin@ingext.io`
- Password: `ingext`

### 5. Cleanup (when done)

```bash
chmod +x cleanup-ingext-aks.sh

./cleanup-ingext-aks.sh \
  --resource-group ingext-rg \
  --cluster-name ingext-aks
```

## Scripts

### `preflight-azure.sh` - Preflight Wizard

Interactive wizard that collects all required settings and performs best-effort checks before installation.

**What it does:**
- Prompts for all installation settings (region, resource group, cluster name, domain, email)
- Verifies Azure authentication and subscription
- Checks provider registrations (Microsoft.ContainerService, Microsoft.Network)
- Checks compute quota in the selected region
- Checks DNS resolution status (if domain already exists)
- Asks readiness questions (billing, permissions, quota, DNS control)
- Generates an environment file (`ingext-aks.env`) with all settings

**Usage:**
```bash
./preflight-azure.sh

# Custom output file
OUTPUT_ENV=./my-custom.env ./preflight-azure.sh
```

**Output:**
Creates an environment file (default: `./ingext-aks.env`) that you can source:
```bash
source ./ingext-aks.env
./install-ingext-aks.sh \
  --location "$LOCATION" \
  --resource-group "$RESOURCE_GROUP" \
  --cluster-name "$CLUSTER_NAME" \
  --domain "$SITE_DOMAIN" \
  --email "$CERT_EMAIL"
```

**Benefits:**
- Catches common issues before installation starts
- Ensures all required information is collected upfront
- Provides warnings for potential problems
- Generates reusable environment file for CI/CD

### `install-ingext-aks.sh` - Main Installer

Installs Ingext on AKS following the complete installation flow.

**Required Arguments:**
- `--location` - Azure region (e.g., `eastus`, `westus2`)
- `--resource-group` - Azure resource group name
- `--cluster-name` - AKS cluster name
- `--domain` - Public site domain (FQDN)
- `--email` - Email for certificate issuer (Let's Encrypt)

**Optional Arguments:**
- `--namespace` - Kubernetes namespace (default: `ingext`)
- `--node-count` - AKS node count (default: `2`)
- `--skip-aks-create` - Skip AKS creation (use existing cluster)

**Example:**
```bash
./install-ingext-aks.sh \
  --location eastus \
  --resource-group my-rg \
  --cluster-name my-cluster \
  --domain myapp.example.com \
  --email admin@example.com \
  --namespace ingext \
  --node-count 3
```

**Environment Variables:**
All arguments can also be provided via environment variables:
```bash
export LOCATION=eastus
export RESOURCE_GROUP=my-rg
export CLUSTER_NAME=my-cluster
export SITE_DOMAIN=myapp.example.com
export CERT_EMAIL=admin@example.com
./install-ingext-aks.sh
```

### `status-ingext-aks.sh` - Status Checker

Checks the status of your Ingext installation, including:
- AKS cluster status
- Helm releases
- Pod status and health
- Ingress configuration and public IP
- Certificate status
- Service endpoints

**Optional Arguments:**
- `--namespace` - Kubernetes namespace (default: `ingext`)
- `--resource-group` - Azure resource group (for cluster status)
- `--cluster-name` - AKS cluster name (for cluster status)

**Example:**
```bash
./status-ingext-aks.sh --namespace ingext
./status-ingext-aks.sh --namespace ingext --resource-group my-rg --cluster-name my-cluster
```

**Output:**
- Color-coded status (green/yellow/red)
- Summary of all components
- Useful troubleshooting commands

### `dns-ingext-aks.sh` - DNS Helper

Helps configure and verify DNS for your Ingext installation.

**Required Arguments:**
- `--domain` - Public site domain (FQDN)

**Optional Arguments:**
- `--namespace` - Kubernetes namespace (default: `ingext`)
- `--wait` - Wait until DNS is properly configured
- `--wait-timeout` - Timeout for wait mode in seconds (default: `300`)

**Example:**
```bash
# Get DNS instructions
./dns-ingext-aks.sh --domain ingext.example.com

# Wait for DNS to be configured
./dns-ingext-aks.sh --domain ingext.example.com --wait

# Custom timeout
./dns-ingext-aks.sh --domain ingext.example.com --wait --wait-timeout 600
```

**Features:**
- Gets ingress public IP from cluster
- Provides DNS configuration instructions
- Checks current DNS resolution
- Monitors certificate challenge status
- Optional wait mode for automation

### `cleanup-ingext-aks.sh` - Cleanup Script

Removes Ingext installation and optionally deletes the AKS cluster and resource group.

**Required Arguments:**
- `--resource-group` - Azure resource group name
- `--cluster-name` - AKS cluster name

**Optional Arguments:**
- `--namespace` - Kubernetes namespace (default: `ingext`)
- `--keep-resource-group` - Keep resource group after cleanup

**Example:**
```bash
# Full cleanup (including resource group)
./cleanup-ingext-aks.sh \
  --resource-group ingext-rg \
  --cluster-name ingext-aks

# Keep resource group
./cleanup-ingext-aks.sh \
  --resource-group ingext-rg \
  --cluster-name ingext-aks \
  --keep-resource-group
```

**What it does:**
1. Uninstalls all Helm releases in the namespace
2. Uninstalls cert-manager
3. Deletes the AKS cluster
4. Optionally deletes the resource group

## Common Workflows

### Fresh Installation

```bash
# 0. Preflight check (recommended)
./preflight-azure.sh
source ./ingext-aks.env

# 1. Install
./install-ingext-aks.sh \
  --location "$LOCATION" \
  --resource-group "$RESOURCE_GROUP" \
  --cluster-name "$CLUSTER_NAME" \
  --domain "$SITE_DOMAIN" \
  --email "$CERT_EMAIL"

# 2. Check status
./status-ingext-aks.sh --namespace "$NAMESPACE"

# 3. Configure DNS (get instructions)
./dns-ingext-aks.sh --domain "$SITE_DOMAIN" --namespace "$NAMESPACE"

# 4. Wait for DNS (after creating DNS record)
./dns-ingext-aks.sh --domain "$SITE_DOMAIN" --namespace "$NAMESPACE" --wait

# 5. Verify everything is working
./status-ingext-aks.sh --namespace "$NAMESPACE"
```

### Using Existing AKS Cluster

```bash
# Skip AKS creation
./install-ingext-aks.sh \
  --location eastus \
  --resource-group existing-rg \
  --cluster-name existing-aks \
  --domain ingext.example.com \
  --email admin@example.com \
  --skip-aks-create
```

### Troubleshooting

```bash
# Check overall status
./status-ingext-aks.sh --namespace ingext

# Check DNS
./dns-ingext-aks.sh --domain ingext.example.com

# View pod logs
kubectl logs -n ingext -f ingext-api-0
kubectl logs -n ingext -f ingext-platform-0

# Check certificates
kubectl get certificate -n ingext
kubectl get challenge -n ingext
kubectl describe challenge -n ingext

# Check ingress
kubectl get ingress -n ingext -o wide
```

## Troubleshooting

### Installation Issues

**Problem:** AKS cluster creation fails
- **Prevention:** Run `./preflight-azure.sh` first to check permissions and quotas
- **Solution:** Check Azure permissions and quota limits
- **Alternative:** Use `--skip-aks-create` if cluster already exists

**Problem:** Pods stuck in Pending
- **Solution:** Check node resources: `kubectl describe nodes`
- **Check:** Node count may be insufficient

**Problem:** Helm install fails
- **Solution:** Ensure you're logged in to Azure: `az login`
- **Check:** Verify kubectl context: `kubectl config current-context`

### DNS Issues

**Problem:** DNS not resolving
- **Solution:** Wait 5-15 minutes for DNS propagation
- **Check:** Verify DNS record with: `nslookup your-domain.com`
- **Use:** `./dns-ingext-aks.sh --domain your-domain.com --wait`

**Problem:** Certificate not issuing
- **Solution:** DNS must resolve correctly first
- **Check:** `kubectl get challenge -n ingext`
- **Check:** `kubectl describe challenge -n ingext`

### Access Issues

**Problem:** Cannot access https://your-domain.com
- **Check:** DNS is configured: `./dns-ingext-aks.sh --domain your-domain.com`
- **Check:** Certificate is ready: `kubectl get certificate -n ingext`
- **Check:** Ingress has IP: `kubectl get ingress -n ingext`

## Environment Variables

All scripts support environment variables as alternatives to command-line arguments. Flags always override environment variables.

**Template File:** See `ingext-aks.env.example` for a template with all available variables and documentation.

| Variable | Description | Example |
|----------|-------------|---------|
| `LOCATION` | Azure region | `eastus` |
| `RESOURCE_GROUP` | Resource group name | `ingext-rg` |
| `CLUSTER_NAME` | AKS cluster name | `ingext-aks` |
| `SITE_DOMAIN` | Public domain | `ingext.example.com` |
| `CERT_EMAIL` | Certificate email | `admin@example.com` |
| `NAMESPACE` | Kubernetes namespace | `ingext` |
| `NODE_COUNT` | AKS node count | `2` |

**Note:** The preflight wizard (`./preflight-azure.sh`) will generate a complete `ingext-aks.env` file with all required variables. You can also manually copy and edit `ingext-aks.env.example` if you prefer.

## CI/CD Integration

These scripts are designed to work in both interactive and automated environments:

```bash
# Non-interactive mode (set environment variables)
export LOCATION=eastus
export RESOURCE_GROUP=ingext-rg
export CLUSTER_NAME=ingext-aks
export SITE_DOMAIN=ingext.example.com
export CERT_EMAIL=admin@example.com

# Use --skip-aks-create if cluster exists
./install-ingext-aks.sh --skip-aks-create

# Check status (non-interactive)
./status-ingext-aks.sh --namespace ingext
```

## Security Notes

- **Credentials:** Default Ingext credentials are `admin@ingext.io` / `ingext` - change these after first login
- **Certificates:** Certificates are automatically issued by Let's Encrypt via cert-manager
- **Network:** App Gateway add-on provides the ingress controller
- **RBAC:** Scripts use standard kubectl/helm permissions

## Additional Resources

- [Ingext Helm Charts Repository](https://github.com/SecurityDo/ingext-helm-charts)
- [Azure Kubernetes Service Documentation](https://docs.microsoft.com/azure/aks/)
- [cert-manager Documentation](https://cert-manager.io/docs/)

## Support

If you encounter issues:
1. Check the troubleshooting section above
2. Review script output and error messages
3. Check Kubernetes resources: `kubectl get all -n ingext`
4. Open an issue in the [ingext-helm-charts repository](https://github.com/SecurityDo/ingext-helm-charts)

## License

These scripts are provided as-is for managing Ingext installations. Refer to the [ingext-helm-charts repository](https://github.com/SecurityDo/ingext-helm-charts) for Ingext licensing information.

