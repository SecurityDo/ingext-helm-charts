#!/bin/bash

set -e  # Abort script immediately if any command fails
set -o pipefail


# Configuration
PROJECT_ID="ingext-reader-$(date +%s)" # Generates a unique ID
PROJECT_NAME="Ingext Audit Reader"
SA_NAME="ingext-log-collector"
OUTPUT_KEY_FILE="ingext-reader-key.json"

echo "--- Starting G Suite SIEM Reader Setup ---"

# 1. Create the Project
echo "Creating project: $PROJECT_ID..."
gcloud projects create $PROJECT_ID --name="$PROJECT_NAME" --quiet

# 2. Set the current project context
gcloud config set project $PROJECT_ID --quiet

# 3. Enable the Admin SDK API (Required for audit reports)
echo "Enabling Admin SDK API (this may take a moment)..."
gcloud services enable admin.googleapis.com

# 4. Create the Service Account
echo "Creating Service Account: $SA_NAME..."
gcloud iam service-accounts create $SA_NAME \
    --description="Reader account for SIEM Audit Logs" \
    --display-name="SIEM Log Collector"

# 5. Create and Download the JSON Key
echo "Generating Service Account Key..."
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud iam service-accounts keys create $OUTPUT_KEY_FILE \
    --iam-account=$SA_EMAIL

echo "Fixing file permissions for host access..."
chmod 644 $OUTPUT_KEY_FILE

echo "--- Setup Complete ---"
echo "Project ID: $PROJECT_ID"
echo "Service Account Email: $SA_EMAIL"
echo "Client ID (Unique ID): $(grep 'client_id' $OUTPUT_KEY_FILE | cut -d '"' -f 4)"
echo "Key file saved to: $PWD/$OUTPUT_KEY_FILE"
echo ""
echo "!!! CRITICAL NEXT STEP !!!"
echo "You must now perform Domain-Wide Delegation in the Google Admin Console:"
echo "1. Go to admin.google.com > Security > Access and data control > API controls > Manage Domain Wide Delegation."
echo "2. Click 'Add new'."
echo "3. Client ID: (Use the 'Client ID' printed above)"
echo "4. OAuth Scopes (comma delimited):"
echo "   https://www.googleapis.com/auth/admin.reports.usage.readonly,https://www.googleapis.com/auth/admin.reports.audit.readonly"
