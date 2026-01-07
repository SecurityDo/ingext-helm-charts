# Integrated AWS Lakehouse Installer

This directory contains scripts for a unified deployment of both **Ingext Stream** and **Ingext Datalake** on Amazon Web Services (AWS) using Amazon Elastic Kubernetes Service (EKS).

## Overview

The Lakehouse installer provides a seamless setup experience, combining:
- **Ingext Stream**: For real-time data ingestion, transformation, and routing.
- **Ingext Datalake**: For scalable storage (S3) and search capabilities.

## Workflow

0. **Docker Shell (Recommended)**: Launch the pre-configured toolbox containing all necessary CLI tools.
   ```bash
   ./start-docker-shell.sh
   ```
1. **Pre-configuration (SSL)**: Request your SSL certificate in AWS Certificate Manager.
   - See [ACM Setup Guide](ACM_SETUP.md) for detailed instructions.
2. **Preflight**: Run the interactive wizard to verify your AWS environment and generate a configuration file.
   ```bash
   ./preflight-lakehouse.sh
   ```
3. **Install**: Deploy the entire Lakehouse stack.
   ```bash
   source lakehouse-aws.env
   ./install-lakehouse.sh
   ```
4. **Post-Installation (DNS)**: Configure Route 53 to point your domain to the new Load Balancer.
   - See [Route 53 Setup Guide](ROUTE53_SETUP.md) for detailed instructions.
5. **Cleanup**: Tear down all resources when they are no longer needed.
   ```bash
   source lakehouse-aws.env
   ./cleanup-lakehouse.sh
   ```

## Infrastructure Guides

For detailed step-by-step instructions on AWS infrastructure configuration, refer to these guides:
- [ACM Certificate Setup](ACM_SETUP.md): Requesting and validating SSL certificates.
- [Route 53 DNS Setup](ROUTE53_SETUP.md): Mapping your domain to the Application Load Balancer.

## Scripts

- `start-docker-shell.sh`: Launches a Docker container with all required tools and mounts your AWS credentials.
- `preflight-lakehouse.sh`: Verifies AWS credentials, checks resource availability, and collects user input.
- `install-lakehouse.sh`: Orchestrates the creation of EKS, S3, IAM roles, Karpenter, and all Ingext components.
- `cleanup-lakehouse.sh`: Systematically removes all provisioned AWS and Kubernetes resources.

## Prerequisites

- **AWS CLI** configured with appropriate permissions.
- **eksctl**, **kubectl**, and **Helm** installed.
- **Docker** (if running via the Ingext shell).
- **DNS control** for your specified domain.

### How to Configure AWS CLI (Bridge from Web Login to CLI)

The AWS CLI cannot "log in" using the Account ID + Username + Password you use in the web console. You must create "Access Keys" to bridge your web login to the terminal.

#### Step 1: Log into the AWS Console
Log into the web console using your normal:
- Account ID (or alias)
- IAM username
- Password (and MFA if required)

#### Step 2: Create CLI Credentials (in the console)
1. Go to **IAM** -> **Users** -> Click your username.
2. Go to the **Security credentials** tab.
3. Find **Access keys** and click **Create access key**.
4. Choose the use case **Command Line Interface (CLI)**.
5. Create the key and copy/save:
   - **Access key ID** (AKIA...)
   - **Secret access key**
   - *Save these safely; you won't be able to view the secret again.*

#### Step 3: Configure AWS CLI on your machine
In your terminal (or inside the Docker shell), run:
```bash
aws configure
```
Enter the following when prompted:
- **AWS Access Key ID**: (from Step 2)
- **AWS Secret Access Key**: (from Step 2)
- **Default region name**: (e.g., `us-east-1` or `us-east-2`)
- **Default output format**: `json`

**Verify it works:**
```bash
aws sts get-caller-identity
```
If this returns your account and ARN, your CLI is successfully "logged in".

#### Step 4: Enable Helm against EKS (Kubeconfig Setup)
If you are using Helm with an EKS cluster, your CLI needs your `kubeconfig` set up first:
```bash
aws eks update-kubeconfig --region us-east-2 --name YOUR_CLUSTER_NAME
```
**Confirm kubectl can reach the cluster:**
```bash
kubectl get ns
```
Now Helm will work correctly:
```bash
helm list -A
```

---

### Troubleshooting "AccessDenied" on EKS
If you get an "AccessDenied" error when running `kubectl` commands even though `aws sts get-caller-identity` works, it usually means:
1. Your IAM user does not have sufficient AWS permissions for EKS.
2. Your user is not mapped in the EKS cluster's RBAC (ConfigMap or Access Entries).
*This is a permission/mapping issue, not a login issue.*

