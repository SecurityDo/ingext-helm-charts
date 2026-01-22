# Integrated Azure Data Lakehouse Installer (AKS + Blob)

This directory contains automated scripts for a unified deployment of the **Ingext Data Fabric** and **Ingext Datalake** on Microsoft Azure. This installer leverages **Azure Kubernetes Service (AKS)** for compute and **Azure Blob Storage** for high-scale, cost-effective data storage.

## Overview

Deploy a production-ready, self-hosted data platform on Azure in minutes. The installer automates:
- **Compute**: Azure Kubernetes Service (AKS) cluster optimized for data processing.
- **Storage**: Azure Storage Accounts and Blob Containers configured for data lake workloads.
- **Networking**: Azure Application Gateway integrated with **AGIC (Application Gateway Ingress Controller)** for automated load balancing and TLS.
- **Security**: **Azure Workload Identity** for secure, passwordless access from Kubernetes pods to Azure resources.

## Deployment Workflow

0. **Docker Shell (Recommended)**: Launch the pre-configured toolbox containing all necessary CLI tools (`az`, `kubectl`, `helm`).
   ```bash
   ./start-docker-shell.sh
   ```
1. **Preflight Wizard**: Run the interactive script to verify your Azure subscription, resource availability, and generate your configuration.
   ```bash
   ./preflight-lakehouse.sh
   ```
2. **Install**: Deploy the entire Lakehouse stack with a single command.
   ```bash
   source lakehouse-azure.env
   ./install-lakehouse.sh
   ```
3. **Post-Installation (DNS)**: Configure your DNS once the Application Gateway is provisioned.
   - See [Azure DNS Setup Guide](AZURE_DNS_SETUP.md) for mapping your domain to the Public IP.
4. **Cleanup**: Systematically delete the Resource Group to stop billing.
   ```bash
   source lakehouse-azure.env
   ./cleanup-lakehouse.sh
   ```

## Infrastructure Configuration Guides

For detailed, step-by-step instructions on Azure-specific setup, refer to:
- [Azure DNS Setup](AZURE_DNS_SETUP.md): Mapping your domain to the Application Gateway public IP.

## Included Scripts & Tools

- `start-docker-shell.sh`: Secure Docker environment with all required Azure cloud tools.
- `preflight-lakehouse.sh`: Interactive environment validator and configuration generator.
- `install-lakehouse.sh`: Master orchestrator for AKS, Storage, Workload Identity, and Helm deployments.
- `cleanup-lakehouse.sh`: Safe teardown of all provisioned Azure resources.
- `lakehouse-status.sh`: Real-time health report for all components and pods.
- `lakehouse-logs.sh`: Simple CLI for tailing logs from any component.

## Prerequisites

- **Azure CLI** authenticated with appropriate permissions.
- **DNS Control** for your domain.
- **Docker** (to use the pre-configured shell).

### How to Configure Azure CLI

The Azure CLI uses `az login` to authenticate. If you are running inside the Docker shell, it mounts your local `~/.azure` directory, so if you are logged in on your host, you are logged in in the container.

**Verify it works:**
```bash
az account show
```
If this returns your subscription and user details, your CLI is successfully logged in.

**Switching Subscriptions:**
If you have multiple subscriptions, you can set the active one:
```bash
az account set --subscription "Your Subscription Name or ID"
```

---

### Troubleshooting "AccessDenied"
If you get an "AccessDenied" error during installation, ensure your account has **Owner** or **Contributor** permissions on the subscription. The installer needs to create Resource Groups, Managed Identities, and assign roles.
