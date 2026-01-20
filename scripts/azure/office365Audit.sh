#!/bin/bash

# --- Configuration ---
APP_DISPLAY_NAME="Ingext-O365-Audit-Collector"

# API Identifiers (GUIDs)
# 1. Office 365 Management API
O365_API_GUID="c5393580-f805-4401-95e8-94b7a6ef2fc2"
# 2. Microsoft Graph API (Always this fixed GUID)
GRAPH_API_GUID="00000003-0000-0000-c000-000000000000"

# Permissions Lists
O365_PERMISSIONS=("ActivityFeed.Read" "ActivityFeed.ReadDlp" "ServiceHealth.Read")
GRAPH_PERMISSIONS=("Group.Read.All" "User.Read.All")

echo "--- Starting Setup for $APP_DISPLAY_NAME (Secret Based) ---"

# 1. Create App Registration
echo "Creating App Registration..."
APP_ID=$(az ad app create --display-name "$APP_DISPLAY_NAME" --query appId --output tsv)
echo "App ID created: $APP_ID"

# 2. Create Service Principal
echo "Creating Service Principal..."
SP_ID=$(az ad sp create --id $APP_ID --query id --output tsv)
echo "Service Principal ID: $SP_ID"

echo "Waiting 30 seconds for Azure AD replication..."
sleep 30

# 3. Add Office 365 Permissions
echo "Processing Office 365 Permissions..."
for PERM_NAME in "${O365_PERMISSIONS[@]}"
do
    echo "  -> Looking up ID for '$PERM_NAME'..."
    ROLE_ID=$(az ad sp list --filter "appId eq '$O365_API_GUID'" --query "[].appRoles[?value=='$PERM_NAME'].id" --output tsv)

    if [ -z "$ROLE_ID" ]; then
        echo "     [ERROR] Could not find permission role '$PERM_NAME'. Skipping."
        continue
    fi
    az ad app permission add --id $APP_ID --api $O365_API_GUID --api-permissions "$ROLE_ID=Role"
done

# 4. Add Microsoft Graph Permissions
echo "Processing Microsoft Graph Permissions..."
for PERM_NAME in "${GRAPH_PERMISSIONS[@]}"
do
    echo "  -> Looking up ID for '$PERM_NAME'..."
    # Note: We filter by the Graph API GUID here
    ROLE_ID=$(az ad sp list --filter "appId eq '$GRAPH_API_GUID'" --query "[].appRoles[?value=='$PERM_NAME'].id" --output tsv)

    if [ -z "$ROLE_ID" ]; then
        echo "     [ERROR] Could not find permission role '$PERM_NAME'. Skipping."
        continue
    fi
    az ad app permission add --id $APP_ID --api $GRAPH_API_GUID --api-permissions "$ROLE_ID=Role"
done

# We must wait for the permission updates to actually apply 
# before we try to grant them.
echo "Waiting 30s for permissions to apply..."
sleep 30

# 5. Grant Admin Consent (Grants ALL added permissions at once)
echo "Granting Admin Consent for all permissions..."
az ad app permission admin-consent --id $APP_ID

# 6. Generate Client Secret (Replaces Certificate Steps)
# This generates a random strong password valid for 2 years
echo "Generating Client Secret..."
CLIENT_SECRET=$(az ad app credential reset --id $APP_ID --append --display-name "AppSecret" --years 3 --query password --output tsv)

echo "------------------------------------------------"
echo "Setup Complete!"
echo "Tenant ID     : $(az account show --query tenantId --output tsv)"
echo "Client ID     : $APP_ID"
echo "Client Secret : $CLIENT_SECRET"
echo "------------------------------------------------"
echo "IMPORTANT: Save the Client Secret now. You cannot see it again."
