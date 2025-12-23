#!/usr/bin/env bash

set -uo pipefail

###############################################################################
# Try Default GKE Health Checks
#
# Removes BackendConfig to let GKE use default health checks.
# This is a workaround if the custom health check path isn't working.
#
# Usage:
#   ./try-default-health-check.sh [--namespace ingext]
###############################################################################

NAMESPACE="${NAMESPACE:-ingext}"

echo ""
echo "=========================================="
echo "Try Default GKE Health Checks"
echo "=========================================="
echo ""
echo "This will:"
echo "  1. Remove BackendConfig annotation from API service"
echo "  2. Delete the BackendConfig resource"
echo "  3. Let GKE use default health checks (which might work better)"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled"
  exit 0
fi

echo ""
echo "Removing BackendConfig annotation from API service..."
kubectl annotate service api -n "$NAMESPACE" cloud.google.com/backend-config- 2>/dev/null || true

echo "Deleting BackendConfig..."
kubectl delete backendconfig api-backend-config -n "$NAMESPACE" 2>/dev/null || true

echo ""
echo "✓ BackendConfig removed"
echo ""
echo "GKE will now use default health checks:"
echo "  - HTTP GET on the service port (8002)"
echo "  - Default path: /"
echo "  - Default intervals and thresholds"
echo ""
echo "Wait 10-15 minutes for GKE to:"
echo "  - Remove the custom health check"
echo "  - Create default health check"
echo "  - Mark backend as healthy (if it responds)"
echo ""
echo "Then check status:"
echo "  ./test-all.sh --domain gcp.k8.ingext.io"
echo "  kubectl describe ingress ingext-ingress -n $NAMESPACE | grep -A 10 'Backends:'"
echo ""

