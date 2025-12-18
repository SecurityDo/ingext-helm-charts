# ingext-community

Welcome to the **ingext-community** repository. This project provides the Helm charts and configuration necessary to deploy the Ingext application on Kubernetes.

## Prerequisites

Before deploying, ensure you have the following installed and configured:

* **Kubernetes Cluster:** A running cluster (AWS EKS, Azure AKS, or similar).
* **Helm 3+:** Installed and configured on your local machine.
* **kubectl:** Configured to communicate with your cluster.
* **Cloud CLI:** (Optional) AWS CLI or Azure CLI if deploying to specific clouds.

OR run ingext cloud toolbox from a docker image. [Install from ingext cloud toolbox](install.md)

-----

## Prepare K8s cluster

### 1\. AWS EKS

#### Create one EKS cluster with eksctl

Expected Time: This process typically takes 15–20 minutes to complete.

```bash
eksctl create cluster \
  --name ingext-test-cluster \
  --profile your-aws-profile-name \
  --region us-east-1 \
  --version 1.34 \
  --nodegroup-name standard-workers \
  --node-type t3.large \
  --nodes 2 \
  --nodes-min 1 \
  --nodes-max 3 \
  --managed
```

#### Save the cluster context for kubectl

```bash
aws eks update-kubeconfig --region us-east-1 --name ingext-test-cluster
```

#### Install the Pod Identity Agent Add-on

Run the following command to install the agent.

```bash
eksctl create addon \
  --cluster ingext-test-cluster \
  --name eks-pod-identity-agent \
  --region us-east-1 \
  --profile your-aws-profile-name
```

#### Create the Pod Identity Association for the ebs csi controller

This command creates an IAM role with the AmazonEBSCSIDriverPolicy and associates it with the ebs-csi-controller-sa service account in your cluster.

```bash
eksctl create podidentityassociation \
  --cluster ingext-test-cluster \
  --namespace kube-system \
  --service-account-name ebs-csi-controller-sa \
  --role-name AmazonEKS_EBS_CSI_DriverRole \
  --permission-policy-arns arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
  --region us-east-1
```

> **Note:** To use an existing IAM role for the service account, use  `--role-arn  <roleARN>`, remove `--role-name` and `--permission-policy-arns` flags.

#### Install the EBS CSI Driver Add-on

Now that the permissions are set up, you can install the driver itself.

```bash
eksctl create addon \
  --cluster ingext-test-cluster \
  --name aws-ebs-csi-driver \
  --region us-east-1 \
  --profile your-aws-profile-name
```

#### Verification

Once the commands finish, you can verify the driver is running with:

```bash
kubectl get pods -n kube-system -l app.kubernetes.io/name=aws-ebs-csi-driver
```

#### install gp3 storageclass

```bash
helm install ingext-aws-gp3 oci://public.ecr.aws/ingext/ingext-aws-gp3
```

#### Configure service account for the AWS load balancer controller

```bash
curl -O https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json

aws iam create-policy \
    --profile your-aws-profile-name \
    --policy-name AWSLoadBalancerControllerIAMPolicy \
    --policy-document file://iam_policy.json

eksctl create podidentityassociation \
  --cluster ingext-test-cluster \
  --namespace kube-system \
  --service-account-name aws-load-balancer-controller \
  --role-name AWSLoadBalancerControllerRole \
  --permission-policy-arns arn:aws:iam::$(aws sts get-caller-identity --profile your-aws-profile-name --query Account --output text):policy/AWSLoadBalancerControllerIAMPolicy \
  --region us-east-1
```

#### Install the controller into the kube-system namespace

```bash
# 1. Add the EKS Helm repo
helm repo add eks https://aws.github.io/eks-charts
helm repo update

# 2. Install the chart
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=ingext-test-cluster \
  --set serviceAccount.create=true \
  --set serviceAccount.name=aws-load-balancer-controller \
  --set region=us-east-1 \
  --set vpcId=$(aws eks describe-cluster --name ingext-test-cluster --region us-east-1 --query "cluster.resourcesVpcConfig.vpcId" --output text --profile your-aws-profile-name)
```

#### Verify Installation

Wait about 30-60 seconds, then check if the controller pods are running:

```bash
kubectl get deployment -n kube-system aws-load-balancer-controller
```

### 2\. Azure Cloud (AKS)

#### Recommended: Use Helper Scripts

The easiest way to deploy Ingext on Azure AKS is using the helper scripts in the `ingext-aks-helper` directory. These scripts automate the entire process and include preflight checks, installation, status monitoring, and cleanup.

> **Important:** The `install-ingext-aks.sh` script covers the complete installation process, including:
> * AKS cluster creation
> * All dependencies (Redis, OpenSearch, VictoriaMetrics, etcd) - see [Core Installation](#1-core-installation) section below
> * Application deployment (configuration, initialization, main services)
> * Ingress and TLS setup (cert-manager, certificate issuer, Application Gateway ingress)
>
> If you use the helper scripts, you can skip the [Core Installation](#1-core-installation) and [Ingress & Cloud Configuration](#2-ingress--cloud-configuration) sections below and proceed directly to [Step 3: Login to the management console](#3-login-to-the-management-console-https-sitedomain) after configuring DNS.

**Prerequisites:**
* **Docker** installed and running
* **Azure subscription** with billing enabled
* **DNS control** for a domain (for ingress and TLS)

**Quick Start:**

```bash
# 1. Launch the Docker container (includes all tools: az, kubectl, helm)
./ingext-shell.sh

# 2. Navigate to helper scripts
cd /workspace/ingext-aks-helper

# 3. Run preflight wizard (interactive setup and prerequisite checking)
chmod +x preflight-azure.sh
./preflight-azure.sh

# 4. Install Ingext (uses settings from preflight)
source ./ingext-aks.env
./install-ingext-aks.sh

# 5. Check installation status
./status-ingext-aks.sh --namespace ingext

# 6. Configure DNS
./dns-ingext-aks.sh --domain <your-domain>
```

For detailed instructions, see [HOWTO-AZURE.md](ingext-aks-helper/HOWTO-AZURE.md) or the [ingext-aks-helper README](ingext-aks-helper/README.md).

#### Manual Installation (Alternative)

If you prefer to install manually without the helper scripts:

```bash
# Login to Azure
az login

# Create Resource Group
az group create --name my-test-rg --location eastus

# Create AKS Cluster with App Gateway enabled
az aks create \
  --resource-group my-test-rg \
  --name my-test-cluster --location eastus \
  --node-count 2 \
  --generate-ssh-keys \
  --network-plugin azure \
  --enable-addons ingress-appgw \
  --appgw-name my-test-agw \
  --appgw-subnet-cidr "10.225.0.0/16"

# Get Credentials
az aks get-credentials --resource-group my-test-rg --name my-test-cluster
```

-----

## 1\. Core Installation

These steps are required regardless of your cloud provider. They install the necessary dependencies, databases, and the core application.

### Create Namespace

First, ensure you are working in the `ingext` namespace (or the namespace of your choice).

```bash
kubectl create namespace ingext
```

### Install Dependencies

Deploy the technology stack (Redis, OpenSearch, VictoriaMetrics) and the single-node etcd cluster.

```bash
# Install dependencies: Redis, OpenSearch, VictoriaMetrics
helm install ingext-stack oci://public.ecr.aws/ingext/ingext-stack -n ingext

# Install etcd single node
helm install etcd-single oci://public.ecr.aws/ingext/etcd-single -n ingext

# Install etcd defrag cronjob (maintenance)
helm install etcd-single-cronjob oci://public.ecr.aws/ingext/etcd-single-cronjob -n ingext
```

### Check pod status

Make sure all pods are "running" and ready

```bash
$ kubectl get pods -n ingext

# expected output
NAME                          READY   STATUS    RESTARTS   AGE
etcd-0                        1/1     Running   0          53s
ingext-stack-redis-master-0   1/1     Running   0          62s
opensearch-master-0           1/1     Running   0          62s
vmsingle-0                    1/1     Running   0          62s
```

### Configure and Deploy Application

Deploy the configuration, initialization jobs, and the main application logic.

> **Note:** Replace `ingext.k8.ingext.io` with your actual domain name.

```bash
# Install configuration
helm install ingext-community-config oci://public.ecr.aws/ingext/ingext-community-config \
  -n ingext \
  --set siteDomain=ingext.k8.ingext.io

# Run initialization jobs
helm install ingext-community-init oci://public.ecr.aws/ingext/ingext-community-init -n ingext

# Install the main application
helm install ingext-community oci://public.ecr.aws/ingext/ingext-community -n ingext
```

### Check service logs

```bash
# view api service logs
kubectl logs -n ingext -f ingext-api-0
# view platform service logs
kubectl logs -n ingext -f ingext-platform-0
```

-----

## 2\. Ingress & Cloud Configuration

Choose the instruction set below that matches your cloud provider to expose your application.

### Option A: AWS EKS

Use this option if you are running on Amazon Elastic Kubernetes Service.

**Requirements:**

* You must have a valid ACM Certificate ARN.

<!-- end list -->

```bash
helm install ingext-community-ingress-aws oci://public.ecr.aws/ingext/ingext-community-ingress-aws \
  -n ingext \
  --set siteDomain=ingext.k8.ingext.io \
  --set certArn="arn:aws:acm:us-east-1:YOUR_ACCOUNT_ID:certificate/YOUR_CERT_ID" \
  --set loadBalancerName="alb-ingext-community-ingress"
```

#### Setup DNS

```bash
kubectl get ingress  -n ingext
```

Setup one DNS CNAME from the site domain to the DNS name of the load balancer.

### Option B: Azure Cloud (AKS)

> **Note:** If you used the helper scripts (`install-ingext-aks.sh`), ingress and certificates are already configured. Skip to Step 3 to configure DNS.

#### Step 1: Install Cert Manager

Cert-manager is required for handling certificates on Azure.

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true
```

#### Step 2: Install Ingress & Cert Issuer

```bash
# Install Cert Issuer
helm install ingext-community-certissuer oci://public.ecr.aws/ingext/ingext-community-certissuer \
  -n ingext \
  --set email="<your-email-address>"

# Install Azure Ingress
helm install ingext-community-ingress-azure oci://public.ecr.aws/ingext/ingext-community-ingress-azure \
  -n ingext \
  --set siteDomain=ingext.k8.ingext.io
```

#### Step 3: Setup DNS

**Using Helper Scripts:**

```bash
# Get DNS instructions and verify status
cd /workspace/ingext-aks-helper
./dns-ingext-aks.sh --domain ingext.k8.ingext.io

# Wait for DNS to be configured (after creating the DNS record)
./dns-ingext-aks.sh --domain ingext.k8.ingext.io --wait
```

**Manual DNS Setup:**

```bash
# Get the ingress public IP
kubectl get ingress -n ingext
```

Setup one DNS A-record from the site domain to the public IP address associated with the gateway.

**Check the Challenge status:**

```bash
kubectl describe challenge -n ingext
# No resources found in ingext namespace (if the challenge is resolved successfully)
```

-----

## 3\. Login to the management console: https://{siteDomain}

user: <admin@ingext.io>
password: ingext

-----

## 4\. Cleanup resources after test

### AWS EKS

```bash
# remove eks cluster
eksctl delete cluster --name <cluster-name>
# remove the assocated dns record
```

### Azure AKS

#### Using Helper Scripts (Recommended)

If you used the helper scripts for installation, use the cleanup script:

```bash
# From inside the Docker container (./ingext-shell.sh)
cd /workspace/ingext-aks-helper

# Cleanup (automatically loads from ingext-aks.env if available)
./cleanup-ingext-aks.sh

# Or with explicit arguments
./cleanup-ingext-aks.sh \
  --resource-group <resource-group> \
  --cluster-name <cluster-name>
```

#### Manual Cleanup

```bash
# remove the cluster
az aks delete --resource-group <resource-group> --name <cluster-name>
# remove the resource group
az group delete --name <resource-group>
# remove the associated dns record
```

-----

## Support

If you encounter issues during installation, please open an issue in this repository.
