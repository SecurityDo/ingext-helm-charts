#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Preflight GCP Wizard for Ingext GKE installs
#
# - Asks questions interactively
# - Performs best-effort checks (gcloud auth, API enablement, quotas snapshot, DNS resolution status)
# - Writes an env file you can source before running install-ingext-gke.sh
#
# Usage:
#   ./preflight-gcp.sh
#   OUTPUT_ENV=./my.env ./preflight-gcp.sh
###############################################################################

OUTPUT_ENV="${OUTPUT_ENV:-./ingext-gke.env}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing dependency: $1"
    echo "💡 TIP: Run '../ingext-gcp-shell.sh' from the root to launch a pre-configured toolbox with all dependencies installed."
    exit 1
  }
}

print_help() {
  cat <<EOF
Preflight GCP Wizard (Ingext GKE)

Usage:
  ./preflight-gcp.sh
  OUTPUT_ENV=./my.env ./preflight-gcp.sh

What it does:
  - Prompts you for GCP + DNS + install settings
  - Runs basic checks using gcloud CLI (best effort)
  - Writes environment variables to an env file (default: ./ingext-gke.env)

Next step:
  source ./ingext-gke.env
  ./install-ingext-gke.sh --project "\$PROJECT_ID" --region "\$REGION" --cluster-name "\$CLUSTER_NAME" --domain "\$SITE_DOMAIN" --email "\$CERT_EMAIL"

EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_help
  exit 0
fi

need gcloud

# Helper functions for colored output
color_green() {
  echo -e "\033[0;32m${*}\033[0m"
}

color_red() {
  echo -e "\033[0;31m${*}\033[0m"
}

color_yellow() {
  echo -e "\033[0;33m${*}\033[0m"
}

echo ""
echo "================ Preflight GCP (Interactive) ================"
echo ""

# 1) GCP login status and project selection
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" >/dev/null 2>&1; then
  echo "You are not logged into GCP yet."
  echo "Opening GCP login now."
  gcloud auth login
fi

# Check if current project is valid
CURRENT_PROJECT="$(gcloud config get-value project 2>/dev/null || echo "")"
if [[ -n "$CURRENT_PROJECT" ]]; then
  # Try to verify project exists
  if ! gcloud projects describe "$CURRENT_PROJECT" >/dev/null 2>&1; then
    echo "WARNING: Current project '$CURRENT_PROJECT' is not accessible."
    echo "This may be a stale project. Please select a valid one."
    echo ""
    gcloud config unset project 2>/dev/null || true
    CURRENT_PROJECT=""
  fi
fi

# Show available projects
echo "Available GCP Projects:"
echo ""
PROJECTS=$(gcloud projects list --format="table(projectId,name)" 2>/dev/null || echo "")
if [[ -z "$PROJECTS" ]] || echo "$PROJECTS" | grep -q "WARNING\|ERROR"; then
  echo "WARNING: Could not list projects. You may need to login again."
  echo "Attempting to refresh login..."
  gcloud auth login
  PROJECTS=$(gcloud projects list --format="table(projectId,name)" 2>/dev/null || echo "")
fi

if [[ -z "$PROJECTS" ]] || echo "$PROJECTS" | grep -q "^$"; then
  echo "$PROJECTS"
  echo ""
  echo "⚠️  WARNING: You are logged in but have NO PROJECTS available."
  echo "   You cannot create GKE clusters without a project."
  echo ""
  echo "To fix this, you need to:"
  echo "  1. Create a new GCP project:"
  echo "     - Go to https://console.cloud.google.com"
  echo "     - Navigate to IAM & Admin → Create Project"
  echo "     - Or use: gcloud projects create PROJECT_ID --name=\"Project Name\""
  echo ""
  echo "  2. OR get access to an existing project:"
  echo "     - Contact your GCP administrator"
  echo "     - Request 'Owner' or 'Editor' role on a project"
  echo ""
  echo "  3. OR login with a different account that has projects:"
  echo "     - gcloud auth login (and choose a different account)"
  echo ""
  read -rp "Continue anyway? (y/N): " CONTINUE_NO_PROJECT
  if [[ ! "$CONTINUE_NO_PROJECT" =~ ^[Yy]$ ]]; then
    echo "Exiting. Please set up a project first."
    exit 2
  fi
elif [[ -n "$PROJECTS" ]]; then
  echo "$PROJECTS"
else
  echo "ERROR: Could not list projects. Please check your GCP access."
  exit 1
fi

echo ""
if [[ -z "$CURRENT_PROJECT" ]]; then
  echo "No project is currently set. Please select one:"
  echo ""
  echo "Note: If you just created a project, it may not appear in the list above yet."
  echo "      You can still enter the project ID manually - it will work if the project exists."
  echo ""
  read -rp "Enter project ID: " TARGET_PROJECT
  if [[ -n "$TARGET_PROJECT" ]]; then
    gcloud config set project "$TARGET_PROJECT" || {
      echo "ERROR: Failed to set project. Please check the project ID."
      echo "       The project may not exist or you may not have access to it."
      exit 1
    }
    CURRENT_PROJECT="$TARGET_PROJECT"
  fi
fi

CURRENT_PROJECT_NAME="$(gcloud projects describe "$CURRENT_PROJECT" --format="value(name)" 2>/dev/null || echo "$CURRENT_PROJECT")"
CURRENT_USER="$(gcloud config get-value account 2>/dev/null || echo "unknown")"

echo "Currently active project:"
echo "  Project ID:   $CURRENT_PROJECT"
echo "  Project Name: $CURRENT_PROJECT_NAME"
echo "  User:         $CURRENT_USER"
echo ""

# Ask if user wants to switch projects
read -rp "Use this project? (Y/n): " USE_CURRENT
if [[ "$USE_CURRENT" == "n" || "$USE_CURRENT" == "N" ]]; then
  echo ""
  echo "Options:"
  echo "  1) Select a different project from the list above"
  echo "  2) Login with a different GCP account"
  read -rp "Choose option (1/2): " SWITCH_OPTION
  
  if [[ "$SWITCH_OPTION" == "1" ]]; then
    echo ""
    echo "Enter the project ID to switch to:"
    read -rp "Project ID: " TARGET_PROJECT
    if [[ -n "$TARGET_PROJECT" ]]; then
      gcloud config set project "$TARGET_PROJECT" || {
        echo "ERROR: Failed to switch project. Please check the project ID and try again."
        exit 1
      }
      echo "Switched to project: $TARGET_PROJECT"
    fi
  elif [[ "$SWITCH_OPTION" == "2" ]]; then
    echo ""
    echo "Logging in with a different GCP account..."
    gcloud auth login
    echo ""
    echo "Available projects for new account:"
    gcloud projects list --format="table(projectId,name)"
    echo ""
    read -rp "Enter project ID to use: " TARGET_PROJECT
    if [[ -n "$TARGET_PROJECT" ]]; then
      gcloud config set project "$TARGET_PROJECT" || {
        echo "ERROR: Failed to set project"
        exit 1
      }
      echo "Switched to project: $TARGET_PROJECT"
    fi
  fi
fi

# Get final project details
PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
PROJECT_NAME="$(gcloud projects describe "$PROJECT_ID" --format="value(name)" 2>/dev/null || echo "$PROJECT_ID")"
USER_NAME="$(gcloud config get-value account 2>/dev/null || echo "unknown")"

echo ""
echo "Using GCP project:"
echo "  Project ID:   $PROJECT_ID"
echo "  Project Name: $PROJECT_NAME"
echo "  User:         $USER_NAME"
echo ""

# Helper for prompts with defaults
prompt() {
  local var_name="$1"
  local label="$2"
  local default="${3:-}"
  local sanitize="${4:-false}"
  local val=""
  if [[ -n "$default" ]]; then
    read -rp "$label [$default]: " val
    val="${val:-$default}"
  else
    read -rp "$label: " val
  fi

  if [[ "$sanitize" == "true" ]]; then
    # Lowercase and digits only
    val=$(echo "$val" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]')
  fi

  printf -v "$var_name" "%s" "$val"
}

# 2) Collect inputs
prompt REGION "GCP region (example: us-east1, us-west1, europe-west1)" "us-east1"
prompt CLUSTER_NAME "GKE cluster name" "ingextgke" "true"
prompt NODE_COUNT "Node count per zone (regional cluster)" "1"

# Machine Type selection - show available types automatically
echo ""
echo "Machine Type Selection:"

# Check if Compute Engine API is enabled first (to avoid hanging)
COMPUTE_API_ENABLED=$(gcloud services list --enabled --project="$PROJECT_ID" --filter="name:compute.googleapis.com" --format="value(name)" 2>/dev/null || echo "")

if [[ -z "$COMPUTE_API_ENABLED" ]]; then
  echo "Compute Engine API not enabled yet - skipping machine type lookup."
  echo "The installer will enable required APIs automatically."
  echo "Using default machine type: e2-standard-2"
  echo ""
  TABLE_OUTPUT=""
else
  echo "Checking available machine types for region '$REGION'..."
  echo ""
  
  # Get zone from region (use first zone)
  ZONE="${REGION}-a"
  
  # Get and display filtered machine types (with timeout to avoid hanging)
  # Try to get machine types, but don't block if it hangs
  # Note: Must use --zones, not --filter="zone:"
  TABLE_OUTPUT=""
  if command -v timeout >/dev/null 2>&1; then
    # Use timeout if available (Linux)
    TABLE_OUTPUT=$(timeout 10s gcloud compute machine-types list --zones="$ZONE" --format="table(name,guestCpus,memoryMb)" 2>&1 || echo "")
  elif command -v gtimeout >/dev/null 2>&1; then
    # Use gtimeout if available (macOS with coreutils)
    TABLE_OUTPUT=$(gtimeout 10s gcloud compute machine-types list --zones="$ZONE" --format="table(name,guestCpus,memoryMb)" 2>&1 || echo "")
  else
    # No timeout available - try without timeout but catch errors
    TABLE_OUTPUT=$(gcloud compute machine-types list --zones="$ZONE" --format="table(name,guestCpus,memoryMb)" 2>&1 || echo "")
    if [[ -z "$TABLE_OUTPUT" ]] || echo "$TABLE_OUTPUT" | grep -q "ERROR"; then
      echo "Note: Could not check machine types (timeout command not available and API may not be ready)."
      echo "Using default machine type: e2-standard-4"
      echo ""
      TABLE_OUTPUT=""
    fi
  fi
  
  # Check if we got an error instead of data
  if echo "$TABLE_OUTPUT" | grep -q "ERROR"; then
    echo "Note: Could not retrieve machine types (API may not be enabled or request failed)."
    echo "Using default machine type: e2-standard-4"
    echo ""
    TABLE_OUTPUT=""
  fi
fi

# Default to a type that's commonly available for GKE
DEFAULT_MACHINE_TYPE="e2-standard-4"  # Fallback default

if [[ -n "$TABLE_OUTPUT" ]] && ! echo "$TABLE_OUTPUT" | grep -q "ERROR"; then
  # Filter to common GKE-compatible types (e2-standard, n1-standard, n2-standard series)
  FILTERED=$(echo "$TABLE_OUTPUT" | \
    grep -E "^(NAME|e2-standard|n1-standard|n2-standard)" | \
    grep -v -E "(-gpu-|-highmem-|-highcpu-|a2-|c2-|m1-)" | \
    head -n 15 || true)
  
  if [[ -n "$FILTERED" ]]; then
    echo "Recommended machine types (showing first 15):"
    echo "$FILTERED" | head -n 17
    echo ""
    
    # Extract the best machine type from the filtered list
    # Prefer e2-standard-4, then e2-standard-2, then e2-standard-8, then first available
    PREFERRED_TYPE=$(echo "$FILTERED" | grep -E "^e2-standard-4" | head -n 1 | awk '{print $1}' || echo "")
    if [[ -z "$PREFERRED_TYPE" ]]; then
      PREFERRED_TYPE=$(echo "$FILTERED" | grep -E "^e2-standard-2" | head -n 1 | awk '{print $1}' || echo "")
    fi
    if [[ -z "$PREFERRED_TYPE" ]]; then
      PREFERRED_TYPE=$(echo "$FILTERED" | grep -E "^e2-standard-8" | head -n 1 | awk '{print $1}' || echo "")
    fi
    if [[ -z "$PREFERRED_TYPE" ]]; then
      # Fallback to first e2-standard type found
      PREFERRED_TYPE=$(echo "$FILTERED" | grep -E "^e2-standard" | head -n 1 | awk '{print $1}' || echo "")
    fi
    
    if [[ -n "$PREFERRED_TYPE" ]] && [[ "$PREFERRED_TYPE" =~ ^e2-standard ]]; then
      DEFAULT_MACHINE_TYPE="$PREFERRED_TYPE"
      echo "Default recommendation: $DEFAULT_MACHINE_TYPE"
    else
      echo "Default recommendation: $DEFAULT_MACHINE_TYPE (fallback)"
    fi
    
    echo ""
    echo "💡 Tip: Common GKE-compatible types:"
    echo "   - e2-standard-2 (2 vCPU, 8GB) - Small/Testing"
    echo "   - e2-standard-4 (4 vCPU, 16GB) - Balanced (default)"
    echo "   - e2-standard-8 (8 vCPU, 32GB) - Production workloads"
    echo ""
  else
    echo "Could not filter types. Showing first 10 available:"
    echo "$TABLE_OUTPUT" | head -n 12
    echo ""
  fi
else
  echo "Could not retrieve machine types (API may not be enabled or request timed out)."
  echo "Using default: $DEFAULT_MACHINE_TYPE"
  echo ""
  echo "You can enable the Compute Engine API later, or proceed with the default."
fi

read -rp "Machine type [$DEFAULT_MACHINE_TYPE]: " MACHINE_TYPE_INPUT
MACHINE_TYPE="${MACHINE_TYPE_INPUT:-$DEFAULT_MACHINE_TYPE}"

prompt DISK_SIZE "Boot disk size in GB per node (default: 40, GKE default is 100)" "40"
prompt NAMESPACE "Kubernetes namespace" "ingext" "true"
prompt SITE_DOMAIN "Public domain for Ingext (example: ingext.example.com)" ""
prompt CERT_EMAIL "Email for certificate issuer" ""

prompt GCS_BUCKET "Google Cloud Storage Bucket" "ingext-$CLUSTER_NAME"
prompt GSA_NAME "Google Service Account" "$NAMESPACE-gsa"
prompt SA_NAME "Kubenete Service Account" "$NAMESPACE-sa"


echo ""
echo "You will need DNS control for: $SITE_DOMAIN"
echo "You will create an A record to the Google Cloud Load Balancer IP after ingress is created."
echo ""

# 3) Ask permission readiness questions (human-verifiable)
echo "Permissions and readiness questions (answer honestly, this avoids failed installs):"
prompt HAS_BILLING "Do you have an active GCP project with billing enabled? (yes/no)" "yes"
prompt HAS_OWNER "Do you have Owner or Editor permissions to create GKE clusters? (yes/no)" "yes"
prompt HAS_QUOTA "Do you expect enough quota in region '$REGION' for at least ${NODE_COUNT} nodes per zone? (yes/no/unsure)" "unsure"
prompt HAS_DNS "Do you control DNS for '$SITE_DOMAIN' (can create A records)? (yes/no)" "yes"

# 4) Best-effort technical checks
echo ""
echo "---------------- Best-effort checks ----------------"

echo ""
echo "[Check] Billing status"
BILLING_ACCOUNT=$(gcloud billing projects describe "$PROJECT_ID" --format="value(billingAccountName)" 2>/dev/null || echo "")
if [[ -n "$BILLING_ACCOUNT" ]] && [[ "$BILLING_ACCOUNT" != "" ]]; then
  echo -n "  Billing: "
  color_green "ENABLED"
  echo "  Account: $BILLING_ACCOUNT"
else
  echo -n "  Billing: "
  color_red "NOT ENABLED"
  echo ""
  echo "  ⚠️  WARNING: Billing must be enabled before APIs can be enabled or GKE clusters created."
  echo ""
  echo "  To enable billing:"
  echo "    1. Via Console: https://console.cloud.google.com/billing?project=$PROJECT_ID"
  echo "    2. Via CLI: gcloud billing projects link $PROJECT_ID --billing-account=BILLING_ACCOUNT_ID"
  echo "       (List accounts: gcloud billing accounts list)"
  echo ""
fi

echo ""
echo "[Check] Required APIs enabled"
# Check required APIs
APIS=(
  "container.googleapis.com:Google Kubernetes Engine API"
  "compute.googleapis.com:Compute Engine API"
  "cloudresourcemanager.googleapis.com:Cloud Resource Manager API"
)

ALL_ENABLED=1
for api_info in "${APIS[@]}"; do
  API_NAME="${api_info%%:*}"
  API_DESC="${api_info##*:}"
  
  echo -n "  $API_DESC: "
  
  STATUS=$(gcloud services list --enabled --project="$PROJECT_ID" --filter="name:$API_NAME" --format="value(name)" 2>/dev/null || echo "")
  
  if [[ -n "$STATUS" ]]; then
    echo -e "\033[0;32mENABLED\033[0m"
  else
    echo -e "\033[0;33mNOT ENABLED\033[0m"
    ALL_ENABLED=0
  fi
done

if [[ "$ALL_ENABLED" == "0" ]]; then
  echo ""
  echo "  NOTE: If APIs are not enabled, GKE cluster creation will fail."
  echo ""
  echo "  IMPORTANT: Billing must be enabled before APIs can be enabled."
  echo "  If you see a billing error, enable billing first:"
  echo "    1. Via Console: https://console.cloud.google.com/billing?project=$PROJECT_ID"
  echo "    2. Via CLI: gcloud billing projects link $PROJECT_ID --billing-account=BILLING_ACCOUNT_ID"
  echo "       (List accounts: gcloud billing accounts list)"
  echo ""
  echo "  Then enable required APIs:"
  echo "    gcloud services enable container.googleapis.com compute.googleapis.com cloudresourcemanager.googleapis.com --project=$PROJECT_ID"
  echo ""
  echo "  Or use the helper script:"
  echo "    ./check-apis.sh --project $PROJECT_ID"
fi

echo ""
echo "[Check] Region usage snapshot (compute)"
# This is informative, not authoritative. Some projects cannot query usage.
gcloud compute project-info describe --project="$PROJECT_ID" --format="get(quotas)" 2>/dev/null | head -n 20 || {
  echo "  WARNING: Unable to query quota information. You may lack permission."
}

echo ""
echo "[Check] DNS resolution status (not ownership proof)"
if command -v dig >/dev/null 2>&1; then
  A_REC="$(dig +short A "$SITE_DOMAIN" | head -n 1 || true)"
  if [[ -n "$A_REC" ]]; then
    echo "  Current A record: $A_REC"
  else
    echo "  No A record found currently (OK if new subdomain)."
  fi
elif command -v nslookup >/dev/null 2>&1; then
  if nslookup "$SITE_DOMAIN" >/dev/null 2>&1; then
    echo "  Domain resolves (nslookup succeeded)."
  else
    echo "  Domain does not currently resolve (OK if new subdomain)."
  fi
else
  echo "  dig/nslookup not found, skipping resolution check."
fi

# 5) Summarize risk flags
echo ""
echo "---------------- Preflight summary ----------------"
WARN=0

if [[ "${HAS_BILLING,,}" != "yes" ]]; then
  echo "WARNING: Billing not confirmed. Install will likely fail."
  WARN=1
fi

if [[ "${HAS_OWNER,,}" != "yes" ]]; then
  echo "WARNING: Owner/Editor-level permissions not confirmed. Install will likely fail."
  WARN=1
fi

if [[ "${HAS_DNS,,}" != "yes" ]]; then
  echo "WARNING: DNS control not confirmed. HTTPS and login will not work."
  WARN=1
fi

if [[ "${HAS_QUOTA,,}" == "no" ]]; then
  echo "WARNING: Quota likely insufficient in $REGION."
  WARN=1
fi

if [[ "$WARN" -eq 0 ]]; then
  echo "No major red flags reported."
else
  echo "One or more red flags detected. You can still generate the env file, but expect install problems."
fi

# 6) Write env file
echo ""
if [[ -f "$OUTPUT_ENV" ]]; then
  echo "WARNING: $OUTPUT_ENV already exists and will be overwritten."
  read -rp "Continue? (y/N): " CONFIRM_OVERWRITE
  if [[ ! "$CONFIRM_OVERWRITE" =~ ^[Yy]$ ]]; then
    echo "Cancelled. Environment file not updated."
    exit 2
  fi
fi

echo "Writing environment file: $OUTPUT_ENV"

cat > "$OUTPUT_ENV" <<EOF
# Generated by preflight-gcp.sh
# Usage:
#   source $OUTPUT_ENV
#   ./install-ingext-gke.sh --project "\$PROJECT_ID" --region "\$REGION" --cluster-name "\$CLUSTER_NAME" --domain "\$SITE_DOMAIN" --email "\$CERT_EMAIL"

export PROJECT_ID="$(printf '%s' "$PROJECT_ID")"
export REGION="$(printf '%s' "$REGION")"
export CLUSTER_NAME="$(printf '%s' "$CLUSTER_NAME")"
export NODE_COUNT="$(printf '%s' "$NODE_COUNT")"
export MACHINE_TYPE="$(printf '%s' "$MACHINE_TYPE")"
export DISK_SIZE="$(printf '%s' "$DISK_SIZE")"
export NAMESPACE="$(printf '%s' "$NAMESPACE")"
export GCS_BUCKET="$(printf '%s' "$GCS_BUCKET")"
export GSA_NAME="$(printf '%s' "$GSA_NAME")"
export SA_NAME="$(printf '%s' "$SA_NAME")"
export SITE_DOMAIN="$(printf '%s' "$SITE_DOMAIN")"
export CERT_EMAIL="$(printf '%s' "$CERT_EMAIL")"

# Self-reported readiness (for support/debugging)
export PREFLIGHT_HAS_BILLING="$(printf '%s' "$HAS_BILLING")"
export PREFLIGHT_HAS_OWNER="$(printf '%s' "$HAS_OWNER")"
export PREFLIGHT_HAS_QUOTA="$(printf '%s' "$HAS_QUOTA")"
export PREFLIGHT_HAS_DNS="$(printf '%s' "$HAS_DNS")"
EOF

echo ""
echo "Done."
echo ""
echo "Next steps:"
echo "  1) source $OUTPUT_ENV"
echo "  2) Run installer:"
echo "     ./install-ingext-gke.sh"
echo ""
echo "     (The installer will use the environment variables from $OUTPUT_ENV)"
echo ""
echo "     Alternatively, you can pass arguments directly:"
echo "     ./install-ingext-gke.sh \\"
echo "       --project \"\$PROJECT_ID\" \\"
echo "       --region \"\$REGION\" \\"
echo "       --cluster-name \"\$CLUSTER_NAME\" \\"
echo "       --domain \"\$SITE_DOMAIN\" \\"
echo "       --email \"\$CERT_EMAIL\""
echo ""

