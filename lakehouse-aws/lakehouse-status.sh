#!/usr/bin/env bash

set -uo pipefail

###############################################################################
# Lakehouse Status Checker
#
# Shows the status of all installed components in a clean two-column format.
###############################################################################

# -------- 1. Load Environment --------
if [[ ! -f "./lakehouse-aws.env" ]]; then
  echo "ERROR: lakehouse-aws.env not found. Run ./preflight-lakehouse.sh first."
  exit 1
fi

source ./lakehouse-aws.env
export AWS_PROFILE="${AWS_PROFILE:-default}"
export AWS_DEFAULT_REGION="$AWS_REGION"

# Column formatting
FORMAT="%-40s %-20s\n"

echo ""
echo "==================== Lakehouse Status: $CLUSTER_NAME ===================="
printf "$FORMAT" "COMPONENT" "STATUS"
echo "------------------------------------------------------------------------"

# 1. Infrastructure Status
printf "$FORMAT" "EKS Cluster ($CLUSTER_NAME)" "$(aws eks describe-cluster --name "$CLUSTER_NAME" --query 'cluster.status' --output text 2>/dev/null || echo "NOT FOUND")"
printf "$FORMAT" "S3 Bucket ($S3_BUCKET)" "$(aws s3api head-bucket --bucket "$S3_BUCKET" 2>&1 >/dev/null && echo "EXISTS" || echo "NOT FOUND")"

# 2. Kubernetes Pods Status Helper
check_pod_status() {
  local label="$1"
  local name="$2"
  local status=$(kubectl get pods -n "$NAMESPACE" -l "$label" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || echo "NOT DEPLOYED")
  
  if [[ "$status" == "Running" ]]; then
    # Check if all containers in the pod are ready
    local ready=$(kubectl get pods -n "$NAMESPACE" -l "$label" -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null)
    if [[ "$ready" == "false" ]]; then
      status="Starting (0/1)"
    fi
  fi
  printf "$FORMAT" "$name" "$status"
}

# 3. Component Status
echo ""
echo "[Core Services]"
check_pod_status "app=redis" "Redis (Cache)"
check_pod_status "app=opensearch" "OpenSearch (Search Index)"
check_pod_status "app=victoria-metrics-single" "VictoriaMetrics (TSDB)"
check_pod_status "app=etcd" "etcd (Key-Value Store)"

echo ""
echo "[Ingext Stream]"
check_pod_status "app=api" "API Service"
check_pod_status "app=platform-service" "Platform Service"
check_pod_status "app=fluency8" "Fluency Service"

echo ""
echo "[Ingext Datalake]"
check_pod_status "app=ingext-lake-mgr" "Lake Manager"
check_pod_status "app=ingext-search-service" "Lake Search"
check_pod_status "app=ingext-lake-worker" "Lake Worker"

echo ""
echo "[Networking]"
# Ingress Address
ALB_ADDR=$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "PROVISIONING...")
printf "$FORMAT" "AWS Load Balancer" "${ALB_ADDR:0:20}..."
printf "$FORMAT" "DNS Domain" "$SITE_DOMAIN"

echo "========================================================================"
echo ""

