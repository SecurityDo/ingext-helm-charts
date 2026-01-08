#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# AWS Lakehouse Installer (Integrated Stream + Datalake)
#
# Orchestrates the full lifecycle:
# 1. Foundation (EKS, VPC, StorageClass)
# 2. Storage (S3, IAM)
# 3. Compute (Karpenter)
# 4. Core Services (Redis, OpenSearch, etc.)
# 5. Application (Stream + Datalake)
# 6. Ingress (LBC, ALB)
###############################################################################

# -------- 1. Load Environment --------
if [[ ! -f "./lakehouse-aws.env" ]]; then
  echo "ERROR: lakehouse-aws.env not found. Run ./preflight-lakehouse.sh first."
  exit 1
fi

source ./lakehouse-aws.env
export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_DEFAULT_REGION="$AWS_REGION"

log() {
  echo ""
  echo "==> $*"
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing dependency: $1"
    exit 1
  }
}

for bin in aws eksctl kubectl helm; do
  need "$bin"
done

# -------- 2. Phase 1: Foundation (EKS) --------
log "Phase 1: Foundation - Checking/Creating EKS Cluster '$CLUSTER_NAME'..."
if ! eksctl get cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" >/dev/null 2>&1; then
  eksctl create cluster \
    --name "$CLUSTER_NAME" \
    --region "$AWS_REGION" \
    --version 1.34 \
    --nodegroup-name standard-workers \
    --node-type "$NODE_TYPE" \
    --nodes "$NODE_COUNT" \
    --managed
else
  log "Cluster '$CLUSTER_NAME' already exists. Skipping creation."
fi

aws eks update-kubeconfig --region "$AWS_REGION" --name "$CLUSTER_NAME"

log "Installing/Updating Foundation Add-ons..."
eksctl create addon --cluster "$CLUSTER_NAME" --name eks-pod-identity-agent --region "$AWS_REGION" 2>/dev/null || true

# EBS CSI Driver
eksctl create podidentityassociation \
  --cluster "$CLUSTER_NAME" \
  --namespace kube-system \
  --service-account-name ebs-csi-controller-sa \
  --role-name "AmazonEKS_EBS_CSI_DriverRole_$CLUSTER_NAME" \
  --permission-policy-arns arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy \
  --region "$AWS_REGION" 2>/dev/null || true

eksctl create addon --cluster "$CLUSTER_NAME" --name aws-ebs-csi-driver --region "$AWS_REGION" 2>/dev/null || true

# StorageClass
aws ecr-public get-login-password --region us-east-1 | helm registry login --username AWS --password-stdin public.ecr.aws
helm upgrade --install ingext-aws-gp3 oci://public.ecr.aws/ingext/ingext-aws-gp3 -n kube-system

# Mountpoint for S3 CSI
aws eks create-addon --cluster-name "$CLUSTER_NAME" --addon-name aws-mountpoint-s3-csi-driver --region "$AWS_REGION" 2>/dev/null || true

# -------- 3. Phase 2: Storage (S3 & IAM) --------
log "Phase 2: Storage - Checking S3 Bucket '$S3_BUCKET'..."
if ! aws s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
  if [[ "$AWS_REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION"
  else
    aws s3api create-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" \
      --create-bucket-configuration LocationConstraint="$AWS_REGION"
  fi
else
  log "Bucket '$S3_BUCKET' already exists."
fi

log "Configuring IAM Service Account for Ingext Application..."
IAM_ROLE_NAME="ingext_${NAMESPACE}-sa"
IAM_POLICY_NAME="ingext_${NAMESPACE}-sa_S3_Policy"

cat <<EOT > s3_policy.json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["s3:ListBucket"],
            "Resource": "arn:aws:s3:::${S3_BUCKET}"
        },
        {
            "Effect": "Allow",
            "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
            "Resource": "arn:aws:s3:::${S3_BUCKET}/*"
        }
    ]
}
EOT

POLICY_ARN=$(aws iam create-policy --policy-name "$IAM_POLICY_NAME" --policy-document file://s3_policy.json --query 'Policy.Arn' --output text 2>/dev/null || aws iam list-policies --query "Policies[?PolicyName=='$IAM_POLICY_NAME'].Arn" --output text)
rm s3_policy.json

eksctl create podidentityassociation \
  --cluster "$CLUSTER_NAME" \
  --namespace "$NAMESPACE" \
  --service-account-name "${NAMESPACE}-sa" \
  --role-name "$IAM_ROLE_NAME" \
  --permission-policy-arns "$POLICY_ARN" \
  --region "$AWS_REGION" 2>/dev/null || true

# -------- 4. Phase 3: Compute (Karpenter) --------
log "Phase 3: Compute - Setting up Karpenter..."
# Use the existing script logic for Karpenter but integrated
# (Simplifying for this installer)
../datalake/aws/setup_karpenter.sh "$AWS_PROFILE" "$AWS_REGION" "$CLUSTER_NAME"

# -------- 5. Phase 4: Core Services --------
log "Phase 4: Core Services - Installing Stack..."
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install ingext-stack oci://public.ecr.aws/ingext/ingext-stack -n "$NAMESPACE"
helm upgrade --install etcd-single oci://public.ecr.aws/ingext/etcd-single -n "$NAMESPACE"
helm upgrade --install etcd-single-cronjob oci://public.ecr.aws/ingext/etcd-single-cronjob -n "$NAMESPACE"

# -------- 6. Phase 5: Application (Stream) --------
log "Phase 5: Application - Installing Ingext Stream..."
helm upgrade --install ingext-community-config oci://public.ecr.aws/ingext/ingext-community-config \
  -n "$NAMESPACE" --set "siteDomain=$SITE_DOMAIN"

helm upgrade --install ingext-community-init oci://public.ecr.aws/ingext/ingext-community-init -n "$NAMESPACE"
helm upgrade --install ingext-community oci://public.ecr.aws/ingext/ingext-community -n "$NAMESPACE"

# -------- 7. Phase 6: Application (Datalake) --------
log "Phase 6: Application - Installing Ingext Datalake..."
helm upgrade --install ingext-lake-config oci://public.ecr.aws/ingext/ingext-lake-config -n "$NAMESPACE" \
  --set storageType=s3 --set s3.bucket="$S3_BUCKET" --set s3.region="$AWS_REGION"

# Node Pools via Karpenter (via EKS-Pool chart)
helm upgrade --install ingext-merge-pool oci://public.ecr.aws/ingext/ingext-eks-pool \
  --set poolName=pool-merge --set clusterName="$CLUSTER_NAME"

helm upgrade --install ingext-search-pool oci://public.ecr.aws/ingext/ingext-eks-pool \
  --set poolName=pool-search --set clusterName="$CLUSTER_NAME" --set cpuLimit=128 --set memoryLimit=512Gi

helm upgrade --install ingext-manager-role oci://public.ecr.aws/ingext/ingext-manager-role -n "$NAMESPACE"
helm upgrade --install ingext-s3-lake oci://public.ecr.aws/ingext/ingext-s3-lake -n "$NAMESPACE" \
  --set bucket.name="$S3_BUCKET" --set bucket.region="$AWS_REGION"

helm upgrade --install ingext-lake oci://public.ecr.aws/ingext/ingext-lake -n "$NAMESPACE"

# -------- 8. Phase 7: Ingress --------
log "Phase 7: Ingress - Setting up AWS Load Balancer Controller..."
# IAM Policy for LBC
curl -sO https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/main/docs/install/iam_policy.json
LBC_POLICY_NAME="AWSLoadBalancerControllerIAMPolicy_$CLUSTER_NAME"
LBC_POLICY_ARN=$(aws iam create-policy --policy-name "$LBC_POLICY_NAME" --policy-document file://iam_policy.json --query 'Policy.Arn' --output text 2>/dev/null || aws iam list-policies --query "Policies[?PolicyName=='$LBC_POLICY_NAME'].Arn" --output text)
rm iam_policy.json

eksctl create podidentityassociation \
  --cluster "$CLUSTER_NAME" \
  --namespace kube-system \
  --service-account-name aws-load-balancer-controller \
  --role-name "AWSLoadBalancerControllerRole_$CLUSTER_NAME" \
  --permission-policy-arns "$LBC_POLICY_ARN" \
  --region "$AWS_REGION" 2>/dev/null || true

helm repo add eks https://aws.github.io/eks-charts && helm repo update
VPC_ID=$(aws eks describe-cluster --name "$CLUSTER_NAME" --region "$AWS_REGION" --query "cluster.resourcesVpcConfig.vpcId" --output text)

helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
  -n kube-system --set clusterName="$CLUSTER_NAME" --set region="$AWS_REGION" --set vpcId="$VPC_ID" \
  --set serviceAccount.create=true --set serviceAccount.name=aws-load-balancer-controller

log "Waiting for AWS Load Balancer Controller to be ready..."
kubectl rollout status deployment/aws-load-balancer-controller -n kube-system --timeout=120s

log "Installing AWS Ingress..."
# Assuming a local or oci chart for AWS ingress
# This depends on how the ingext-community-ingress-aws is managed
helm upgrade --install ingext-ingress oci://public.ecr.aws/ingext/ingext-community-ingress-aws \
  -n "$NAMESPACE" --set "siteDomain=$SITE_DOMAIN"

log "========================================================"
log "✅ Lakehouse Installation Complete!"
log "========================================================"
echo "Next step: Configure your DNS A-record or CNAME to the ALB DNS name."
kubectl get ingress -n "$NAMESPACE"

