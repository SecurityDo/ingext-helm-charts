# AWS Datalake Setup

This directory contains scripts and documentation for setting up the Ingext datalake on Amazon Web Services (AWS) using Amazon Elastic Kubernetes Service (EKS). The setup includes EKS cluster creation, S3 bucket configuration, service account setup with proper IAM permissions, Karpenter installation for dynamic pod management, and deployment of the Ingext datalake components.

## Overview

The AWS datalake setup automates the deployment of Ingext's datalake infrastructure on AWS, including:

- **EKS Cluster**: Kubernetes cluster with all necessary add-ons and drivers
- **S3 Storage**: Bucket for datalake data storage with lifecycle policies
- **Service Accounts**: Kubernetes service accounts with IAM roles for S3 access
- **Karpenter**: Node autoscaler for efficient resource management
- **Datalake Components**: Ingext datalake manager, workers, and search services

## Prerequisites

Before starting, ensure you have the following installed and configured:

### Required Tools

- **AWS CLI** (v2 recommended) - [Installation Guide](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- **eksctl** - [Installation Guide](https://eksctl.io/introduction/installation/)
- **kubectl** - [Installation Guide](https://kubernetes.io/docs/tasks/tools/)
- **Helm** (v3+) - [Installation Guide](https://helm.sh/docs/intro/install/)
- **bash** (version 4.0+)

### AWS Configuration

1. **AWS Account**: An active AWS account with appropriate permissions
2. **AWS Credentials**: Configured AWS credentials (via `~/.aws/credentials` or environment variables)
3. **AWS Profile**: An AWS profile configured (or use `default` profile)
4. **IAM Permissions**: Your AWS user/role needs permissions for:
   - EKS cluster creation and management
   - EC2 instance creation and management
   - IAM role and policy creation
   - S3 bucket creation and management
   - VPC and networking configuration

### Verify Prerequisites

```bash
# Check AWS CLI
aws --version

# Check eksctl
eksctl version

# Check kubectl
kubectl version --client

# Check Helm
helm version

# Verify AWS credentials
aws sts get-caller-identity
```

## Quick Start

The setup process follows this order:

1. **Prepare EKS Cluster** - Create cluster and install required add-ons
2. **Create S3 Bucket** - Set up storage bucket for datalake
3. **Setup Service Account** - Configure Kubernetes service account with S3 permissions
4. **Install Karpenter** - Set up node autoscaler
5. **Install Ingext Datalake** - Deploy datalake components

### Execution Order

```bash
# 1. Setup EKS cluster (takes 15-20 minutes)
./eks_setup.sh <profile> <awsRegion> <clusterName>

# 2. Create S3 bucket
./create_s3_bucket.sh <profile> <awsRegion> <bucketName> <expireDays>

# 3. Setup service account
./setup_ingext_serviceaccount.sh <namespace> <profile> <awsRegion> <clusterName> <bucketName>

# 4. Install Karpenter
./setup_karpenter.sh <profile> <awsRegion> <clusterName>

# 5. Install Ingext datalake (see aws_install.md for details)
# Follow the installation steps in aws_install.md
```

## Scripts Documentation

### eks_setup.sh

**Purpose**: Creates an EKS cluster and installs all required add-ons and drivers for the Ingext datalake.

**What it does**:
- Creates an EKS cluster (version 1.34) with managed node group
- Updates kubeconfig for cluster access
- Installs EKS Pod Identity Agent add-on
- Configures EBS CSI Driver with pod identity
- Installs gp3 StorageClass via Helm
- Installs Mountpoint for Amazon S3 CSI driver
- Sets up AWS Load Balancer Controller with IAM permissions

**Usage**:
```bash
./eks_setup.sh <profile> <awsRegion> <clusterName>
```

**Parameters**:
- `profile`: AWS profile name (e.g., `demo`, `default`)
- `awsRegion`: AWS region (e.g., `us-east-1`, `eu-west-1`)
- `clusterName`: Name for the EKS cluster (e.g., `ingext-lake`)

**Example**:
```bash
./eks_setup.sh demo us-east-1 ingext-lake
```

**What it creates**:
- EKS cluster with 3 t3.large nodes (scales 3-4 nodes)
- Pod Identity associations for EBS CSI and Load Balancer Controller
- IAM roles and policies for AWS services
- StorageClass for gp3 volumes
- AWS Load Balancer Controller deployment

**Estimated Time**: 15-20 minutes

**Verification**:
```bash
# Check cluster status
kubectl cluster-info

# Verify add-ons
kubectl get pods -n kube-system | grep -E "ebs-csi|aws-load-balancer"

# Check storage class
kubectl get storageclass
```

---

### create_s3_bucket.sh

**Purpose**: Creates an S3 bucket for datalake storage with lifecycle policies for automatic object expiration.

**What it does**:
- Creates an S3 bucket in the specified region
- Configures lifecycle policy to expire objects after specified days
- Handles region-specific bucket creation requirements

**Usage**:
```bash
./create_s3_bucket.sh <profile> <awsRegion> <bucketName> <expireDays>
```

**Parameters**:
- `profile`: AWS profile name
- `awsRegion`: AWS region where bucket will be created
- `bucketName`: Unique S3 bucket name (must be globally unique)
- `expireDays`: Number of days after which objects expire (e.g., `30`)

**Example**:
```bash
./create_s3_bucket.sh demo us-east-1 my-ingext-datalake-bucket 30
```

**What it creates**:
- S3 bucket with the specified name
- Lifecycle configuration that expires all objects after the specified days

**Important Notes**:
- S3 bucket names must be globally unique across all AWS accounts
- The script handles the special case for `us-east-1` region (no LocationConstraint)
- If the bucket already exists and is owned by you, the script will continue

**Verification**:
```bash
# List buckets
aws s3 ls --profile <profile>

# Check bucket lifecycle
aws s3api get-bucket-lifecycle-configuration \
  --bucket <bucketName> \
  --profile <profile>
```

---

### setup_ingext_serviceaccount.sh

**Purpose**: Creates a Kubernetes service account with IAM role and permissions to access the S3 bucket.

**What it does**:
- Creates IAM policy with S3 read/write/list permissions for the bucket
- Creates IAM role with pod identity trust policy
- Creates pod identity association linking service account to IAM role
- Updates kubeconfig for cluster access

**Usage**:
```bash
./setup_ingext_serviceaccount.sh <namespace> <profile> <awsRegion> <clusterName> <bucketName>
```

**Parameters**:
- `namespace`: Kubernetes namespace (typically `ingext`)
- `profile`: AWS profile name
- `awsRegion`: AWS region
- `clusterName`: EKS cluster name
- `bucketName`: S3 bucket name (must match the bucket created earlier)

**Example**:
```bash
./setup_ingext_serviceaccount.sh ingext demo us-east-1 ingext-lake my-ingext-datalake-bucket
```

**What it creates**:
- IAM policy: `ingext_<namespace>-sa_S3_Policy` with S3 permissions
- IAM role: `ingext_<namespace>-sa` with pod identity trust
- Pod identity association linking the service account to the IAM role

**Important Notes**:
- The service account itself is created by the `ingext-community` Helm chart
- This script only sets up the IAM permissions and associations
- The service account name follows the pattern: `<namespace>-sa`

**Verification**:
```bash
# Check pod identity associations
eksctl get podidentityassociation \
  --cluster <clusterName> \
  --region <awsRegion> \
  --profile <profile>

# Verify IAM role exists
aws iam get-role --role-name ingext_<namespace>-sa --profile <profile>
```

---

### setup_karpenter.sh

**Purpose**: Installs and configures Karpenter for automatic node provisioning and scaling in the EKS cluster.

**What it does**:
- Tags VPC subnets and security groups for Karpenter discovery
- Creates IAM role for Karpenter-managed nodes
- Creates IAM role and policy for Karpenter controller
- Creates EKS access entry for nodes
- Creates pod identity association for Karpenter controller
- Installs Karpenter via Helm (version 1.8.3)

**Usage**:
```bash
./setup_karpenter.sh <profile> <awsRegion> <clusterName>
```

**Parameters**:
- `profile`: AWS profile name
- `awsRegion`: AWS region
- `clusterName`: EKS cluster name

**Example**:
```bash
./setup_karpenter.sh demo us-east-1 ingext-lake
```

**What it creates**:
- Node IAM role: `KarpenterNodeRole-<clusterName>`
- Controller IAM role: `KarpenterControllerRole-<clusterName>`
- Controller IAM policy with EC2, EKS, and IAM permissions
- EKS access entry for node role
- Pod identity association for Karpenter service account
- Karpenter deployment in `kube-system` namespace

**Important Notes**:
- Karpenter version 1.8.3 is compatible with EKS 1.34+
- The script creates a service-linked role for Spot instances
- VPC resources are tagged with `karpenter.sh/discovery` for cluster discovery

**Verification**:
```bash
# Check Karpenter pods
kubectl get pods -n kube-system -l app.kubernetes.io/name=karpenter

# View Karpenter logs
kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter

# Check Karpenter metrics
kubectl get deployment -n kube-system karpenter
```

---

## Installation Steps

For detailed installation instructions, including deploying the Ingext datalake components, see [aws_install.md](./aws_install.md).

The installation process includes:

1. **EKS Cluster Setup** (via `eks_setup.sh`)
2. **S3 Bucket Creation** (via `create_s3_bucket.sh`)
3. **Service Account Configuration** (via `setup_ingext_serviceaccount.sh`)
4. **Karpenter Installation** (via `setup_karpenter.sh`)
5. **Datalake Configuration**:
   - Install `ingext-lake-config` Helm chart
   - Setup node pools for datalake workloads
   - Install datalake components (manager, worker, search service)

Refer to `aws_install.md` for complete Helm commands and configuration options.

## Verification

After completing the setup, verify each component:

### Verify EKS Cluster
```bash
kubectl cluster-info
kubectl get nodes
```

### Verify S3 Bucket
```bash
aws s3 ls s3://<bucketName> --profile <profile>
```

### Verify Service Account
```bash
kubectl get serviceaccount -n <namespace>
eksctl get podidentityassociation --cluster <clusterName> --region <awsRegion>
```

### Verify Karpenter
```bash
kubectl get pods -n kube-system -l app.kubernetes.io/name=karpenter
kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter
```

### Verify Datalake Components
```bash
kubectl get pods -n <namespace> | grep -E "lake|search"
kubectl get statefulset,deployment -n <namespace>
```

## Troubleshooting

### Common Issues

#### EKS Cluster Creation Fails

**Problem**: `eksctl create cluster` fails with permission errors.

**Solution**:
- Verify AWS credentials: `aws sts get-caller-identity`
- Check IAM permissions for EKS, EC2, IAM, and VPC
- Ensure the AWS profile has sufficient permissions

#### S3 Bucket Name Already Exists

**Problem**: Bucket creation fails because name is already taken globally.

**Solution**: Use a unique bucket name (e.g., include timestamp or account ID):
```bash
BUCKET_NAME="ingext-datalake-$(date +%s)"
./create_s3_bucket.sh <profile> <region> $BUCKET_NAME <days>
```

#### Pod Identity Association Already Exists

**Problem**: Script fails when trying to create an association that already exists.

**Solution**: This is handled automatically by the scripts. If you need to recreate:
```bash
eksctl delete podidentityassociation \
  --cluster <clusterName> \
  --namespace <namespace> \
  --service-account-name <sa-name> \
  --region <region>
```

#### Karpenter Not Scaling Nodes

**Problem**: Karpenter is installed but not creating nodes.

**Solution**:
- Verify VPC tags: `aws ec2 describe-subnets --filters "Name=tag:karpenter.sh/discovery,Values=<clusterName>"`
- Check Karpenter logs: `kubectl logs -n kube-system -l app.kubernetes.io/name=karpenter`
- Verify node role has EKS access entry
- Check NodePool and NodeClass resources (if using custom configuration)

#### Service Account Cannot Access S3

**Problem**: Pods using the service account cannot access S3 bucket.

**Solution**:
- Verify pod identity association exists
- Check IAM policy permissions: `aws iam get-policy-version --policy-arn <policy-arn> --version-id v1`
- Verify bucket name matches in IAM policy
- Check pod annotations include the service account name

### Getting Help

- Check script logs for detailed error messages
- Review AWS CloudWatch logs for EKS cluster issues
- Verify all prerequisites are installed and configured
- Ensure AWS credentials have sufficient permissions

## Additional Resources

- [AWS EKS Documentation](https://docs.aws.amazon.com/eks/)
- [Karpenter Documentation](https://karpenter.sh/)
- [EKS Pod Identity Documentation](https://docs.aws.amazon.com/eks/latest/userguide/pod-identities.html)
- [Main Ingext Installation Guide](../README.md)

## Script Execution Order Summary

For a complete setup, execute scripts in this order:

```bash
# 1. EKS Cluster (15-20 minutes)
./eks_setup.sh <profile> <region> <cluster-name>

# 2. S3 Bucket
./create_s3_bucket.sh <profile> <region> <bucket-name> <expire-days>

# 3. Service Account
./setup_ingext_serviceaccount.sh <namespace> <profile> <region> <cluster-name> <bucket-name>

# 4. Karpenter
./setup_karpenter.sh <profile> <region> <cluster-name>

# 5. Follow aws_install.md for datalake component installation
```

Make all scripts executable before running:
```bash
chmod +x *.sh
```

