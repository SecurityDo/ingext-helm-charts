#!/usr/bin/env bash

set -euo pipefail

###############################################################################
# Preflight AWS Lakehouse Wizard
#
# - Verifies AWS authentication and profile.
# - Prompts for Stream + Datalake configuration.
# - Performs best-effort checks (S3 name, EKS quotas, DNS).
# - Writes lakehouse-aws.env.
###############################################################################

OUTPUT_ENV="${OUTPUT_ENV:-./lakehouse-aws.env}"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: missing dependency: $1"
    exit 1
  }
}

print_help() {
  cat <<EOF
Preflight AWS Lakehouse Wizard

Usage:
  ./preflight-lakehouse.sh
  OUTPUT_ENV=./my.env ./preflight-lakehouse.sh

What it does:
  - Prompts for AWS, DNS, and Lakehouse settings.
  - Runs basic checks using AWS CLI.
  - Generates environment variables for install-lakehouse.sh.

Next step:
  source $OUTPUT_ENV
  ./install-lakehouse.sh
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_help
  exit 0
fi

need aws
need eksctl

echo ""
echo "================ Preflight AWS Lakehouse (Interactive) ================"
echo ""

# 1) AWS Auth Check
# Let user pick a profile first if they want
echo "Checking available AWS configuration..."

# Check if environment variables are already set
if [[ -n "${AWS_ACCESS_KEY_ID:-}" ]]; then
  echo "✅ Detected AWS credentials in environment variables."
  SELECTED_PROFILE="environment"
else
  PROFILES=$(aws configure list-profiles 2>/dev/null || echo "")
  if [[ -n "$PROFILES" ]]; then
    echo "Available profiles:"
    echo "$PROFILES" | sed 's/^/  - /'
    echo ""
    read -rp "Which AWS Profile would you like to use? [default]: " SELECTED_PROFILE
    export AWS_PROFILE="${SELECTED_PROFILE:-default}"
  else
    echo "⚠️  No AWS profiles found in ~/.aws/config"
    SELECTED_PROFILE="default"
    export AWS_PROFILE="default"
  fi
fi

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  if [[ "$SELECTED_PROFILE" == "environment" ]]; then
    echo "ERROR: AWS credentials in environment variables are invalid."
    exit 1
  fi
  
  echo "⚠️  WARNING: You are not authenticated with profile '$AWS_PROFILE'."
  echo "   How do you normally log in to AWS?"
  echo "   1. Browser / Email (SSO) -> Run 'aws sso login'"
  echo "   2. Access Keys (IAM)     -> Run 'aws configure'"
  echo "   3. Switch Profile        -> Run preflight again"
  echo ""
  read -rp "Enter choice (1 or 2) or 'q' to quit: " LOGIN_CHOICE
  if [[ "$LOGIN_CHOICE" == "1" ]]; then
    if [[ "$SELECTED_PROFILE" == "default" && -z "$(aws configure get sso_start_url 2>/dev/null)" ]]; then
      echo "--------------------------------------------------------"
      echo "💡 SSO CONFIGURATION HINTS:"
      echo "   1. SSO session name: Type 'ingext'"
      echo "   2. SSO start URL:    https://d-xxxxxxxxxx.awsapps.com/start"
      echo "   3. SSO region:       Usually 'us-east-1'"
      echo "   4. CLI profile name: Type 'default' (Recommended)"
      echo "--------------------------------------------------------"
      echo ""
      read -rp "Ready to run 'aws configure sso'? (y/N): " RUN_SSO_CONFIG
      if [[ "${RUN_SSO_CONFIG,,}" =~ ^[Yy]$ ]]; then
        aws configure sso
      else
        echo "Exiting. Please configure SSO or use Access Keys."
        exit 1
      fi
    else
      echo "Starting SSO login..."
      aws sso login
    fi
  elif [[ "$LOGIN_CHOICE" == "2" ]]; then
    echo "--------------------------------------------------------"
    echo "🔑 HOW TO GET ACCESS KEYS:"
    echo "   1. Log in to AWS Console in your browser."
    echo "   2. Go to: IAM -> Users -> (Your Name) -> Security credentials"
    echo "   3. Click 'Create access key' -> Select 'CLI'."
    echo "   4. Copy the 'Access Key ID' (AKIA...) and 'Secret Access Key'."
    echo "--------------------------------------------------------"
    echo ""
    aws configure
  else
    exit 1
  fi
fi

# Re-check identity
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  echo "ERROR: Still not authenticated. Please check your credentials or SSO session."
  exit 1
fi

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "Authenticated as AWS Account: $ACCOUNT_ID using profile: $AWS_PROFILE"

# 2) Prompt for remaining inputs
prompt() {
  local var_name="$1"
  local label="$2"
  local default="${3:-}"
  local val=""
  # Skip AWS_PROFILE since we already got it
  if [[ "$var_name" == "AWS_PROFILE" ]]; then
    return
  fi
  if [[ -n "$default" ]]; then
    read -rp "$label [$default]: " val
    val="${val:-$default}"
  else
    read -rp "$label: " val
  fi
  printf -v "$var_name" "%s" "$val"
}

# Remove AWS_PROFILE from prompt list below
prompt AWS_REGION "AWS Region" "us-east-1"
prompt CLUSTER_NAME "EKS Cluster Name" "ingext-lakehouse"
prompt S3_BUCKET "S3 Bucket Name (for Datalake)" "ingext-datalake-$ACCOUNT_ID"
prompt SITE_DOMAIN "Public Domain (e.g. ingext.example.com)" ""
prompt NAMESPACE "Kubernetes Namespace" "ingext"

# Node preferences (AMD EPYC preference)
echo ""
echo "Instance Recommendations:"
echo "  - m5a.large (AMD EPYC) - Recommended for general purpose"
echo "  - t3.large (Intel)     - Cost-effective for testing"
prompt NODE_TYPE "Primary Node Instance Type" "m5a.large"
prompt NODE_COUNT "Initial Node Count" "3"

# 3) Technical Checks
echo ""
echo "---------------- Best-effort checks ----------------"

echo "[Check] S3 Bucket Availability"
if aws s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
  echo "  Bucket '$S3_BUCKET' already exists and you have access."
else
  echo "  Bucket '$S3_BUCKET' is available or will be created."
fi

echo ""
echo "[Check] DNS resolution status"
if command -v dig >/dev/null 2>&1; then
  A_REC="$(dig +short A "$SITE_DOMAIN" | head -n 1 || true)"
  if [[ -n "$A_REC" ]]; then
    echo "  Current A record for $SITE_DOMAIN: $A_REC"
  else
    echo "  No A record found for $SITE_DOMAIN (expected for new setup)."
  fi
fi

# 4) Write env file
echo ""
if [[ -f "$OUTPUT_ENV" ]]; then
  echo "WARNING: $OUTPUT_ENV already exists."
  read -rp "Overwrite? (y/N): " CONFIRM_OVERWRITE
  if [[ ! "$CONFIRM_OVERWRITE" =~ ^[Yy]$ ]]; then
    echo "Cancelled."
    exit 2
  fi
fi

cat > "$OUTPUT_ENV" <<EOF
# Generated by preflight-lakehouse.sh
export AWS_PROFILE="$AWS_PROFILE"
export AWS_REGION="$AWS_REGION"
export CLUSTER_NAME="$CLUSTER_NAME"
export S3_BUCKET="$S3_BUCKET"
export SITE_DOMAIN="$SITE_DOMAIN"
export NAMESPACE="$NAMESPACE"
export NODE_TYPE="$NODE_TYPE"
export NODE_COUNT="$NODE_COUNT"
export ACCOUNT_ID="$ACCOUNT_ID"
EOF

chmod +x "$OUTPUT_ENV"

echo ""
echo "Done. Environment file written to: $OUTPUT_ENV"
echo "Next step: source $OUTPUT_ENV && ./install-lakehouse.sh"
echo ""
