# Ingext: The Self-Hosted Data Fabric & Lakehouse 🚀

## Configuration after installation

### ingext cli: [API and Usage](https://github.com/SecurityDo/ingext_api/)

### Add user with admin role

```bash
ingext auth add-user --name admin@ingext.io --displayName "Ingext Admin" --role admin
```

### Import processors and application templates from Ingext Community Git repository

```bash
ingext import processor --type fpl_processor
ingext import processor --type fpl_receiver
ingext import processor --type fpl_packer
ingext import application
```

### Add default datalake and index

```bash
ingext datalake add --managed
ingext datalake add-index --index default
```

## Add a HEC data source and pass it to the "default" datalake index

```bash
ingext stream add-source --source-type hec --name HecInput
## $srcID
ingext stream add-router --processor System_Simple_Passthrough  
## $routerID
ingext stream add-sink --name Default --sink-type datalake --index default
## $sinkID
ingext stream connect-sink --router-id $routerID --sink-id $sinkID
ingext stream connect-router --router-id $routerID --source-id $srcID
```

## Add Office365 Audit event source

### setup Microsoft Azure application with permissions

```bash
scripts/azure/office365Audit.sh 
# collect tenantId, clientId and clientSecret from the console output
```

### add integration entry with credentials

```bash
ingext integration add \
  --name $name \
  --integration Office365 \
  --config tenantID="$tenantId" \
  --config clientId="$clientId" \
  --secret clientSecret="$clientSecret"
# collect integrationID
```

### add datasource and router

```bash
ingext stream add-source --integration-id $integrationID --name $name --source-type plugin
# collect sourceID
ingext stream add-router --processor Office365_Adjustments
ingext stream connect-router --router-id $routerID --source-id $srcID
```

### OR install the full pipeline with application template

```bash
ingext application install --app Office365 \
  --instance $name \
  --config tenantID="$tenantID" \
  --config clientId="$clientId" \
  --secret clientSecret="$clientSecret"
```

## Add AzureEventHubs event source

### setup consumer group for an existing AzureEventHubs

```bash
scripts/azure/azureEventHubsReader.sh 
# collect EH_CONN_STR, STORAGE_CONN_STR, CONTAINER_NAME and CONSUMER_GROUP from the console output
```

### add AzureEventHubs integration entry

```bash
ingext integration add \
  --name $name \
  --integration AzureEventHubs\
  --config endpoint="$EH_CONN_STR" \
  --config storageEndpoint="$STORAGE_CONN_STR" \
  --config containerName="$CONTAINER_NAME" \
  --config consumerGroup="$CONSUMER_GROUP"
# collect integrationID
```

### add datasource and router

```bash
ingext stream add-source --integration-id $integrationID --name $name --source-type plugin
# collect sourceID
ingext stream add-router --processor AzureEventHubs_Adjustments
ingext stream connect-router --router-id $routerID --source-id $srcID
```

### OR install the full pipeline with application template

```bash
ingext application install --app AzureEventHubs \
  --instance $name \
  --secret endpoint="$EH_CONN_STR" \
  --secret storageEndpoint="$STORAGE_CONN_STR" \
  --config containerName="$CONTAINER_NAME" \
  --config consumerGroup="$CONSUMER_GROUP"
```

## Add GSuite audit event source

### setup service account

Run "gcloud auth login" in the cloud-shell

**`scripts/gcloud/gSuiteAuditSetup.sh`**

This script will:

1. Create a new Google Cloud Project.
2. Enable the Admin SDK API.
3. Create a Service Account.
4. Generate and download the JSON key file (which serves as the "secret").

### add AzureEventHubs integration entry with a datasource

```bash
ingext integration add \
  --name $name \
  --integration GSuite \
  --config adminUserEmail="$adminUserEmail" \
  --secret serviceAccountKey="@ingext-reader-key.json" \
  --add-source
```

### OR install the full pipeline with application template

```bash
ingext application install \
  --app GSuite \
  --instance SecurityDoAccount2 \
  --config adminUserEmail="$adminUserEmail" \
  --secret serviceAccountKey="@ingext-reader-key.json"
