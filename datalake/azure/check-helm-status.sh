#!/bin/bash

# ==============================================================================
# Script Name: check-helm-status.sh
# Usage: ./check-helm-status.sh [namespace]
# Description: Checks the actual status of Helm releases and their pods
# ==============================================================================

NAMESPACE="${1:-${NAMESPACE:-ingext}}"

echo "=========================================================="
echo "🔍 Checking Helm Release Status vs Actual Pod Status"
echo "=========================================================="
echo "Namespace: $NAMESPACE"
echo ""

# Check Helm releases
echo "Helm Releases:"
echo "----------------------------------------"
helm list -n "$NAMESPACE" 2>/dev/null || echo "  No releases found or namespace doesn't exist"
echo ""

# Check pod status for each release
echo "Pod Status by Release:"
echo "----------------------------------------"

RELEASES=$(helm list -n "$NAMESPACE" -q 2>/dev/null || echo "")

if [ -z "$RELEASES" ]; then
    echo "  No Helm releases found"
else
    for release in $RELEASES; do
        echo ""
        echo "📦 Release: $release"
        
        # Get Helm status
        HELM_STATUS=$(helm status "$release" -n "$NAMESPACE" --show-resources 2>/dev/null | grep -i "STATUS:" | head -1 || echo "  Status: Unknown")
        echo "  $HELM_STATUS"
        
        # Find pods for this release
        # Try different label selectors
        PODS=$(kubectl get pods -n "$NAMESPACE" -l "app.kubernetes.io/instance=$release" -o wide 2>/dev/null || \
               kubectl get pods -n "$NAMESPACE" -l "release=$release" -o wide 2>/dev/null || \
               kubectl get pods -n "$NAMESPACE" | grep -i "$(echo "$release" | tr '[:upper:]' '[:lower:]' | tr '-' ' ')" || \
               echo "")
        
        if [ -n "$PODS" ] && [ "$(echo "$PODS" | wc -l)" -gt 1 ]; then
            echo "  Pods:"
            echo "$PODS" | tail -n +2 | while read -r line; do
                POD_NAME=$(echo "$line" | awk '{print $1}')
                POD_STATUS=$(echo "$line" | awk '{print $3}')
                POD_READY=$(echo "$line" | awk '{print $2}')
                POD_AGE=$(echo "$line" | awk '{print $5}')
                
                if [ "$POD_STATUS" != "Running" ] || [ "$POD_READY" != "1/1" ]; then
                    echo "    ❌ $POD_NAME: $POD_STATUS ($POD_READY) - Age: $POD_AGE"
                    
                    # Show recent events for failed pods
                    if [ "$POD_STATUS" != "Running" ]; then
                        echo "      Recent events:"
                        kubectl get events -n "$NAMESPACE" --field-selector involvedObject.name="$POD_NAME" --sort-by='.lastTimestamp' 2>/dev/null | tail -3 | sed 's/^/        /' || true
                    fi
                else
                    echo "    ✅ $POD_NAME: $POD_STATUS ($POD_READY)"
                fi
            done
        else
            echo "  ⚠️  No pods found for this release"
        fi
    done
fi

echo ""
echo "=========================================================="
echo "Summary:"
echo "----------------------------------------"

# Count pods by status
TOTAL_PODS=$(kubectl get pods -n "$NAMESPACE" --no-headers 2>/dev/null | wc -l | tr -d ' ')
RUNNING_PODS=$(kubectl get pods -n "$NAMESPACE" --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l | tr -d ' ')
FAILED_PODS=$(kubectl get pods -n "$NAMESPACE" --field-selector=status.phase!=Running,status.phase!=Succeeded --no-headers 2>/dev/null | wc -l | tr -d ' ')

echo "Total Pods: $TOTAL_PODS"
echo "Running: $RUNNING_PODS"
echo "Not Running: $FAILED_PODS"

if [ "$FAILED_PODS" -gt 0 ]; then
    echo ""
    echo "⚠️  Warning: Some pods are not running!"
    echo "Helm may show 'Installed' but pods are not healthy."
    echo ""
    echo "To see details:"
    echo "  kubectl get pods -n $NAMESPACE"
    echo "  kubectl describe pod <pod-name> -n $NAMESPACE"
fi

echo "=========================================================="

