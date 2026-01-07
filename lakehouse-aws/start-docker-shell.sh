#!/bin/bash

###############################################################################
# AWS Lakehouse Docker Shell
#
# Launches a Docker container with all required tools (aws, eksctl, kubectl, helm)
# and mounts your AWS credentials and current workspace.
###############################################################################

IMAGE_NAME="public.ecr.aws/ingext/ingext-shell:latest"

# --- Pre-flight Checks ---
# Ensure required directories exist locally
mkdir -p "$HOME/.kube"
mkdir -p "$HOME/.aws"
mkdir -p "$HOME/.ssh"
mkdir -p "$HOME/.helm"

# Create a persistent bash history file
touch "$HOME/.ingext_lakehouse_history"

# Use absolute path for workspace mount
WORKSPACE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

echo "🚀 Launching AWS Lakehouse Toolbox..."
echo "Container: $IMAGE_NAME"
echo "Mounting AWS Config from: $HOME/.aws"

# Added -e AWS_... variables to pass host credentials if set
docker run -it --rm --pull always \
  -v "$WORKSPACE_ROOT:/workspace" \
  -v "$HOME/.kube:/root/.kube" \
  -v "$HOME/.aws:/root/.aws" \
  -v "$HOME/.helm:/root/.helm" \
  -v "$HOME/.ingext_lakehouse_history:/root/.bash_history" \
  -v "$HOME/.ssh:/root/.ssh:ro" \
  -e "AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:-}" \
  -e "AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:-}" \
  -e "AWS_SESSION_TOKEN=${AWS_SESSION_TOKEN:-}" \
  -w /workspace/lakehouse-aws \
  "$IMAGE_NAME"
