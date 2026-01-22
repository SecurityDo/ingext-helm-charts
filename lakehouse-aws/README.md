# Integrated AWS Data Lakehouse Installer (EKS + S3)

This directory contains automated scripts for a unified deployment of the **Ingext Data Fabric** and **Ingext Datalake** on Amazon Web Services (AWS). This installer leverages **Amazon EKS** for compute and **Amazon S3** for high-scale, cost-effective data storage.

## Overview

Deploy a production-ready, self-hosted data platform on AWS in minutes. The installer automates:
- **Compute**: Amazon EKS cluster with **Karpenter** for high-efficiency autoscaling (including Spot instances).
- **Storage**: Amazon S3 buckets configured for high-throughput data ingestion.
- **Networking**: AWS Application Load Balancer (ALB) integrated with **AWS Certificate Manager (ACM)** for automated TLS.
- **Security**: IAM Pod Identity for secure, least-privilege access to AWS resources.

## Deployment Workflow

0. **Docker Shell (Recommended)**: Launch the pre-configured toolbox containing all necessary CLI tools (`aws`, `kubectl`, `helm`, `eksctl`).
   ```bash
   ./start-docker-shell.sh
   ```
1. **Pre-configuration (SSL)**: Request your SSL certificate in AWS Certificate Manager.
   - See [ACM Setup Guide](ACM_SETUP.md) for detailed instructions.
   - **Keep your Certificate ARN handy**; you will need it for the preflight wizard.
2. **Preflight Wizard**: Run the interactive script to verify your AWS environment and generate your configuration.
   ```bash
   ./preflight-lakehouse.sh
   ```
3. **Install**: Deploy the entire Lakehouse stack with a single command.
   ```bash
   source lakehouse-aws.env
   ./install-lakehouse.sh
   ```
4. **Post-Installation (DNS)**: Configure Route 53 once the ALB is provisioned.
   - See [Route 53 Setup Guide](ROUTE53_SETUP.md) for mapping your domain.
5. **Cleanup**: Systematically delete all resources to stop billing.
   ```bash
   source lakehouse-aws.env
   ./cleanup-lakehouse.sh
   ```

## Infrastructure Configuration Guides

For detailed, step-by-step instructions on AWS-specific setup, refer to:
- [ACM Certificate Setup](ACM_SETUP.md): Requesting and validating public SSL certificates.
- [Route 53 DNS Setup](ROUTE53_SETUP.md): Creating Alias A records for your Application Load Balancer.

## Included Scripts & Tools

- `start-docker-shell.sh`: Secure Docker environment with all required cloud tools.
- `preflight-lakehouse.sh`: Interactive environment validator and configuration generator.
- `install-lakehouse.sh`: Master orchestrator for EKS, S3, IAM, and Helm deployments.
- `cleanup-lakehouse.sh`: Safe teardown of all provisioned AWS infrastructure.
- `lakehouse-status.sh`: Real-time health report for all components and pods.
- `add-user-access.sh`: Quickly grant administrative cluster access to other IAM users.
- `lakehouse-logs.sh`: Simple CLI for tailing logs from any component.

## Prerequisites

- **AWS CLI** with programmatic access.
- **DNS Control** for your domain (Route 53 recommended).
- **Docker** (to use the pre-configured shell).

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

