# How to Self-Host Ingext Stream on Google Cloud Platform (GKE)

This guide walks through deploying **Ingext Stream** as a **self-hosted streaming and routing layer** in **Google Kubernetes Engine (GKE)** using the helper scripts provided in the `ingext-gke-helper` directory.

The goal is simple:

> Collect, transform, route, and search streaming data **inside your own GCP boundary**, without sending raw telemetry to a SaaS service.

This article focuses on **Ingext Stream only**. A separate article will cover the Ingext Data Lake when that repository is published.

---

## What You'll Build

At the end of this guide, you will have:

* A GKE regional cluster running Ingext Stream
* In-cluster services for:
  * Stream ingestion
  * Transformation and routing
  * Hot-path search
* GCP-native ingress and TLS (Google Cloud Load Balancer)
* A foundation ready to route data to:
  * SIEMs
  * Object storage
  * Future data lake destinations

No SaaS dependencies. No external control plane.

---

## Prerequisites

You will need:

* **Docker** installed and running ([Download Docker Desktop](https://www.docker.com/products/docker-desktop))
* **GCP project** with billing enabled - The preflight script will help verify this and guide you if there are issues
* **DNS control** for a domain (for ingress and TLS)

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

**Note:** The `ingext-gcp-shell.sh` script uses the base `ingext-shell` Docker image and mounts your GCP credentials. If `gcloud` is not available in the container, install it:

```bash
# Inside the Docker container
curl https://sdk.cloud.google.com | bash
exec -l $SHELL
gcloud init
```

The helper scripts are designed to run inside the Docker container provided by `ingext-gcp-shell.sh`, which mounts GCP credentials and includes necessary tools (`kubectl`, `helm`).

---

## Step 1: Launch the Docker Container

The helper scripts run inside a pre-configured Docker container that includes all necessary tools.

**Start the container:**

```bash
# From the ingext-helm-charts repository root
chmod +x ingext-gcp-shell.sh
./ingext-gcp-shell.sh
```

This will:
* Pull the latest container image
* Mount your current directory to `/workspace`
* Preserve your GCP credentials and kubectl config
* Drop you into a bash prompt inside the container

**Navigate to the helper scripts:**

```bash
cd /workspace/ingext-gke-helper
```

You should see the following helper scripts:

* `preflight-gcp.sh` - Interactive wizard to collect settings and verify prerequisites
* `install-ingext-gke.sh` - Main installer that creates GKE and deploys Ingext
* `status-ingext-gke.sh` - Check installation status and component health
* `dns-ingext-gke.sh` - Help configure and verify DNS
* `cleanup-ingext-gke.sh` - Remove the installation
* `check-apis.sh` - Check GCP API enablement status
* `list-machine-types.sh` - List available machine types for GKE

---

## Step 2: Run the Preflight Wizard

The preflight wizard (`preflight-gcp.sh`) is an interactive tool that:

* **Helps with GCP setup** - If you're not logged in, it will prompt you to login
* **Verifies your project** - Checks if you have a valid GCP project with billing
* **Checks API enablement** - Verifies required APIs (container.googleapis.com, compute.googleapis.com) are enabled
* **Guides you through issues** - If there are problems (no project, wrong permissions, etc.), it provides clear guidance
* **Collects all required settings** - Prompts for project, region, cluster name, domain, email
* **Shows available machine types** - Automatically displays machine types available in your region
* **Checks DNS resolution status** - Verifies your domain setup
* **Generates environment file** - Creates `ingext-gke.env` with all your settings

**Important:** You don't need everything perfect upfront. The preflight script will help identify and guide you through any issues.

**Run the preflight wizard:**

```bash
chmod +x preflight-gcp.sh
./preflight-gcp.sh
```

The wizard will prompt you for:

* **GCP project ID** (e.g., `my-gcp-project`)
* **GCP region** (e.g., `us-east1`, `us-west1`)
* **GKE cluster name**
* **Node count per zone** (default: 2, regional clusters have nodes in multiple zones)
* **Machine type** (shows available types automatically)
* **Kubernetes namespace** (default: `ingext`)
* **Public domain** for Ingext (e.g., `ingext.example.com`)
* **Email** for certificate issuer (Let's Encrypt)

It will also ask readiness questions about billing, permissions, quota, and DNS control.

**Important:** The wizard shows general machine type availability. If a machine type fails during installation, the installer will show guidance.

After completion, you'll have an `ingext-gke.env` file with all your settings.

---

## Step 3: Install Ingext on GKE

Once preflight is complete, source the environment file and run the installer:

```bash
source ./ingext-gke.env
./install-ingext-gke.sh
```

**What the installer does:**

1. **Creates GKE regional cluster** with VPC-native networking (required for ingress)
2. **Installs dependencies:**
   * Redis (short-lived state and coordination)
   * OpenSearch (hot-path search and indexing)
   * VictoriaMetrics (metrics and internal telemetry)
   * etcd (single-node, lightweight coordination)
3. **Deploys Ingext Stream components:**
   * Configuration
   * Initialization jobs
   * Main application services
4. **Sets up ingress and TLS:**
   * cert-manager for certificate management
   * Certificate issuer (Let's Encrypt)
   * GKE Ingress (Google Cloud Load Balancer)

The installer will show a deployment plan and ask for confirmation before proceeding.

**Note:** GKE cluster creation can take 10-15 minutes. The full installation typically takes 20-30 minutes.

---

## Step 4: Check Installation Status

Use the status checker to verify everything is running:

```bash
./status-ingext-gke.sh --namespace ingext
```

This shows:

* GKE cluster status
* Helm releases
* Pod status and health
* Ingress configuration and public IP
* Certificate status
* Service endpoints

All status is color-coded (green/yellow/red) for quick assessment.

---

## Step 5: Configure DNS

The installer will display the ingress public IP. You need to create a DNS A-record pointing your domain to this IP.

**Get DNS instructions:**

```bash
./dns-ingext-gke.sh --domain <your-domain>
```

This shows:

* The ingress public IP
* DNS configuration instructions
* Current DNS resolution status
* Certificate challenge status

**After creating the DNS record**, wait for DNS propagation (usually 5-15 minutes), then verify:

```bash
./dns-ingext-gke.sh --domain <your-domain> --wait
```

The `--wait` flag will poll until DNS is correctly configured.

---

## Step 6: Access Ingext Stream

Once DNS is configured and the certificate is issued:

* **URL:** `https://<your-domain>`
* **Username:** `admin@ingext.io`
* **Password:** `ingext`

**Important:** Change these default credentials after first login.

You can verify certificate status:

```bash
kubectl get certificate -n ingext
kubectl get challenge -n ingext
```

---

## What You Have Now

At this point, you have:

* A **self-hosted Ingext Stream deployment**
* Running inside **your GCP project**
* With **no data leaving your boundary**
* Ready to:
  * Accept data
  * Normalize it
  * Route it
  * Make selective data searchable

This is the **control plane** for your data flow.

---

## Helper Scripts Reference

### Preflight Wizard
```bash
./preflight-gcp.sh
```
Interactive setup and prerequisite checking.

### Installer
```bash
source ./ingext-gke.env
./install-ingext-gke.sh
```
Or with explicit arguments:
```bash
./install-ingext-gke.sh \
  --project my-gcp-project \
  --region us-east1 \
  --cluster-name ingext-gke \
  --domain ingext.example.com \
  --email admin@example.com
```

### Status Checker
```bash
./status-ingext-gke.sh --namespace ingext
```

### DNS Helper
```bash
./dns-ingext-gke.sh --domain ingext.example.com
./dns-ingext-gke.sh --domain ingext.example.com --wait
```

### Cleanup
```bash
./cleanup-ingext-gke.sh
```
Automatically loads from `ingext-gke.env` if available, or use explicit arguments.

### Additional Helpers
```bash
./check-apis.sh              # Check GCP API enablement
./list-machine-types.sh      # List available machine types
```

---

## Troubleshooting

### Machine Type Issues

If the installer fails with a machine type error, try a different type:

```bash
./install-ingext-gke.sh --machine-type e2-standard-2
```

Or update your `.env` file and rerun.

### DNS Not Resolving

Wait 5-15 minutes for DNS propagation, then verify:

```bash
./dns-ingext-gke.sh --domain <your-domain>
```

### Certificate Not Issuing

Check certificate challenges:

```bash
kubectl get challenge -n ingext
kubectl describe challenge -n ingext
```

DNS must resolve correctly before certificates can be issued.

### Pods Not Starting

Check pod status and logs:

```bash
./status-ingext-gke.sh --namespace ingext
kubectl logs -n ingext -f ingext-api-0
kubectl logs -n ingext -f ingext-platform-0
```

### API Not Enabled

If APIs are not enabled, the installer will attempt to enable them. You can also enable manually:

```bash
./check-apis.sh --project <project-id>
```

---

## What This Is (and Is Not)

### This **is**

* A streaming ingestion and routing layer
* A way to control data *before* it is stored
* A way to avoid raw-ingest SaaS pricing
* A foundation for a self-hosted data lake

### This **is not**

* A long-term data lake by itself
* A replacement for all analytics tools
* A SaaS product
* A "set it and forget it" black box

Ingext Stream is designed to make **intentional decisions at ingest time**.

---

## What Comes Next

Once Ingext Data Lake is published, the next steps will include:

* Routing streams to Parquet in Google Cloud Storage
* Long-term retention with lifecycle policies
* Historical replay and analysis
* Cost-efficient compliance storage

That will be covered in a **separate article** focused on storage and history.

---

## Why This Matters

By deploying Ingext Stream yourself:

* You decide what data is collected
* You decide where it goes
* You decide what is searchable
* You decide what is retained
* You decide the cost curve

You are no longer constrained by:

* SaaS ingest pricing
* Cross-cloud egress fees
* Vendor retention limits
* External control planes

---

## Summary

This guide showed how to deploy **Ingext Stream** on Google Cloud Platform using the helper scripts to create a **self-hosted streaming data control plane**.

You now have the first half of a self-hosted data lake architecture:

> **Control first. Storage second. History last.**

---

## Additional Resources

* [Ingext Helm Charts Repository](https://github.com/SecurityDo/ingext-helm-charts)
* [Google Kubernetes Engine Documentation](https://cloud.google.com/kubernetes-engine/docs)
* [cert-manager Documentation](https://cert-manager.io/docs/)

For issues or questions, open an issue in the [ingext-helm-charts repository](https://github.com/SecurityDo/ingext-helm-charts).

