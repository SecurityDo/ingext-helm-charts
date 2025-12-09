# ingext-community

Welcome to the **ingext-community** repository. This project provides the Helm charts and configuration necessary to deploy the Ingext application on Kubernetes.

## Prerequisites

Before deploying, ensure you have the following installed and configured:

  * **Kubernetes Cluster:** A running cluster (AWS EKS, Azure AKS, or similar).
  * **Helm 3+:** Installed and configured on your local machine.
  * **kubectl:** Configured to communicate with your cluster.
  * **Cloud CLI:** (Optional) AWS CLI or Azure CLI if deploying to specific clouds.

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

Use this option to set up a new AKS cluster with App Gateway and install the necessary ingress controllers.

#### Step 1: Create Cluster & Gateway

```bash
# Login to Azure
az login

# Create Resource Group
az group create --name my-test-rg --location eastus

# Create AKS Cluster with App Gateway enabled
az aks create \
  --resource-group my-test-rg \
  --name my-test-cluster \
  --node-count 2 \
  --generate-ssh-keys \
  --network-plugin azure \
  --enable-addons ingress-appgw \
  --appgw-name my-test-agw \
  --appgw-subnet-cidr "10.225.0.0/16"

# Get Credentials
az aks get-credentials --resource-group my-test-rg --name my-test-cluster
```

#### Step 2: Install Cert Manager

Cert-manager is required for handling certificates on Azure.

```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update

helm install cert-manager jetstack/cert-manager \
  --namespace cert-manager \
  --create-namespace \
  --set installCRDs=true
```

#### Step 3: Install Ingress & Cert Issuer

```bash
# Install Cert Issuer
helm install ingext-community-certissuer oci://public.ecr.aws/ingext/ingext-community-certissuer -n ingext

# Install Azure Ingress
helm install ingext-community-ingress-azure oci://public.ecr.aws/ingext/ingext-community-ingress-azure \
  -n ingext \
  --set siteDomain=ingext.k8.ingext.io
```

#### Step 4: Setup DNS

```bash
kubectl get ingress  -n ingext
```

Setup one DNS A-record from the site domain to the public IP address associated with the gateway.

-----

## 3\. Login to the management console: https://{siteDomain}

user: <admin@ingext.io>
password: ingext

-----

## Support

If you encounter issues during installation, please open an issue in this repository.
