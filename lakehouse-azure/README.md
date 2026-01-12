# Integrated Azure Lakehouse Installer

This directory contains scripts for a unified deployment of both **Ingext Stream** and **Ingext Datalake** on Microsoft Azure using Azure Kubernetes Service (AKS).

## Overview

The Lakehouse installer provides a seamless setup experience, combining:
- **Ingext Stream**: For real-time data ingestion, transformation, and routing.
- **Ingext Datalake**: For scalable storage (Azure Blob Storage) and search capabilities.

## Workflow

0. **Docker Shell (Recommended)**: Launch the pre-configured toolbox containing all necessary CLI tools.
   ```bash
   ./start-docker-shell.sh
   ```
1. **Preflight**: Run the interactive wizard to verify your Azure environment and generate a configuration file.
   ```bash
   ./preflight-lakehouse.sh
   ```
2. **Install**: Deploy the entire Lakehouse stack.
   ```bash
   source lakehouse-azure.env
   ./install-lakehouse.sh
   ```
3. **Post-Installation (DNS)**: Wait for the Azure Application Gateway to be provisioned and then configure your DNS.
   - **Watch for your Gateway IP address**:
     ```bash
     kubectl get ingress -n ingext -w
     ```
   - See [Azure DNS Setup Guide](AZURE_DNS_SETUP.md) for detailed instructions on mapping your domain.
4. **Cleanup**: Tear down all resources when they are no longer needed.
   ```bash
   source lakehouse-azure.env
   ./cleanup-lakehouse.sh
   ```

## Infrastructure Guides

For detailed instructions on Azure DNS configuration, refer to:
- [Azure DNS Setup](AZURE_DNS_SETUP.md): Mapping your domain to the Application Gateway public IP.

## Scripts

- `start-docker-shell.sh`: Launches a Docker container with all required tools and mounts your Azure credentials.
- `preflight-lakehouse.sh`: Verifies Azure authentication, checks resource availability, and collects user input.
- `install-lakehouse.sh`: Orchestrates the creation of AKS, Storage Accounts, Workload Identity, and all Ingext components.
- `cleanup-lakehouse.sh`: Systematically removes the Resource Group and all contained resources.
- `lakehouse-status.sh`: Shows a two-column status report of all installed components and infrastructure.
- `lakehouse-logs.sh`: Quick access to error logs for any component (e.g. `./lakehouse-logs.sh api`).

## Prerequisites

- **Azure CLI** (`az`) installed and authenticated.
- **kubectl** and **Helm** installed.
- **Docker** (if running via the Ingext shell).
- **DNS control** for your specified domain.

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
