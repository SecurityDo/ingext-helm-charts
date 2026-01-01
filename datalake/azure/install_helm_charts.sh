#!/bin/bash

# ==============================================================================
# Script Name: install_helm_charts.sh
# Usage: ./install_helm_charts.sh [namespace] [storageAccountName] [location]
# Description: Installs all Ingext datalake Helm charts for Azure
# ==============================================================================

# Track failures but continue installing all charts
set +e
FAILED_CHARTS=()
SUCCESS_CHARTS=()

# Use environment variables if set, otherwise use command-line arguments
# Command-line arguments override environment variables
NAMESPACE="${1:-${NAMESPACE}}"
STORAGE_ACCOUNT_NAME="${2:-${STORAGE_ACCOUNT_NAME}}"
LOCATION="${3:-${LOCATION}}"

# Helm chart registry
HELM_REGISTRY="oci://public.ecr.aws/ingext"

# Check if required variables are set
if [ -z "$NAMESPACE" ] || [ -z "$STORAGE_ACCOUNT_NAME" ] || [ -z "$LOCATION" ]; then
    echo "Usage: $0 [namespace] [storageAccountName] [location]"
    echo ""
    echo "Arguments are optional if environment variables are set:"
    echo "  NAMESPACE, STORAGE_ACCOUNT_NAME, LOCATION"
    echo ""
    echo "Examples:"
    echo "  # Using environment variables (from preflight):"
    echo "  source ./ingext-datalake-azure.env"
    echo "  $0"
    echo ""
    echo "  # Using command-line arguments:"
    echo "  $0 ingext ingextdatalake eastus"
    exit 1
fi

echo "=== Installing Ingext Datalake Helm Charts ==="
echo "Namespace:         $NAMESPACE"
echo "Storage Account:   $STORAGE_ACCOUNT_NAME"
echo "Location:          $LOCATION"
echo ""

# Check prerequisites
echo "-> Checking prerequisites..."

# Check if Helm is installed
if ! command -v helm &> /dev/null; then
    echo "Error: Helm is not installed. Please install Helm v3+ first."
    echo "  https://helm.sh/docs/intro/install/"
    exit 1
fi

# Check if kubectl is installed
if ! command -v kubectl &> /dev/null; then
    echo "Error: kubectl is not installed. Please install kubectl first."
    echo "  https://kubernetes.io/docs/tasks/tools/"
    exit 1
fi

# Check if namespace exists
if ! kubectl get namespace "$NAMESPACE" >/dev/null 2>&1; then
    echo "Error: Namespace '$NAMESPACE' does not exist."
    echo "  Please create it first:"
    echo "    kubectl create namespace $NAMESPACE"
    exit 1
fi

# Check if we can connect to the cluster
if ! kubectl cluster-info >/dev/null 2>&1; then
    echo "Error: Cannot connect to Kubernetes cluster."
    echo "  Please ensure your kubeconfig is set up correctly."
    exit 1
fi

echo "   ✓ Prerequisites check passed"
echo ""

# Function to install or upgrade a Helm chart
install_chart() {
    local CHART_NAME=$1
    local RELEASE_NAME=$2
    shift 2
    local EXTRA_ARGS=("$@")
    
    # Use longer timeout for manager and worker charts (they may need node pools)
    local TIMEOUT="10m"
    if [[ "$RELEASE_NAME" == *"mgr"* ]] || [[ "$RELEASE_NAME" == *"worker"* ]] || [[ "$RELEASE_NAME" == *"search"* ]]; then
        TIMEOUT="15m"
    fi
    
    echo "-> Installing/Upgrading $RELEASE_NAME... (timeout: $TIMEOUT)"
    
    local ERROR_LOG=$(mktemp)
    if helm upgrade --install "$RELEASE_NAME" "$HELM_REGISTRY/$CHART_NAME" \
        --namespace "$NAMESPACE" \
        --wait \
        --timeout "$TIMEOUT" \
        "${EXTRA_ARGS[@]}" > "$ERROR_LOG" 2>&1; then
        echo "   ✓ $RELEASE_NAME installed/upgraded successfully"
        rm -f "$ERROR_LOG"
        SUCCESS_CHARTS+=("$RELEASE_NAME")
        return 0
    else
        local EXIT_CODE=$?
        echo "   ✗ FAILED to install/upgrade $RELEASE_NAME"
        if [ -f "$ERROR_LOG" ]; then
            echo "   Error details:"
            cat "$ERROR_LOG" | sed 's/^/     /'
            rm -f "$ERROR_LOG"
        fi
        
        # If timeout exceeded, check pod status
        if grep -q "context deadline exceeded\|timeout" "$ERROR_LOG" 2>/dev/null; then
            echo ""
            echo "   ⚠️  Timeout exceeded - checking pod status..."
            echo "   Pods in namespace $NAMESPACE:"
            kubectl get pods -n "$NAMESPACE" -l "app.kubernetes.io/instance=$RELEASE_NAME" 2>/dev/null || \
            kubectl get pods -n "$NAMESPACE" | grep -i "$(echo "$RELEASE_NAME" | tr '[:upper:]' '[:lower:]')" || \
            echo "     (No pods found for this release)"
            echo ""
            echo "   Common causes:"
            echo "     - Pods waiting for node pools (check: kubectl get nodes)"
            echo "     - Image pull issues (check: kubectl describe pod -n $NAMESPACE <pod-name>)"
            echo "     - Resource constraints (check: kubectl top nodes)"
            echo ""
            echo "   To check pod events:"
            echo "     kubectl get events -n $NAMESPACE --sort-by='.lastTimestamp' | tail -20"
        fi
        
        FAILED_CHARTS+=("$RELEASE_NAME")
        return $EXIT_CODE
    fi
}

# 1. Install ingext-lake-config (storage configuration)
echo "========================================================"
install_chart "ingext-lake-config" "ingext-lake-config" \
    --set storageType=blob \
    --set blob.storageAccount="$STORAGE_ACCOUNT_NAME"

# 2. Install ingext-manager-role
echo ""
echo "========================================================"
install_chart "ingext-manager-role" "ingext-manager-role"

# 3. Install ingext-s3-lake (S3/Blob lake integration)
# NOTE: This chart uses AWS S3 CSI driver which doesn't work on Azure
# For Azure, blob storage access is handled via managed identity/service account
# Skipping this chart for Azure deployments
echo ""
echo "========================================================"
echo "-> Skipping ingext-s3-lake (AWS S3 CSI driver not available on Azure)"
echo "   Azure Blob Storage access is handled via Managed Identity"
echo "   (configured in setup_ingext_serviceaccount.sh)"
echo "========================================================"

# 4. Install ingext-lake-mgr (Lake manager)
echo ""
echo "========================================================"
install_chart "ingext-lake-mgr" "ingext-lake-mgr"

# 5. Install ingext-lake-worker (Lake workers)
echo ""
echo "========================================================"
install_chart "ingext-lake-worker" "ingext-lake-worker"

# 6. Install ingext-search-service
echo ""
echo "========================================================"
install_chart "ingext-search-service" "ingext-search-service"

# Summary
echo ""
echo "========================================================"
if [ ${#FAILED_CHARTS[@]} -eq 0 ]; then
    echo "✅ Helm Charts Installation Complete!"
    echo "========================================================"
    echo "All charts installed successfully!"
else
    echo "⚠️  Helm Charts Installation Completed with Errors"
    echo "========================================================"
    echo ""
    echo "✅ Successfully installed (${#SUCCESS_CHARTS[@]}):"
    for chart in "${SUCCESS_CHARTS[@]}"; do
        echo "   - $chart"
    done
    echo ""
    echo "❌ Failed to install (${#FAILED_CHARTS[@]}):"
    for chart in "${FAILED_CHARTS[@]}"; do
        echo "   - $chart"
    done
    echo ""
    echo "To retry failed charts, run:"
    for chart in "${FAILED_CHARTS[@]}"; do
        echo "   helm upgrade --install $chart $HELM_REGISTRY/$chart -n $NAMESPACE --wait --timeout 5m"
    done
fi
echo ""
echo "Namespace: $NAMESPACE"
echo ""
echo "To check status:"
echo "  helm list -n $NAMESPACE"
echo "  kubectl get pods -n $NAMESPACE"
echo "  ./install-status-check.sh"
echo "========================================================"

# Exit with error code if any charts failed
if [ ${#FAILED_CHARTS[@]} -gt 0 ]; then
    exit 1
fi

