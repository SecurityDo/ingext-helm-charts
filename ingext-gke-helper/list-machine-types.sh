#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# GKE-Compatible Machine Type Helper
#
# Lists machine types available in a region, filtered to show GKE-compatible types
# in a readable format.
#
# Usage:
#   ./list-machine-types.sh [--region us-east1] [--all]
###############################################################################

print_help() {
  cat <<EOF
GKE-Compatible Machine Type Helper

Usage:
  ./list-machine-types.sh [options]

Options:
  --region <region>    GCP region (default: us-east1)
  --all                Show all machine types (not filtered)
  --help               Show this help message

Examples:
  ./list-machine-types.sh
  ./list-machine-types.sh --region us-west1
  ./list-machine-types.sh --all
EOF
}

REGION="${REGION:-us-east1}"
SHOW_ALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)
      REGION="$2"
      shift 2
      ;;
    --all)
      SHOW_ALL=1
      shift
      ;;
    --help|-h)
      print_help
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1"
      print_help
      exit 1
      ;;
  esac
done

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing dependency: $1"
    exit 1
  }
}

need gcloud

# Get zone from region (use first zone in region)
ZONE="${REGION}-a"

echo "Available Machine Types for GKE in region: $REGION"
echo "=================================================="
echo ""

# Get machine types (must use --zones, not --regions)
if [[ "$SHOW_ALL" == "1" ]]; then
  gcloud compute machine-types list --zones="$ZONE" --format="table(name,guestCpus,memoryMb)" 2>&1 || {
    echo "ERROR: Could not list machine types. Check your GCP login, project, and zone."
    echo ""
    echo "Common issues:"
    echo "  - Compute Engine API not enabled"
    echo "  - Wrong project set: gcloud config get-value project"
    echo "  - Zone doesn't exist: try us-east1-a, us-east1-b, or us-east1-c"
    exit 1
  }
  exit 0
fi

# Get machine types and filter to GKE-compatible
TABLE_OUTPUT=$(gcloud compute machine-types list --zones="$ZONE" --format="table(name,guestCpus,memoryMb)" 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -ne 0 ]]; then
  echo "ERROR: Could not list machine types."
  echo ""
  echo "Error details:"
  echo "$TABLE_OUTPUT"
  echo ""
  echo "Common issues:"
  echo "  - Compute Engine API not enabled: gcloud services enable compute.googleapis.com"
  echo "  - Wrong project set: gcloud config get-value project"
  echo "  - Zone doesn't exist: try us-east1-a, us-east1-b, or us-east1-c"
  echo "  - Billing not enabled (required for API access)"
  exit 1
fi

# Filter to common GKE-compatible types (e2-standard, n1-standard, n2-standard series)
# Exclude specialized types (GPU, HPC, highmem, highcpu, etc.)
FILTERED=$(echo "$TABLE_OUTPUT" | \
  grep -E "^(NAME|e2-standard|n1-standard|n2-standard)" | \
  grep -v -E "(-gpu-|-highmem-|-highcpu-|a2-|c2-|m1-)" | \
  head -n 25 || true)

if [[ -z "$FILTERED" ]] || [[ "$FILTERED" == "NAME"* && $(echo "$FILTERED" | wc -l) -le 1 ]]; then
  echo "No filtered types found. Showing first 30 available types:"
  echo ""
  echo "$TABLE_OUTPUT" | head -n 32
  echo ""
  echo "... (truncated, use --all to see all types)"
  echo ""
  echo "Note: If you see types above, you can use any of them. Common GKE-compatible types:"
  echo "  - e2-standard-2, e2-standard-4, e2-standard-8"
  echo "  - n1-standard-2, n1-standard-4, n1-standard-8"
  exit 0
fi

# Display filtered results
echo "Recommended Machine Types for GKE:"
echo ""
echo "$FILTERED"
echo ""
echo "Recommendations:"
echo "  Small/Testing:  e2-standard-2   (2 vCPU, 8GB)  - Good for testing"
echo "  Medium:         e2-standard-4    (4 vCPU, 16GB) - Balanced (default)"
echo "  Large:          e2-standard-8   (8 vCPU, 32GB) - Production workloads"
echo ""
echo "Note: Available types depend on your project quota."
echo "e2-series are cost-optimized, n1-series are general-purpose."
echo ""
echo "To see ALL available types:"
echo "  ./list-machine-types.sh --all"
echo ""

