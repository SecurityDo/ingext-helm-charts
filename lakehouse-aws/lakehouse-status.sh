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
  local app_name="$1"
  local display_name="$2"
  local status=""

  # Try different common label patterns
  local labels=(
    "ingext.io/app=$app_name"
    "app=$app_name"
    "app.kubernetes.io/name=$app_name"
  )

  for label in "${labels[@]}"; do
    status=$(kubectl get pods -n "$NAMESPACE" -l "$label" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)
    if [[ -n "$status" ]]; then
      # Found it, now check readiness if it's running
      if [[ "$status" == "Running" ]]; then
        local ready=$(kubectl get pods -n "$NAMESPACE" -l "$label" -o jsonpath='{.items[0].status.containerStatuses[0].ready}' 2>/dev/null || echo "true")
        if [[ "$ready" == "false" ]]; then
          status="Starting (0/1)"
        fi
      fi
      break
    fi
  done

  if [[ -z "$status" ]]; then
    status="NOT DEPLOYED"
  fi

  printf "$FORMAT" "$display_name" "$status"
}

# 3. Component Status
echo ""
echo "[Core Services]"
check_pod_status "redis" "Redis (Cache)"
check_pod_status "opensearch" "OpenSearch (Search Index)"
check_pod_status "victoria-metrics-single" "VictoriaMetrics (TSDB)"
check_pod_status "etcd" "etcd (Key-Value Store)"

echo ""
echo "[Ingext Stream]"
check_pod_status "api" "API Service"
check_pod_status "platform" "Platform Service"
check_pod_status "fluency8" "Fluency Service"

echo ""
echo "[Ingext Datalake]"
check_pod_status "lake-mgr" "Lake Manager"
check_pod_status "search-service" "Lake Search"
check_pod_status "lake-worker" "Lake Worker"

echo ""
echo "[Networking]"
# Ingress Address
ALB_ADDR=$(kubectl get ingress -n "$NAMESPACE" -o jsonpath='{.items[0].status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "PROVISIONING...")
printf "$FORMAT" "AWS Load Balancer" "${ALB_ADDR:0:20}..."
printf "$FORMAT" "DNS Domain" "$SITE_DOMAIN"

echo "========================================================================"
echo ""

