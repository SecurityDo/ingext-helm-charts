#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# GCP API Status Checker
#
# Checks the status of required GCP APIs for GKE deployment.
#
# Usage:
#   ./check-apis.sh [--project PROJECT_ID]
###############################################################################

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing dependency: $1"
    exit 1
  }
}

need gcloud

PROJECT_ID="${PROJECT_ID:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT_ID="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: ./check-apis.sh [--project PROJECT_ID]"
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1"
      exit 1
      ;;
  esac
done

# Get current project if not specified
if [[ -z "$PROJECT_ID" ]]; then
  PROJECT_ID="$(gcloud config get-value project 2>/dev/null || echo "")"
  if [[ -z "$PROJECT_ID" ]]; then
    echo "ERROR: No project specified and no default project set."
    echo "Run: gcloud config set project PROJECT_ID"
    echo "Or: ./check-apis.sh --project PROJECT_ID"
    exit 1
  fi
fi

echo "GCP API Status for Project: $PROJECT_ID"
echo "========================================"
echo ""

# Check if project exists
if ! gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  echo "ERROR: Project '$PROJECT_ID' not found or not accessible."
  exit 1
fi

# Required APIs
APIS=(
  "container.googleapis.com:Google Kubernetes Engine API"
  "compute.googleapis.com:Compute Engine API"
  "cloudresourcemanager.googleapis.com:Cloud Resource Manager API"
)

ALL_ENABLED=1

for api_info in "${APIS[@]}"; do
  API_NAME="${api_info%%:*}"
  API_DESC="${api_info##*:}"
  
  echo -n "$API_DESC: "
  
  STATUS=$(gcloud services list --enabled --project="$PROJECT_ID" --filter="name:$API_NAME" --format="value(name)" 2>/dev/null || echo "")
  
  if [[ -n "$STATUS" ]]; then
    echo -e "\033[0;32mENABLED\033[0m"
  else
    echo -e "\033[0;33mNOT ENABLED\033[0m"
    ALL_ENABLED=0
  fi
done

echo ""

if [[ "$ALL_ENABLED" == "0" ]]; then
  echo "To enable required APIs:"
  echo "  gcloud services enable container.googleapis.com --project=$PROJECT_ID"
  echo "  gcloud services enable compute.googleapis.com --project=$PROJECT_ID"
  echo "  gcloud services enable cloudresourcemanager.googleapis.com --project=$PROJECT_ID"
  echo ""
  echo "Or enable all at once:"
  echo "  gcloud services enable container.googleapis.com compute.googleapis.com cloudresourcemanager.googleapis.com --project=$PROJECT_ID"
  echo ""
  echo "API enablement typically takes 1-2 minutes."
fi

