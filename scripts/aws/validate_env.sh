#!/bin/bash

# ==============================================================================
# Script: validate_env.sh
# Purpose: Pre-flight check for AWS CLI, ingext tool, permissions, and profiles.
# Usage:   ./validate_env.sh [profile1] [profile2] ...
# Example: ./validate_env.sh ingext-prod customer-dev
# ==============================================================================

# Colors for easier reading
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "--- Starting Environment Validation ---"

# 1. CHECK TOOLS
# ------------------------------------------------------------------------------
TOOLS=("aws" "ingext" "jq") # jq is optional but recommended, strictly we check aws/ingext

for tool in "${TOOLS[@]}"; do
    if ! command -v "$tool" &> /dev/null; then
        echo -e "[${RED}FAIL${NC}] Tool '$tool' is NOT found in PATH."
        if [ "$tool" == "aws" ]; then echo "       Please install AWS CLI v2."; fi
        if [ "$tool" == "ingext" ]; then echo "       Please ensure 'ingext' binary is in your PATH."; fi
        exit 1
    else
        echo -e "[${GREEN}OK${NC}]   Tool '$tool' found: $(which $tool)"
    fi
done

# 2. CHECK SCRIPT PERMISSIONS
# ------------------------------------------------------------------------------
SCRIPTS=("external-role_setup.sh" "internal-role_setup.sh" "setup-role.sh")

echo "--- Checking Script Permissions ---"
for script in "${SCRIPTS[@]}"; do
    if [ -f "$script" ]; then
        if [ -x "$script" ]; then
            echo -e "[${GREEN}OK${NC}]   Script '$script' is executable."
        else
            echo -e "[${YELLOW}WARN${NC}] Script '$script' exists but is NOT executable."
            echo "       Fixing permissions..."
            chmod +x "$script"
            echo -e "[${GREEN}FIXED${NC}] Permissions updated."
        fi
    else
        echo -e "[${YELLOW}SKIP${NC}] Script '$script' not found in current directory (skipping)."
    fi
done

# 3. CHECK AWS PROFILES
# ------------------------------------------------------------------------------
echo "--- Checking AWS Profiles ---"

if [ "$#" -eq 0 ]; then
    echo -e "[${YELLOW}INFO${NC}] No profiles provided to check."
    echo "       Usage: $0 <profile_name_1> <profile_name_2> ..."
else
    # Get list of configured profiles
    CONFIGURED_PROFILES=$(aws configure list-profiles)

    for profile in "$@"; do
        if echo "$CONFIGURED_PROFILES" | grep -qx "$profile"; then
            # Valid profile name, now check if it has valid credentials
            echo -n "       Checking connectivity for '$profile'... "
            if aws sts get-caller-identity --profile "$profile" > /dev/null 2>&1; then
                echo -e "[${GREEN}OK${NC}] Valid & Active."
            else
                echo -e "[${RED}FAIL${NC}] Profile exists but credentials failed (Session expired?)."
            fi
        else
            echo -e "[${RED}FAIL${NC}] Profile '$profile' is NOT configured in ~/.aws/config or credentials."
        fi
    done
fi

echo "--- Validation Complete ---"
