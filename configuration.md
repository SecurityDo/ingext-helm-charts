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

OR install the full pipeline with application template

```bash
ingext application install \
  --app HecPassthrough \
  --instance hecTest

ingext application get-instance \
  --app=HecPassthrough \
  --instance=hecTest
# output the URL and Token for the HEC endpoint
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
```

## Read K8s logs collected by Fluent bit in a S3 bucket

### Step 1. enable event notification on the S3 bucket

* Create a SQS queue on the same region as the bucket
* Enable event notification on the S3 bucket, sent the notification event to the queue just created.
* Create an IAM policy to read from the S3 bucket and the SQS queue

```bash
## <remoteProfile> <remoteRegion> <bucket> <prefix> <assumedRoleName>  
scripts/aws/s3_bucket_notify_setup.sh <remoteProfile> <remoteRegion> <bucket> <prefix> <SQS queue name> > policy.json
```

### Step 2. Setup Roles on "local" and "remote" AWS accounts

* Create a "assumed role" on the "remote AWS account" where S3 bucket is hosted
* Attach the IAM policy created in Step 1 to this role
* Allow the ingext service account role to assume this role
* On the "local" AWS account where ingext app is hosted, allow the ingext service account role to assume the remote role just created on the remote AWS account.

```bash
## <remoteProfile> <remoteRegion> <bucket> <prefix> <assumedRoleName>  
scripts/aws/external-role_setup.sh <localProfile> <remoteProfile> <assumedRoleName> <policy.json>
```

### Step 3. Register the remote assumed role in the ingext app.

```bash
ingext eks add-assumed-role --name "$remoteAccountID:$assumedRoleName" --roleArn arn:aws:iam::$remoteAccountID:role/$assumedRoleName
```

### Step 4. Configure one integration "S3 with notification" with the remote assumed role set for authorization method.

### Step 5. Install AWSFluentbitS3 application template with datasource/router/datasink configured.

```bash
ingext application install --app AWSFluentbitS3 \
  --instance $name \
  --config Region="$region" \
  --config SQS_URL="$SQS_URO" \
  --secret AWS_Role="$remoteAccountID:$assumedRoleName"
```

## Import from AWS CloudWatch LogGroup:  [AWS Cloudwatch LogGroup event export](https://github.com/SecurityDo/fpl-reports/blob/main/docs/cloudwatchImport.adoc)

### Step 1: Setup IAM Roles for Cloudwatch and Firehose service.

* Create a S3 bucket to hold the loggroup data. (shared by all loggroups)
* Create a new IAM role, allow Firehose to write to the S3 bucket just created.
* Create a new IAM role, allow Cloudwatch to write to the Firehose stream.
* https://fluency-cloudformation.s3.us-east-2.amazonaws.com/FluencyCloudWatchFirehose.yaml[Cloudformation Template]
* Cloudformation Parameters:
** CloudWatchRole:  fluencyCloudwatchToFireHose
** FirehoseRole: fluencyFireHoseToS3
** S3Bucket: {yourcompany}-fluency-cloudwatch-firehose

### Step 2: Add Loggroup one by one

* Create a new Firehose stream.
* Create a new subscription filter for the loggroup, set the destination to the Firehose stream.
* https://fluency-cloudformation.s3.us-east-2.amazonaws.com/FluencyCloudWatchSubscriptionFilter.yaml[Cloudformation Template]
* Cloudformation Parameters:
** CloudWatchRole:  fluencyCloudwatchToFireHose
** FilterName: passthrough
** FilterPattern: ""
** FirehoseRole: fluencyFireHoseToS3
** LogGroup:
** S3Bucket: {yourcompany}-fluency-cloudwatch-firehose

### Step 3: enable event notification on the S3 bucket and setup assumed role

### Step 4: Install AWSCloudWatch application template

For this example, we use the application template AWSCloudWatchLogGroupS3, which is configured with a event parser for AWS VPC network flow logs.

```bash
ingext application install --app AWSCloudWatchLogGroupS3 \
  --instance $name \
  --config Region="$AWS_REGION" \
  --config SQS_URL="$SQS_URL" \
  --config AWS_Role="$INGEXT_ROLE"
```

## Import AWS CloudTrail events

### create a trail with a S3 bucket. Make sure "Log file SSE-KMS encryption" is disabled.

### enable event notification on the S3 bucket

### Install AWSCloudTrail application template

```bash
ingext application install --app AWSCloudTrail \
  --instance $name \
  --config Region="$AWS_REGION" \
  --config SQS_URL="$SQS_URL" \
  --config AWS_Role="$INGEXT_ROLE"
```
