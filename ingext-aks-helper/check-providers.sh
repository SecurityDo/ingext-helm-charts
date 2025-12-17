#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Quick Provider Registration Status Checker
#
# Checks the registration status of Microsoft.ContainerService and
# Microsoft.Network providers for the current Azure subscription.
#
# Usage:
#   ./check-providers.sh
###############################################################################

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing dependency: $1"
    exit 1
  }
}

need az

echo "Provider Registration Status"
echo "=========================="
echo ""

# Check if we have a valid subscription
if ! az account show >/dev/null 2>&1; then
  echo "ERROR: No subscription is set."
  echo "Run: az account set --subscription \"<name-or-id>\""
  exit 1
fi

SUB_NAME="$(az account show --query name -o tsv 2>/dev/null || echo "Unknown")"
SUB_ID="$(az account show --query id -o tsv 2>/dev/null || echo "Unknown")"

echo "Subscription: $SUB_NAME ($SUB_ID)"
echo ""

# Check ContainerService
echo -n "Microsoft.ContainerService: "
RP_AKS="$(az provider show -n Microsoft.ContainerService --query registrationState -o tsv 2>/dev/null || echo "ERROR")"
if [[ "$RP_AKS" == "Registered" ]]; then
  echo -e "\033[0;32m$RP_AKS\033[0m"
elif [[ "$RP_AKS" == "ERROR" ]]; then
  ERROR_MSG="$(az provider show -n Microsoft.ContainerService 2>&1 || true)"
  if echo "$ERROR_MSG" | grep -q "SubscriptionNotFound"; then
    echo -e "\033[0;31mERROR: Subscription not found\033[0m"
  else
    echo -e "\033[0;31mERROR: Cannot check status\033[0m"
  fi
else
  echo -e "\033[0;33m$RP_AKS\033[0m"
  echo "  To register: az provider register -n Microsoft.ContainerService"
fi

# Check Network
echo -n "Microsoft.Network:          "
RP_NET="$(az provider show -n Microsoft.Network --query registrationState -o tsv 2>/dev/null || echo "ERROR")"
if [[ "$RP_NET" == "Registered" ]]; then
  echo -e "\033[0;32m$RP_NET\033[0m"
elif [[ "$RP_NET" == "ERROR" ]]; then
  ERROR_MSG="$(az provider show -n Microsoft.Network 2>&1 || true)"
  if echo "$ERROR_MSG" | grep -q "SubscriptionNotFound"; then
    echo -e "\033[0;31mERROR: Subscription not found\033[0m"
  else
    echo -e "\033[0;31mERROR: Cannot check status\033[0m"
  fi
else
  echo -e "\033[0;33m$RP_NET\033[0m"
  echo "  To register: az provider register -n Microsoft.Network"
fi

echo ""

# Show registration commands if needed
if [[ "$RP_AKS" != "Registered" ]] || [[ "$RP_NET" != "Registered" ]]; then
  echo "To register providers:"
  if [[ "$RP_AKS" != "Registered" ]]; then
    echo "  az provider register -n Microsoft.ContainerService"
  fi
  if [[ "$RP_NET" != "Registered" ]]; then
    echo "  az provider register -n Microsoft.Network"
  fi
  echo ""
  echo "Registration can take 1-5 minutes. Check status again with:"
  echo "  ./check-providers.sh"
  echo ""
  echo "Or watch status continuously:"
  echo "  watch -n 5 ./check-providers.sh"
fi

