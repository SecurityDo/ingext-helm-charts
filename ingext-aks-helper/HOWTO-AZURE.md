# How to Self-Host Ingext Stream on Azure (AKS)

This guide walks through deploying **Ingext Stream** as a **self-hosted streaming and routing layer** in **Azure Kubernetes Service (AKS)** using the helper scripts provided in the `ingext-aks-helper` directory.

The goal is simple:

> Collect, transform, route, and search streaming data **inside your own Azure boundary**, without sending raw telemetry to a SaaS service.

This article focuses on **Ingext Stream only**. A separate article will cover the Ingext Data Lake when that repository is published.

---

## What You'll Build

At the end of this guide, you will have:

* An AKS cluster running Ingext Stream
* In-cluster services for:
  * Stream ingestion
  * Transformation and routing
  * Hot-path search
* Azure-native ingress and TLS
* A foundation ready to route data to:
  * SIEMs
  * Object storage
  * Future data lake destinations

No SaaS dependencies. No external control plane.

---

## Prerequisites

You will need:

* **Docker** installed and running ([Download Docker Desktop](https://www.docker.com/products/docker-desktop))
* **Azure subscription** - The preflight script will help verify this and guide you if there are issues
* **DNS control** for a domain (for ingress and TLS)

**Note:** All required tools (`az`, `kubectl`, `helm`) are pre-installed in the Docker container. You don't need to install them separately.

The helper scripts are designed to run inside the Docker container provided by `ingext-shell.sh`, which includes all necessary tools and ensures consistent versions.

---

## Step 1: Launch the Docker Container

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

You should see the following helper scripts:

* `preflight-azure.sh` - Interactive wizard to collect settings and verify prerequisites
* `install-ingext-aks.sh` - Main installer that creates AKS and deploys Ingext
* `status-ingext-aks.sh` - Check installation status and component health
* `dns-ingext-aks.sh` - Help configure and verify DNS
* `cleanup-ingext-aks.sh` - Remove the installation
* `check-providers.sh` - Check Azure provider registration status
* `list-vm-sizes.sh` - List available VM sizes for AKS

---

## Step 2: Run the Preflight Wizard

The preflight wizard (`preflight-azure.sh`) is an interactive tool that:

* **Helps with Azure setup** - If you're not logged in, it will prompt you to login
* **Verifies your subscription** - Checks if you have a valid Azure subscription with billing
* **Checks provider registrations** - Verifies Microsoft.ContainerService and Microsoft.Network are registered
* **Guides you through issues** - If there are problems (no subscription, wrong permissions, etc.), it provides clear guidance
* **Collects all required settings** - Prompts for region, resource group, cluster name, domain, email
* **Shows available VM sizes** - Automatically displays VM sizes available in your region
* **Checks DNS resolution status** - Verifies your domain setup
* **Generates environment file** - Creates `ingext-aks.env` with all your settings

**Important:** You don't need everything perfect upfront. The preflight script will help identify and guide you through any issues.

**Run the preflight wizard:**

```bash
chmod +x preflight-azure.sh
./preflight-azure.sh
```

The wizard will prompt you for:

* **Azure region** (e.g., `eastus`, `westus2`)
* **Resource group name** (will be created if it doesn't exist)
* **AKS cluster name**
* **Node count** (default: 2)
* **Node VM size** (Standard_D4as_v5 recommended)
* **Kubernetes namespace** (default: `ingext`)
* **Public domain** for Ingext (e.g., `ingext.example.com`)
* **Email** for certificate issuer (Let's Encrypt)

It will also ask readiness questions about billing, permissions, quota, and DNS control.

**Important:** The wizard shows general VM availability, but AKS has additional restrictions. If a VM size fails during installation, the installer will show the actual AKS-available sizes.

After completion, you'll have an `ingext-aks.env` file with all your settings.

---

## Step 3: Install Ingext on AKS

Once preflight is complete, source the environment file and run the installer:

```bash
source ./ingext-aks.env
./install-ingext-aks.sh
```

**What the installer does:**

1. **Creates AKS cluster** with Application Gateway add-on enabled
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
   * Azure Application Gateway ingress

The installer will show a deployment plan and ask for confirmation before proceeding.

**Note:** AKS cluster creation can take 10-15 minutes. The full installation typically takes 20-30 minutes.

---

## Step 4: Check Installation Status

Use the status checker to verify everything is running:

```bash
./status-ingext-aks.sh --namespace ingext
```

This shows:

* AKS cluster status
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
./dns-ingext-aks.sh --domain <your-domain>
```

This shows:

* The ingress public IP
* DNS configuration instructions
* Current DNS resolution status
* Certificate challenge status

**After creating the DNS record**, wait for DNS propagation (usually 5-15 minutes), then verify:

```bash
./dns-ingext-aks.sh --domain <your-domain> --wait
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
* Running inside **your Azure subscription**
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
./preflight-azure.sh
```
Interactive setup and prerequisite checking.

### Installer
```bash
source ./ingext-aks.env
./install-ingext-aks.sh
```
Or with explicit arguments:
```bash
./install-ingext-aks.sh \
  --location eastus \
  --resource-group ingext-rg \
  --cluster-name ingext-aks \
  --domain ingext.example.com \
  --email admin@example.com
```

### Status Checker
```bash
./status-ingext-aks.sh --namespace ingext
```

### DNS Helper
```bash
./dns-ingext-aks.sh --domain ingext.example.com
./dns-ingext-aks.sh --domain ingext.example.com --wait
```

### Cleanup
```bash
./cleanup-ingext-aks.sh
```
Automatically loads from `ingext-aks.env` if available, or use explicit arguments.

### Additional Helpers
```bash
./check-providers.sh          # Check Azure provider registration
./list-vm-sizes.sh            # List available VM sizes
```

---

## Troubleshooting

### VM Size Issues

If the installer fails with a VM size error, it will show the actual available sizes for AKS. Use one of those sizes:

```bash
./install-ingext-aks.sh --node-vm-size <size-from-error-message>
```

Or update your `.env` file and rerun. Recommended sizes include `Standard_D4as_v5` (AMD EPYC) or Intel alternatives like `standard_dc4ds_v3`.

### DNS Not Resolving

Wait 5-15 minutes for DNS propagation, then verify:

```bash
./dns-ingext-aks.sh --domain <your-domain>
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
./status-ingext-aks.sh --namespace ingext
kubectl logs -n ingext -f ingext-api-0
kubectl logs -n ingext -f ingext-platform-0
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

* Routing streams to Parquet in Azure Blob / ADLS
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

This guide showed how to deploy **Ingext Stream** on Azure using the helper scripts to create a **self-hosted streaming data control plane**.

You now have the first half of a self-hosted data lake architecture:

> **Control first. Storage second. History last.**

---

## Additional Resources

* [Ingext Helm Charts Repository](https://github.com/SecurityDo/ingext-helm-charts)
* [Azure Kubernetes Service Documentation](https://docs.microsoft.com/azure/aks/)
* [cert-manager Documentation](https://cert-manager.io/docs/)

For issues or questions, open an issue in the [ingext-helm-charts repository](https://github.com/SecurityDo/ingext-helm-charts).

