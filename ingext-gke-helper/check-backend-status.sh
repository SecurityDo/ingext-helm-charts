#!/usr/bin/env bash

set -uo pipefail

###############################################################################
# Check Backend Status - Detailed Diagnosis
#
# Provides detailed information about why the API backend isn't healthy
#
# Usage:
#   ./check-backend-status.sh [--namespace ingext]
###############################################################################

NAMESPACE="${NAMESPACE:-ingext}"

echo ""
echo "=========================================="
echo "Backend Status Diagnosis"
echo "=========================================="
echo ""

# Check ingress backends
echo "=== Ingress Backends ==="
kubectl describe ingress ingext-ingress -n "$NAMESPACE" | grep -A 20 "Backends:" || echo "No backends found"

echo ""
echo "=== BackendConfig Details ==="
kubectl get backendconfig api-backend-config -n "$NAMESPACE" -o yaml | grep -A 15 "healthCheck:" || echo "BackendConfig not found"

echo ""
echo "=== API Service Annotations ==="
kubectl get service api -n "$NAMESPACE" -o yaml | grep -A 5 "annotations:" || echo "No annotations"

echo ""
echo "=== Recent Ingress Events ==="
kubectl get events -n "$NAMESPACE" --field-selector involvedObject.name=ingext-ingress --sort-by='.lastTimestamp' | tail -10

echo ""
echo "=== GCP Load Balancer Status (if accessible) ==="
echo "Check in GCP Console:"
echo "  Network Services > Load Balancing > Find the load balancer for $NAMESPACE"
echo "  Look at Backend Services > Check health status of API backend"

echo ""
echo "=== Health Check Test ==="
echo "Testing if API responds to health check path:"
API_POD=$(kubectl get pods -n "$NAMESPACE" -l "ingext.io/app=api" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
if [[ -n "$API_POD" ]]; then
  echo "Testing GET /api on API pod..."
  kubectl exec -n "$NAMESPACE" "$API_POD" -- curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:8002/api 2>/dev/null || echo "Cannot test (curl not available in pod)"
else
  echo "API pod not found"
fi

echo ""
echo "=== Recommendations ==="
echo "If API backend is still not healthy:"
echo "  1. The health check path /api might not return 200 OK"
echo "  2. Try removing BackendConfig and let GKE use default health checks"
echo "  3. Or find the correct health check endpoint for the API"
echo "  4. Wait 15-20 minutes for GKE to fully process the changes"


