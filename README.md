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

Create one EKS cluster with eksctl
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

Save the cluster context for kubectl

```bash
aws eks update-kubeconfig --region us-east-1 --name ingext-test-cluster
```

Configure service account for the AWS load balancer controller:

```bash
eksctl utils associate-iam-oidc-provider \
    --profile your-aws-profile-name \
    --region us-east-1 \
    --cluster ingext-test-cluster \
    --approve

aws iam create-policy \
    --profile your-aws-profile-name \
    --policy-name AWSLoadBalancerControllerIAMPolicy \
    --policy-document file://iam_policy.json


eksctl create iamserviceaccount \
  --cluster=ingext-test-cluster \
  --namespace=kube-system \
  --name=aws-load-balancer-controller \
  --role-name "AmazonEKSLoadBalancerControllerRoleIngext" \
  --attach-policy-arn=arn:aws:iam::509304988160:policy/AWSLoadBalancerControllerIAMPolicy \
  --approve
```

Finally, install the controller into the kube-system namespace

```bash
# 1. Add the EKS Helm repo
helm repo add eks https://aws.github.io/eks-charts
helm repo update

# 2. Install the chart
helm install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system \
  --set clusterName=ingext-test-cluster \
  --set serviceAccount.create=false \
  --set serviceAccount.name=aws-load-balancer-controller
```

### 2\. Azure Cloud (AKS)

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

```bash
kubectl get ingress  -n ingext
```

Setup one DNS A-record from the site domain to the public IP address associated with the gateway.
Check the Challenge status:

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

```bash
# remove the cluster
az aks delete --resource-group <resource-group> --name <cluster-name>
# remove the resource group
az group delete --name <resource-group>
# remove the assocated dns record
```

-----

## Support

If you encounter issues during installation, please open an issue in this repository.
