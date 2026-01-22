#!/bin/bash

# ==============================================================================
# Script: setup-role.sh
# Purpose: Unified entry point for Internal and External Role Setup.
# Usage: 
#   Internal: ./setup-role.sh internal <profile> <role_name> <policy>
#   External: ./setup-role.sh external <local_profile> <remote_profile> <role_name> <policy>
# ==============================================================================

set -e

MODE=$1
shift # Remove the mode from arguments list so we can pass "$@" to the sub-scripts

# Helper function to check if scripts exist and are executable
check_script() {
    if [ ! -x "$1" ]; then
        echo "Error: '$1' is missing or not executable."
        echo "Run: chmod +x $1"
        exit 1
    fi
}

case "$MODE" in
    internal)
        SCRIPT="./internal-role_setup.sh"
        check_script "$SCRIPT"
        # Expecting 3 arguments: profile, role, policy
        if [ "$#" -ne 3 ]; then
            echo "Usage: $0 internal <profile> <role_name> <policy_file_or_dash>"
            exit 1
        fi
        exec "$SCRIPT" "$@"
        ;;

    external)
        SCRIPT="./external-role_setup.sh"
        check_script "$SCRIPT"
        # Expecting 4 arguments: local_prof, remote_prof, role, policy
        if [ "$#" -ne 4 ]; then
            echo "Usage: $0 external <local_profile> <remote_profile> <role_name> <policy_file_or_dash>"
            exit 1
        fi
        exec "$SCRIPT" "$@"
        ;;

    *)
        echo "Usage: $0 {internal|external} [arguments...]"
        echo ""
        echo "  internal args: <profile> <role_name> <policy>"
        echo "  external args: <local_profile> <remote_profile> <role_name> <policy>"
        exit 1
        ;;
esac
