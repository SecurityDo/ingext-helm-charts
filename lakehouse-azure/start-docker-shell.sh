#!/bin/bash

###############################################################################
# Azure Lakehouse Docker Shell
#
# Launches a Docker container with all required tools (az, kubectl, helm)
# and mounts your Azure credentials and current workspace.
###############################################################################

IMAGE_NAME="public.ecr.aws/ingext/ingext-shell:latest"

# --- Pre-flight Checks ---
# Ensure required directories exist locally
mkdir -p "$HOME/.kube"
mkdir -p "$HOME/.azure"
mkdir -p "$HOME/.ssh"
mkdir -p "$HOME/.helm"

# Create a persistent bash history file
touch "$HOME/.ingext_lakehouse_history"

# Use absolute path for workspace mount
WORKSPACE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

echo "🚀 Launching Azure Lakehouse Toolbox..."
echo "Container: $IMAGE_NAME"
echo "Mounting Azure Config from: $HOME/.azure"

# Run the container
docker run -it --rm --pull always \
  -v "$WORKSPACE_ROOT:/workspace" \
  -v "$HOME/.kube:/root/.kube" \
  -v "$HOME/.azure:/root/.azure" \
  -v "$HOME/.helm:/root/.helm" \
  -v "$HOME/.ingext_lakehouse_history:/root/.bash_history" \
  -v "$HOME/.ssh:/root/.ssh:ro" \
  -w /workspace/lakehouse-azure \
  "$IMAGE_NAME"
