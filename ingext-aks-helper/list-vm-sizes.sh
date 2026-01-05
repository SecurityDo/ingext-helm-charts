#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# AKS-Compatible VM Size Helper
#
# Lists VM sizes available in a region, filtered to show AKS-compatible sizes
# in a readable format.
#
# Usage:
#   ./list-vm-sizes.sh [--location eastus] [--all]
###############################################################################

print_help() {
  cat <<EOF
AKS-Compatible VM Size Helper

Usage:
  ./list-vm-sizes.sh [options]

Options:
  --location <region>    Azure region (default: eastus)
  --all                  Show all VM sizes (not filtered)
  --help                 Show this help message

Examples:
  ./list-vm-sizes.sh
  ./list-vm-sizes.sh --location westus2
  ./list-vm-sizes.sh --all
EOF
}

LOCATION="${LOCATION:-eastus}"
SHOW_ALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --location)
      LOCATION="$2"
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

need az

echo "Available VM Sizes for AKS in region: $LOCATION"
echo "================================================"
echo ""

# Get VM sizes
if [[ "$SHOW_ALL" == "1" ]]; then
  az vm list-sizes --location "$LOCATION" --output table 2>/dev/null || {
    echo "ERROR: Could not list VM sizes. Check your Azure login and region."
    exit 1
  }
  exit 0
fi

# Get table output and filter to AKS-compatible sizes
TABLE_OUTPUT=$(az vm list-sizes --location "$LOCATION" --output table 2>/dev/null || {
  echo "ERROR: Could not list VM sizes. Check your Azure login and region."
  exit 1
})

# Filter to common AKS-compatible sizes (Standard_D* and Standard_B* series)
# Exclude specialized sizes (GPU, HPC, etc.)
FILTERED=$(echo "$TABLE_OUTPUT" | \
  grep -E "Standard_[DB][0-9]" | \
  grep -E "s_v[2345]|ds_v[2345]|ms_v[2345]|_v[2345]|as_v[2345]|a_v[2345]" | \
  grep -v -E "_nc|_nv|_hb|_hc|_hx|_fx|_l[0-9]" | \
  head -n 25 || true)

if [[ -z "$FILTERED" ]]; then
  echo "No filtered sizes found. Showing first 30 available sizes:"
  echo ""
  echo "$TABLE_OUTPUT" | head -n 32
  echo ""
  echo "... (truncated, use --all to see all sizes)"
  exit 0
fi

# Display filtered results
echo "Recommended VM Sizes for AKS:"
echo ""
echo "$FILTERED"
echo ""
echo "Recommendations:"
echo "  Small/AMD:      Standard_D2as_v5 (2 vCPU, 8GB)  - AMD EPYC (Recommended)"
echo "  Medium/AMD:     Standard_D4as_v5 (4 vCPU, 16GB) - AMD EPYC (Recommended)"
echo "  Large/AMD:      Standard_D8as_v5 (8 vCPU, 32GB) - AMD EPYC (Recommended)"
echo "  Intel/Conf:     Standard_DC2ds_v3 (2 vCPU, 8GB) - Intel with SGX"
echo ""
echo "Note: Available sizes depend on your subscription quota."
echo "If a size is not available, try Standard_B2s or Standard_B4ms for smaller options."
echo ""
echo "To see ALL available sizes:"
echo "  ./list-vm-sizes.sh --all"
echo ""
