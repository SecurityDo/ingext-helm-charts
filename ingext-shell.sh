#!/bin/bash

IMAGE_NAME="public.ecr.aws/ingext/ingext-shell:latest"

# --- Pre-flight Checks ---
# We create these folders locally first. 
# If we don't, Docker creates them as 'root' owned, which causes permission errors.
mkdir -p "$HOME/.kube"
mkdir -p "$HOME/.aws"
mkdir -p "$HOME/.azure"
mkdir -p "$HOME/.ssh"
mkdir -p "$HOME/.helm"

# 1. Create the history file if it doesn't exist
touch "$HOME/.ingext_shell_history"

# --- Run Container ---
echo "🚀 Launching Multi-Cloud Toolbox from: $IMAGE_NAME"

# Explanation of flags:
# -it: Interactive terminal
# --rm: Remove container automatically when you exit
# --pull always: Ensures the user always has the latest updates from ECR
# -v: Mount config directories (AWS, Azure, Kube, SSH)
docker run -it --rm --pull always \
  -v "$(pwd):/workspace" \
  -v "$HOME/.kube:/root/.kube" \
  -v "$HOME/.aws:/root/.aws" \
  -v "$HOME/.azure:/root/.azure" \
  -v "$HOME/.helm:/root/.helm" \
  -v "$HOME/.ingext_shell_history:/root/.bash_history" \
  -v "$HOME/.ssh:/root/.ssh:ro" \
  -w /workspace \
  "$IMAGE_NAME"
