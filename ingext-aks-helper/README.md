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

- **Docker** installed and running ([Download Docker Desktop](https://www.docker.com/products/docker-desktop))
- **Azure subscription** - The preflight script will help verify this and guide you if there are issues
- **DNS control** for a domain (for ingress and TLS)

**Note:** All required tools (`az`, `kubectl`, `helm`) are pre-installed in the Docker container. You don't need to install them separately.

The helper scripts are designed to run inside the Docker container provided by `ingext-shell.sh`, which includes all necessary tools and ensures consistent versions.

## Quick Start

### Step 0: Launch the Docker Container

The helper scripts run inside a pre-configured Docker container that includes all necessary tools.

**Start the container:**

```bash
# From the ingext-helm-charts repository root
./ingext-shell.sh
```

This will:
* Pull the latest container image
* Mount your current directory to `/workspace`
* Preserve your Azure credentials and kubectl config
* Drop you into a bash prompt inside the container

**Navigate to the helper scripts:**

```bash
cd /workspace/ingext-aks-helper
```

### Step 1: Preflight Check (Recommended)

Run the interactive wizard to collect settings and verify prerequisites:

```bash
chmod +x preflight-azure.sh

./preflight-azure.sh
```

This will:
- **Help with Azure setup** - If you're not logged in, it will prompt you to login
- **Verify your subscription** - Checks if you have a valid Azure subscription
- **Check provider registrations** - Verifies Microsoft.ContainerService and Microsoft.Network
- **Guide you through issues** - Provides clear guidance if there are problems
- **Prompt for all required settings** - Region, resource group, cluster name, domain, email
- **Show available VM sizes** - Automatically displays VM sizes available in your region
- **Check DNS resolution status** - Verifies your domain setup
- **Generate environment file** - Creates `ingext-aks.env` with all your settings

**Note:** A template file (`ingext-aks.env.example`) is provided as a reference. You can also manually edit and source it if you prefer not to use the interactive wizard.

### Step 2: Install Ingext

Source the env file and run the installer (no arguments needed):

```bash
source ./ingext-aks.env

./install-ingext-aks.sh
```

The installer will automatically use the environment variables from the `.env` file.

**Alternative: Install with explicit arguments**

If you prefer not to use the `.env` file, you can pass arguments directly:

```bash
./install-ingext-aks.sh \
  --location eastus \
  --resource-group ingext-rg \
  --cluster-name ingext-aks \
  --domain ingext.example.com \
  --email admin@example.com
```

**What the installer does:**
1. Creates an AKS cluster with App Gateway add-on
2. Installs all dependencies (Redis, OpenSearch, VictoriaMetrics, etcd)
3. Deploys Ingext components
4. Sets up cert-manager and ingress
5. Displays the ingress public IP for DNS configuration

### Step 3: Check Installation Status

```bash
chmod +x status-ingext-aks.sh

./status-ingext-aks.sh --namespace ingext
```

### Step 4: Configure DNS

```bash
chmod +x dns-ingext-aks.sh

# Get DNS instructions
./dns-ingext-aks.sh --domain ingext.example.com

# Or wait for DNS to be configured
./dns-ingext-aks.sh --domain ingext.example.com --wait
```

### Step 5: Access Ingext

After DNS is configured and the certificate is issued:
- URL: `https://ingext.example.com`
- Username: `admin@ingext.io`
- Password: `ingext`

### Step 6: Cleanup (when done)

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
- **Helps with Azure setup** - Prompts for login if needed, allows subscription selection
- **Verifies Azure authentication and subscription** - Checks current subscription and allows switching
- **Checks provider registrations** - Verifies Microsoft.ContainerService and Microsoft.Network
- **Shows available VM sizes** - Automatically displays VM sizes for your region
- **Checks compute quota** - Shows quota snapshot for the selected region
- **Checks DNS resolution status** - Verifies domain setup (if domain already exists)
- **Asks readiness questions** - Billing, permissions, quota, DNS control
- **Generates environment file** - Creates `ingext-aks.env` with all settings

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
./install-ingext-aks.sh
```

The installer will automatically use the environment variables from the `.env` file.

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
- `--node-vm-size` - AKS node VM size (default: `standard_dc2ds_v3`)
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

### `check-providers.sh` - Provider Registration Checker

Quick utility to check Azure provider registration status.

**Usage:**
```bash
./check-providers.sh
```

**What it shows:**
- Current subscription
- Microsoft.ContainerService registration status
- Microsoft.Network registration status
- Registration commands if needed

**Features:**
- Color-coded output (green/yellow/red)
- Clear error messages if subscription issues
- Suggests registration commands if providers aren't registered

### `list-vm-sizes.sh` - VM Size Helper

Lists VM sizes available in a region, filtered to show AKS-compatible sizes.

**Usage:**
```bash
./list-vm-sizes.sh --location eastus
./list-vm-sizes.sh --all  # Show all sizes (not filtered)
```

**What it shows:**
- Filtered list of AKS-compatible VM sizes (Standard_D*, Standard_B* series)
- Excludes specialized sizes (GPU, HPC, etc.)
- Recommendations for common use cases
- Shows vCPU, memory, and disk counts

**Note:** This shows general VM availability. AKS has additional restrictions. If a size fails during installation, the installer will show the actual AKS-available sizes.

### `cleanup-ingext-aks.sh` - Cleanup Script

Removes Ingext installation and optionally deletes the AKS cluster and resource group.

**Required Arguments:**
- `--resource-group` - Azure resource group name
- `--cluster-name` - AKS cluster name

**Optional Arguments:**
- `--namespace` - Kubernetes namespace (default: `ingext`)
- `--keep-resource-group` - Keep resource group after cleanup
- `--env-file` - Path to environment file (default: `./ingext-aks.env`)

**Auto-loads from .env file:**
The script automatically loads `./ingext-aks.env` if it exists, so you can simply run:
```bash
./cleanup-ingext-aks.sh
```

No need to provide `--resource-group` and `--cluster-name` if the `.env` file is present.

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
1. Automatically loads settings from `ingext-aks.env` if available
2. Uninstalls all Helm releases in the namespace
3. Uninstalls cert-manager
4. Deletes the AKS cluster
5. Optionally deletes the resource group

**Note:** The cleanup script automatically loads from `./ingext-aks.env` if it exists, so you can simply run:
```bash
./cleanup-ingext-aks.sh
```

If the `.env` file is present, you don't need to provide `--resource-group` and `--cluster-name` arguments.

## Common Workflows

### Fresh Installation

```bash
# 0. Launch Docker container (if not already running)
./ingext-shell.sh
cd /workspace/ingext-aks-helper

# 1. Preflight check (recommended)
./preflight-azure.sh
source ./ingext-aks.env

# 2. Install (uses .env file automatically)
./install-ingext-aks.sh

# 3. Check status
./status-ingext-aks.sh --namespace "$NAMESPACE"

# 4. Configure DNS (get instructions)
./dns-ingext-aks.sh --domain "$SITE_DOMAIN" --namespace "$NAMESPACE"

# 5. Wait for DNS (after creating DNS record)
./dns-ingext-aks.sh --domain "$SITE_DOMAIN" --namespace "$NAMESPACE" --wait

# 6. Verify everything is working
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

**Problem:** VM size not available for AKS
- **Solution:** The installer will show actual available sizes in the error message
- **Fix:** Use one of the sizes from the error message: `./install-ingext-aks.sh --node-vm-size <size-from-error>`
- **Check:** Run `./list-vm-sizes.sh` to see general availability (note: AKS has additional restrictions)
- **Common sizes:** `standard_dc2ds_v3`, `standard_dc2s_v3`, `standard_dc4ds_v3`

**Problem:** Pods stuck in Pending
- **Solution:** Check node resources: `kubectl describe nodes`
- **Check:** Node count may be insufficient
- **Check:** VM size may be too small for workloads

**Problem:** Helm install fails
- **Solution:** Ensure you're logged in to Azure: `az login`
- **Check:** Verify kubectl context: `kubectl config current-context`
- **Check:** Verify provider registrations: `./check-providers.sh`

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
| `NODE_VM_SIZE` | AKS node VM size | `standard_dc2ds_v3` |

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

