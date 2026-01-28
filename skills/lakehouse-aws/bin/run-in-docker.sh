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
# Use --pull missing instead of --pull always for better performance
# The image will be pulled once and reused for subsequent commands
DOCKER_ARGS=(run --rm --pull missing --platform linux/amd64
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

# Pass through AWS credentials if set
[[ -n "${AWS_PROFILE:-}" ]] && DOCKER_ARGS+=(-e "AWS_PROFILE=$AWS_PROFILE")
[[ -n "${AWS_REGION:-}" ]] && DOCKER_ARGS+=(-e "AWS_REGION=$AWS_REGION")
[[ -n "${AWS_DEFAULT_REGION:-}" ]] && DOCKER_ARGS+=(-e "AWS_DEFAULT_REGION=$AWS_DEFAULT_REGION")
[[ -n "${AWS_ACCESS_KEY_ID:-}" ]] && DOCKER_ARGS+=(-e "AWS_ACCESS_KEY_ID=$AWS_ACCESS_KEY_ID")
[[ -n "${AWS_SECRET_ACCESS_KEY:-}" ]] && DOCKER_ARGS+=(-e "AWS_SECRET_ACCESS_KEY=$AWS_SECRET_ACCESS_KEY")
[[ -n "${AWS_SESSION_TOKEN:-}" ]] && DOCKER_ARGS+=(-e "AWS_SESSION_TOKEN=$AWS_SESSION_TOKEN")

# If env file provided and exists, pass it in
if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ERROR: ENV_FILE not found: $ENV_FILE" >&2
    exit 2
  fi
  DOCKER_ARGS+=(--env-file "$ENV_FILE")
fi

# If eksctl command is being run, ensure it's installed first
if [[ "$1" == "eksctl" ]]; then
  # Wrap the command to install eksctl if missing, then run it
  docker "${DOCKER_ARGS[@]}" "$IMAGE_NAME" bash -c "
    # Check if eksctl exists, install if missing
    if ! command -v eksctl >/dev/null 2>&1; then
      echo '⏳ Installing eksctl in Docker container...' >&2
      ARCH=\$(uname -m | sed 's/x86_64/amd64/')
      PLATFORM=\$(uname -s | tr '[:upper:]' '[:lower:]')
      
      # Try latest release first, fallback to specific version
      if ! curl -sLf \"https://github.com/weaveworks/eksctl/releases/latest/download/eksctl_\${PLATFORM}_\${ARCH}.tar.gz\" -o /tmp/eksctl.tar.gz; then
        curl -sLf \"https://github.com/weaveworks/eksctl/releases/download/v0.177.0/eksctl_\${PLATFORM}_\${ARCH}.tar.gz\" -o /tmp/eksctl.tar.gz || {
          echo '❌ Failed to download eksctl' >&2
          exit 1
        }
      fi
      
      tar -xzf /tmp/eksctl.tar.gz -C /tmp 2>/dev/null || {
        echo '❌ Failed to extract eksctl' >&2
        exit 1
      }
      mv /tmp/eksctl /usr/local/bin/eksctl 2>/dev/null || cp /tmp/eksctl /usr/local/bin/eksctl
      chmod +x /usr/local/bin/eksctl
      rm -f /tmp/eksctl.tar.gz
      echo '✓ eksctl installed' >&2
    fi
    
    # Run the actual eksctl command
    exec eksctl \"\$@\"
  " -- "${@:2}"
else
  # Run the command normally for non-eksctl commands
  docker "${DOCKER_ARGS[@]}" "$IMAGE_NAME" "$@"
fi