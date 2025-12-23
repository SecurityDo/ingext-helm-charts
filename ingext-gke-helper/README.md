# Ingext GKE Installer Suite

A comprehensive set of bash scripts for deploying and managing [Ingext](https://github.com/SecurityDo/ingext-helm-charts) on Google Kubernetes Engine (GKE).

## Overview

This suite provides production-grade scripts for:
- **Preflight checks** - Interactive wizard to verify prerequisites and collect settings
- **Installing** Ingext on GKE with Google Cloud Load Balancer
- **Checking** installation status and component health
- **Managing** DNS configuration and certificate issuance
- **Cleaning up** resources when done

All scripts follow the official installation instructions from the [ingext-helm-charts repository](https://github.com/SecurityDo/ingext-helm-charts).

## Prerequisites

Before using these scripts, ensure you have:

- **Docker** installed and running ([Download Docker Desktop](https://www.docker.com/products/docker-desktop))
- **GCP project** with billing enabled - The preflight script will help verify this and guide you if there are issues
- **DNS control** for a domain (for ingress and TLS)

### Creating a New GCP Project

If you don't have a GCP project yet, you can create one:

```bash
# Inside the Docker container (after running ./ingext-gcp-shell.sh)
# Or on your host if gcloud is installed

# Create a new project (replace 'ingext-test-12345' with your unique project ID)
# Project ID must be globally unique, 6-30 characters, lowercase letters, numbers, hyphens
gcloud projects create ingext-test-12345 --name="Ingext Test Project"

# Set the project as active (replace with your actual project ID)
gcloud config set project ingext-test-12345

# Enable billing (REQUIRED before enabling APIs or creating GKE clusters)
# Option 1: Via GCP Console (recommended for first-time setup):
#   https://console.cloud.google.com/billing?project=ingext-test-12345
#   Click "Link a billing account" and select your billing account
#
# Option 2: Via command line (if you have a billing account ID):
#   gcloud billing projects link ingext-test-12345 --billing-account=BILLING_ACCOUNT_ID
#
# To list your billing accounts:
#   gcloud billing accounts list
```

**Tip:** Use a timestamp to ensure uniqueness: `ingext-test-$(date +%s)`

**Note:** The `ingext-gcp-shell.sh` script uses the base `ingext-shell` Docker image and mounts your GCP credentials (`$HOME/.config/gcloud`) so authentication works. A dedicated GCP image may be created later.

If `gcloud` is not available in the container, you can install it:

```bash
# Inside the Docker container
curl https://sdk.cloud.google.com | bash
exec -l $SHELL
gcloud init
```

The helper scripts are designed to run inside the Docker container provided by `ingext-gcp-shell.sh`, which mounts GCP credentials and includes necessary tools (`kubectl`, `helm`).

## Quick Start

### Step 0: Launch the Docker Container

The helper scripts run inside a pre-configured Docker container that includes all necessary tools.

**Start the container:**

```bash
# From the ingext-helm-charts repository root
chmod +x ingext-gcp-shell.sh
./ingext-gcp-shell.sh
```

This will:
* Pull the latest container image (currently uses `ingext-shell:latest`, a dedicated GCP image may be created later)
* Mount your current directory to `/workspace`
* Mount your GCP credentials (`$HOME/.config/gcloud`) so authentication works
* Preserve your kubectl config
* Drop you into a bash prompt inside the container

**Navigate to the helper scripts:**

```bash
cd /workspace/ingext-gke-helper
```

### Step 1: Preflight Check (Recommended)

Run the interactive wizard to collect settings and verify prerequisites:

```bash
chmod +x preflight-gcp.sh

./preflight-gcp.sh
```

This will:
- **Help with GCP setup** - If you're not logged in, it will prompt you to login
- **Verify your project** - Checks if you have a valid GCP project with billing
- **Check API enablement** - Verifies container.googleapis.com and compute.googleapis.com are enabled
- **Guide you through issues** - Provides clear guidance if there are problems
- **Prompt for all required settings** - Project, region, cluster name, domain, email
- **Show available machine types** - Automatically displays machine types available in your region
- **Check DNS resolution status** - Verifies your domain setup
- **Generate environment file** - Creates `ingext-gke.env` with all your settings

**Note:** A template file (`ingext-gke.env.example`) is provided as a reference. You can also manually edit and source it if you prefer not to use the interactive wizard.

### Step 2: Install Ingext

Source the env file and run the installer (no arguments needed):

```bash
source ./ingext-gke.env

./install-ingext-gke.sh
```

The installer will automatically use the environment variables from the `.env` file.

**Alternative: Install with explicit arguments**

If you prefer not to use the `.env` file, you can pass arguments directly:

```bash
./install-ingext-gke.sh \
  --project my-gcp-project \
  --region us-east1 \
  --cluster-name ingext-gke \
  --domain ingext.example.com \
  --email admin@example.com
```

**What the installer does:**
1. Creates a GKE regional cluster with VPC-native networking
2. Installs all dependencies (Redis, OpenSearch, VictoriaMetrics, etcd)
3. Deploys Ingext components
4. Sets up cert-manager and ingress
5. Displays the ingress public IP for DNS configuration

### Step 3: Check Installation Status

```bash
chmod +x status-ingext-gke.sh

./status-ingext-gke.sh --namespace ingext
```

### Step 4: Configure DNS

```bash
chmod +x dns-ingext-gke.sh

# Get DNS instructions
./dns-ingext-gke.sh --domain ingext.example.com

# Or wait for DNS to be configured
./dns-ingext-gke.sh --domain ingext.example.com --wait
```

### Step 5: Access Ingext

After DNS is configured and the certificate is issued:
- URL: `https://ingext.example.com`
- Username: `admin@ingext.io`
- Password: `ingext`

### Step 6: Cleanup (when done)

```bash
chmod +x cleanup-ingext-gke.sh

./cleanup-ingext-gke.sh \
  --project my-gcp-project \
  --region us-east1 \
  --cluster-name ingext-gke
```

## Scripts

### `preflight-gcp.sh` - Preflight Wizard

Interactive wizard that collects all required settings and performs best-effort checks before installation.

**What it does:**
- **Helps with GCP setup** - Prompts for login if needed, allows project selection
- **Verifies GCP authentication and project** - Checks current project and allows switching
- **Checks API enablement** - Verifies container.googleapis.com and compute.googleapis.com
- **Shows available machine types** - Automatically displays machine types for your region
- **Checks compute quota** - Shows quota snapshot for the selected region
- **Checks DNS resolution status** - Verifies domain setup (if domain already exists)
- **Asks readiness questions** - Billing, permissions, quota, DNS control
- **Generates environment file** - Creates `ingext-gke.env` with all settings

**Usage:**
```bash
./preflight-gcp.sh

# Custom output file
OUTPUT_ENV=./my-custom.env ./preflight-gcp.sh
```

**Output:**
Creates an environment file (default: `./ingext-gke.env`) that you can source:
```bash
source ./ingext-gke.env
./install-ingext-gke.sh
```

The installer will automatically use the environment variables from the `.env` file.

### `install-ingext-gke.sh` - Main Installer

Installs Ingext on GKE following the complete installation flow.

**Required Arguments:**
- `--project` - GCP project ID
- `--region` - GCP region (e.g., `us-east1`, `us-west1`)
- `--cluster-name` - GKE cluster name
- `--domain` - Public site domain (FQDN)
- `--email` - Email for certificate issuer (Let's Encrypt)

**Optional Arguments:**
- `--namespace` - Kubernetes namespace (default: `ingext`)
- `--node-count` - Node count per zone (default: `2`)
- `--machine-type` - Machine type (default: `e2-standard-4`)
- `--skip-gke-create` - Skip GKE creation (use existing cluster)
- `--vpc-network` - VPC network name (optional)
- `--subnet` - Subnet name (optional)

**Example:**
```bash
./install-ingext-gke.sh \
  --project my-gcp-project \
  --region us-east1 \
  --cluster-name my-cluster \
  --domain myapp.example.com \
  --email admin@example.com \
  --namespace ingext \
  --node-count 3
```

**Environment Variables:**
All arguments can also be provided via environment variables:
```bash
export PROJECT_ID=my-gcp-project
export REGION=us-east1
export CLUSTER_NAME=my-cluster
export SITE_DOMAIN=myapp.example.com
export CERT_EMAIL=admin@example.com
./install-ingext-gke.sh
```

### `status-ingext-gke.sh` - Status Checker

Checks the status of your Ingext installation, including:
- GKE cluster status
- Helm releases
- Pod status and health
- Ingress configuration and public IP
- Certificate status
- Service endpoints

**Optional Arguments:**
- `--namespace` - Kubernetes namespace (default: `ingext`)
- `--project` - GCP project ID (for cluster status)
- `--region` - GCP region (for cluster status)
- `--cluster-name` - GKE cluster name (for cluster status)

**Example:**
```bash
./status-ingext-gke.sh --namespace ingext
./status-ingext-gke.sh --namespace ingext --project my-project --region us-east1 --cluster-name my-cluster
```

**Output:**
- Color-coded status (green/yellow/red)
- Summary of all components
- Useful troubleshooting commands

### `dns-ingext-gke.sh` - DNS Helper

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
./dns-ingext-gke.sh --domain ingext.example.com

# Wait for DNS to be configured
./dns-ingext-gke.sh --domain ingext.example.com --wait

# Custom timeout
./dns-ingext-gke.sh --domain ingext.example.com --wait --wait-timeout 600
```

**Features:**
- Gets ingress public IP from cluster
- Provides DNS configuration instructions
- Checks current DNS resolution
- Monitors certificate challenge status
- Optional wait mode for automation

### `check-apis.sh` - API Enablement Checker

Quick utility to check GCP API enablement status.

**Usage:**
```bash
./check-apis.sh --project my-gcp-project
```

**What it shows:**
- Current project
- container.googleapis.com registration status
- compute.googleapis.com registration status
- cloudresourcemanager.googleapis.com registration status
- Enablement commands if needed

**Features:**
- Color-coded output (green/yellow/red)
- Clear error messages if project issues
- Suggests enablement commands if APIs aren't enabled

### `list-machine-types.sh` - Machine Type Helper

Lists machine types available in a region, filtered to show GKE-compatible types.

**Usage:**
```bash
./list-machine-types.sh --region us-east1
./list-machine-types.sh --all  # Show all types (not filtered)
```

**What it shows:**
- Filtered list of GKE-compatible machine types (e2, n1, n2 series)
- Excludes specialized types (GPU, HPC, etc.)
- Recommendations for common use cases
- Shows vCPU, memory counts

**Note:** This shows general machine type availability. GKE has additional restrictions. If a type fails during installation, the installer will show guidance.

### `recreate-ingress.sh` - Recovery Script

Recreates the ingress and associated resources if they were accidentally deleted. This is useful if the ingress was removed but the core installation is still intact.

**Usage:**
```bash
./recreate-ingress.sh --domain gcp.k8.ingext.io

# Or use environment file
source ./ingext-gke.env
./recreate-ingress.sh
```

**What it does:**
- Verifies BackendConfig exists (creates if missing)
- Annotates API service with BackendConfig
- Checks/creates static IP
- Reinstalls ingress Helm chart
- Waits for IP assignment and provides next steps

**Example:**
```bash
# If ingress was accidentally deleted
./recreate-ingress.sh --namespace ingext --domain gcp.k8.ingext.io
```

### `test-all.sh` - Comprehensive Test Suite ⭐ **RECOMMENDED**

**Run this first to identify ALL issues at once!**

Tests all backend components systematically with clear PASS/FAIL results. Eliminates guesswork by checking everything in one run.

**What it tests:**
- Cluster & namespace connectivity
- Pod status (API, Platform, Fluency)
- Service configuration and endpoints
- BackendConfig (health check type and configuration)
- Ingress configuration (paths, rules, IP, annotations)
- Ingress backend health status
- DNS resolution
- Certificate status (cert-manager, ClusterIssuer, Certificate resource)
- Direct API access (port-forward test)
- Ingress API access (via load balancer)

**Usage:**
```bash
./test-all.sh --domain gcp.k8.ingext.io

# Or use environment file
source ./ingext-gke.env
./test-all.sh
```

**Output:**
- Clear PASS/FAIL for each test
- Summary with total passed/failed/warnings
- Specific fix recommendations based on failures

**Example:**
```bash
# Run comprehensive test
./test-all.sh --namespace ingext --domain gcp.k8.ingext.io

# Output shows:
# ✓ PASS: API pods running
# ✗ FAIL: BackendConfig uses TCP (must be HTTP)
# ✓ PASS: Ingress has /api path
# ...
# 
# TEST SUMMARY
# Total Tests: 25
# Passed: 20
# Failed: 5
# 
# Review the failures above and run the appropriate fix scripts
```

### `diagnose-certificate.sh` - Certificate Diagnostic Script

Diagnoses certificate issuance issues by checking DNS, cert-manager, ClusterIssuer, ingress annotations, and certificate/challenge status.

**Usage:**
```bash
./diagnose-certificate.sh --domain gcp.k8.ingext.io

# Or use environment file
source ./ingext-gke.env
./diagnose-certificate.sh
```

**What it checks:**
- DNS resolution (does domain resolve to ingress IP?)
- cert-manager pod status
- ClusterIssuer readiness
- Ingress cert-manager annotations
- Certificate resource status
- Challenge status and details

**Example:**
```bash
# Diagnose why certificate isn't issuing
./diagnose-certificate.sh --namespace ingext --domain gcp.k8.ingext.io
```

### `fix-certificate.sh` - Certificate Fix Script

Fixes common certificate issues by deleting and recreating certificate resources. Use this when:
- Certificate shows "IncorrectIssuer" error
- HTTP-01 challenges are failing
- Certificate resource needs to be recreated

**Usage:**
```bash
./fix-certificate.sh --domain gcp.k8.ingext.io

# Or use environment file
source ./ingext-gke.env
./fix-certificate.sh
```

**What it does:**
- Deletes TLS secret with wrong issuer annotation
- Deletes existing challenges (forces recreation)
- Deletes Certificate resource (forces recreation)
- Verifies ingress has correct annotations
- Waits for cert-manager to recreate resources

**Example:**
```bash
# Fix certificate issues
./fix-certificate.sh --namespace ingext --domain gcp.k8.ingext.io

# Then monitor progress
kubectl get certificate -n ingext -w
kubectl get challenge -n ingext -w
```

### `cleanup-ingext-gke.sh` - Cleanup Script

Removes Ingext installation and optionally deletes the GKE cluster and project.

**Required Arguments:**
- `--project` - GCP project ID
- `--region` - GCP region
- `--cluster-name` - GKE cluster name

**Optional Arguments:**
- `--namespace` - Kubernetes namespace (default: `ingext`)
- `--keep-project` - Keep project after cleanup
- `--env-file` - Path to environment file (default: `./ingext-gke.env`)

**Auto-loads from .env file:**
The script automatically loads `./ingext-gke.env` if it exists, so you can simply run:
```bash
./cleanup-ingext-gke.sh
```

No need to provide `--project`, `--region`, and `--cluster-name` if the `.env` file is present.

**Example:**
```bash
# Full cleanup (including project)
./cleanup-ingext-gke.sh \
  --project my-gcp-project \
  --region us-east1 \
  --cluster-name ingext-gke

# Keep project
./cleanup-ingext-gke.sh \
  --project my-gcp-project \
  --region us-east1 \
  --cluster-name ingext-gke \
  --keep-project
```

**What it does:**
1. Automatically loads settings from `ingext-gke.env` if available
2. Uninstalls all Helm releases in the namespace
3. Uninstalls cert-manager
4. Deletes the GKE cluster
5. Optionally deletes the project
6. Reminds user to remove DNS record

## Common Workflows

### Fresh Installation

```bash
# 0. Launch Docker container (if not already running)
./ingext-shell.sh
cd /workspace/ingext-gke-helper

# 1. Preflight check (recommended)
./preflight-gcp.sh
source ./ingext-gke.env

# 2. Install (uses .env file automatically)
./install-ingext-gke.sh

# 3. Check status
./status-ingext-gke.sh --namespace "$NAMESPACE"

# 4. Configure DNS (get instructions)
./dns-ingext-gke.sh --domain "$SITE_DOMAIN" --namespace "$NAMESPACE"

# 5. Wait for DNS (after creating DNS record)
./dns-ingext-gke.sh --domain "$SITE_DOMAIN" --namespace "$NAMESPACE" --wait

# 6. Verify everything is working
./status-ingext-gke.sh --namespace "$NAMESPACE"
```

### Using Existing GKE Cluster

```bash
# Skip GKE creation
./install-ingext-gke.sh \
  --project existing-project \
  --region us-east1 \
  --cluster-name existing-gke \
  --domain ingext.example.com \
  --email admin@example.com \
  --skip-gke-create
```

### Troubleshooting

```bash
# Check overall status
./status-ingext-gke.sh --namespace ingext

# Check DNS
./dns-ingext-gke.sh --domain ingext.example.com

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

**Problem:** GKE cluster creation fails
- **Prevention:** Run `./preflight-gcp.sh` first to check permissions and quotas
- **Solution:** Check GCP permissions and quota limits
- **Alternative:** Use `--skip-gke-create` if cluster already exists

**Problem:** Machine type not available for GKE
- **Solution:** Try a different machine type: `./install-ingext-gke.sh --machine-type e2-standard-2`
- **Check:** Run `./list-machine-types.sh` to see general availability
- **Common types:** `e2-standard-2`, `e2-standard-4`, `e2-standard-8`

**Problem:** Pods stuck in Pending
- **Solution:** Check node resources: `kubectl describe nodes`
- **Check:** Node count may be insufficient
- **Check:** Machine type may be too small for workloads

**Problem:** Helm install fails
- **Solution:** Ensure you're logged in to GCP: `gcloud auth login`
- **Check:** Verify kubectl context: `kubectl config current-context`
- **Check:** Verify API enablement: `./check-apis.sh`

**Problem:** `gcloud` command not found
- **Solution:** Install `gcloud` inside the container:
  ```bash
  # Inside the Docker container
  curl https://sdk.cloud.google.com | bash
  exec -l $SHELL
  gcloud init
  ```
- **Check:** Verify the container has gcloud: `gcloud --version`
- **Note:** The `ingext-gcp-shell.sh` script mounts GCP credentials, but the base image may not include `gcloud` yet. A dedicated GCP image may be created later.

### DNS Issues

**Problem:** DNS not resolving
- **Solution:** Wait 5-15 minutes for DNS propagation
- **Check:** Verify DNS record with: `nslookup your-domain.com`
- **Use:** `./dns-ingext-gke.sh --domain your-domain.com --wait`

**Problem:** Certificate not issuing
- **Solution:** DNS must resolve correctly first
- **Check:** `kubectl get challenge -n ingext`
- **Check:** `kubectl describe challenge -n ingext`

### Access Issues

**Problem:** Cannot access https://your-domain.com
- **Check:** DNS is configured: `./dns-ingext-gke.sh --domain your-domain.com`
- **Check:** Certificate is ready: `kubectl get certificate -n ingext`
- **Check:** Ingress has IP: `kubectl get ingress -n ingext`

## Environment Variables

All scripts support environment variables as alternatives to command-line arguments. Flags always override environment variables.

**Template File:** See `ingext-gke.env.example` for a template with all available variables and documentation.

| Variable | Description | Example |
|----------|-------------|---------|
| `PROJECT_ID` | GCP project ID | `my-gcp-project` |
| `REGION` | GCP region | `us-east1` |
| `CLUSTER_NAME` | GKE cluster name | `ingext-gke` |
| `SITE_DOMAIN` | Public domain | `ingext.example.com` |
| `CERT_EMAIL` | Certificate email | `admin@example.com` |
| `NAMESPACE` | Kubernetes namespace | `ingext` |
| `NODE_COUNT` | Node count per zone | `2` |
| `MACHINE_TYPE` | Machine type | `e2-standard-4` |

**Note:** The preflight wizard (`./preflight-gcp.sh`) will generate a complete `ingext-gke.env` file with all required variables. You can also manually copy and edit `ingext-gke.env.example` if you prefer.

## Troubleshooting

For detailed troubleshooting information, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

**Common issues:**
- **Ingress missing:** Use `./recreate-ingress.sh` to restore it
- **API backend not healthy:** Wait 10-15 minutes for health checks to propagate
- **DNS not resolving:** Wait 5-15 minutes for DNS propagation
- **Certificate not issuing:** DNS must resolve correctly first

## Additional Resources

- [Ingext Helm Charts Repository](https://github.com/SecurityDo/ingext-helm-charts)
- [Google Kubernetes Engine Documentation](https://cloud.google.com/kubernetes-engine/docs/)
- [cert-manager Documentation](https://cert-manager.io/docs/)
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Detailed troubleshooting guide

## Support

If you encounter issues:
1. Check the troubleshooting section above
2. Review script output and error messages
3. Check Kubernetes resources: `kubectl get all -n ingext`
4. Open an issue in the [ingext-helm-charts repository](https://github.com/SecurityDo/ingext-helm-charts)

## License

These scripts are provided as-is for managing Ingext installations. Refer to the [ingext-helm-charts repository](https://github.com/SecurityDo/ingext-helm-charts) for Ingext licensing information.

