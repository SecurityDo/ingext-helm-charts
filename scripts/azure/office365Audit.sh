#!/bin/bash


# Reference: https://learn.microsoft.com/en-us/office/office-365-management-api/get-started-with-office-365-management-apis
# Office365 Management API permissions:
#   ActivityFeed.Read (The basic one): Gives access to standard audit logs (SharePoint, Exchange, Azure AD, General Audit).
#   ActivityFeed.ReadDlp: Required specifically to read Data Loss Prevention logs. If your company uses DLP rules (e.g., blocking credit card numbers in emails), those alerts appear in a separate sensitive stream that requires this specific permission.
#   ServiceHealth.Read: Allows the collector to check if Office 365 itself is down. This is useful for SIEMs to differentiate between "The collector is broken" vs "Microsoft is down."

# --- Configuration ---
APP_DISPLAY_NAME="O365-Audit-Collector"
O365_API_GUID="c5393580-f805-4401-95e8-94b7a6ef2fc2" # Office 365 Management API

# List of all required permissions
# We use a Bash Array to store them
PERMISSIONS=("ActivityFeed.Read" "ActivityFeed.ReadDlp" "ServiceHealth.Read")

CERT_FILENAME="o365_auth_cert.pem" 
PUBLIC_CERT_NAME="o365_public_cert.pem"

echo "--- Starting Setup for $APP_DISPLAY_NAME ---"

# 1. Generate Certificate Locally using OpenSSL
echo "Generating Self-Signed Certificate..."
openssl req -x509 -newkey rsa:2048 -keyout $CERT_FILENAME -out $CERT_FILENAME -days 1095 -nodes -subj "/CN=$APP_DISPLAY_NAME" 2>/dev/null

# Extract just the public part for Azure
openssl x509 -in $CERT_FILENAME -out $PUBLIC_CERT_NAME

echo "Certificate created: $CERT_FILENAME"

# 2. Create the Application Registration
echo "Creating App Registration..."
APP_ID=$(az ad app create --display-name "$APP_DISPLAY_NAME" --query appId --output tsv)
echo "App ID created: $APP_ID"

# 3. Create the Service Principal
echo "Creating Service Principal..."
SP_ID=$(az ad sp create --id $APP_ID --query id --output tsv)
echo "Service Principal ID: $SP_ID"

echo "Waiting 30 seconds for Azure AD replication..."
sleep 30

# 4. Loop through the permissions and add them
echo "Processing Permissions..."

for PERM_NAME in "${PERMISSIONS[@]}"
do
    echo "  -> Looking up ID for '$PERM_NAME'..."
    
    # Dynamic Lookup
    ROLE_ID=$(az ad sp list --filter "appId eq '$O365_API_GUID'" --query "[].appRoles[?value=='$PERM_NAME'].id" --output tsv)

    if [ -z "$ROLE_ID" ]; then
        echo "     [ERROR] Could not find permission role '$PERM_NAME'. Skipping."
        continue
    fi

    echo "     Found Role ID: $ROLE_ID"
    
    # Add to Manifest
    echo "     Adding '$PERM_NAME' to App Manifest..."
    az ad app permission add --id $APP_ID --api $O365_API_GUID --api-permissions "$ROLE_ID=Role"
done

# We must wait for the permission updates (step 3) to actually apply 
# before we try to grant them (step 5).
echo "Waiting 30s for permissions to apply..."
sleep 30


# 5. Grant Admin Consent (Grants ALL added permissions at once)
echo "Granting Admin Consent for all permissions..."
az ad app permission admin-consent --id $APP_ID

# 6. Upload the Public Certificate
echo "Uploading Public Certificate..."
az ad app credential reset --id $APP_ID --cert "@$PUBLIC_CERT_NAME" --append --query "credentialTypes" --output tsv > /dev/null

# 7. Calculate Thumbprint
THUMBPRINT=$(openssl x509 -in $CERT_FILENAME -fingerprint -sha1 -noout | sed 's/://g' | sed 's/SHA1 Fingerprint=//g')

# Cleanup
rm $PUBLIC_CERT_NAME

echo "------------------------------------------------"
echo "Setup Complete!"
echo "Tenant ID    : $(az account show --query tenantId --output tsv)"
echo "Client ID    : $APP_ID"
echo "Thumbprint   : $THUMBPRINT"
echo "Certificate  : $(pwd)/$CERT_FILENAME"
echo "Permissions  : ${PERMISSIONS[*]}"
echo "------------------------------------------------"
