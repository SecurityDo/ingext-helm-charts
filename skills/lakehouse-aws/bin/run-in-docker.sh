#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-public.ecr.aws/ingext/ingext-shell:latest}"

# Optional: pass through an env file (like lakehouse-aws.env)
ENV_FILE="${ENV_FILE:-}"

# Workspace mount
WORKDIR="${WORKDIR:-/workspace}"

# Pre-flight: create local dirs so docker doesn't create them as root-owned
mkdir -p "$HOME/.kube" "$HOME/.aws" "$HOME/.config/gcloud" "$HOME/.azure" "$HOME/.ssh" "$HOME/.helm" "$HOME/.ingext"
touch "$HOME/.ingext_shell_history"

# Build docker args
DOCKER_ARGS=(run --rm --pull always --platform linux/amd64
  -v "$(pwd):/workspace"
  -v "$HOME/.kube:/root/.kube"
  -v "$HOME/.aws:/root/.aws"
  -v "$HOME/.config/gcloud:/root/.config/gcloud"
  -v "$HOME/.azure:/root/.azure"
  -v "$HOME/.helm:/root/.helm"
  -v "$HOME/.ingext:/root/.ingext"
  -v "$HOME/.ingext_shell_history:/root/.bash_history"
  -v "$HOME/.ssh:/root/.ssh:ro"
  -w "$WORKDIR"
)

# If env file provided and exists, pass it in
if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: ENV_FILE not found: $ENV_FILE" >&2
    exit 2
  fi
  DOCKER_ARGS+=(--env-file "$ENV_FILE")
fi

# Run the command
docker "${DOCKER_ARGS[@]}" "$IMAGE_NAME" "$@"