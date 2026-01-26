import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ITask, TaskContext, ResourceRecord } from './types';
import { IamRoleSetupTask } from './IamRoleSetupTask';

// Helper: Get local profile from kubectl context (Previous Step)
function getLocalIngextProfile(): string {
  try {
    const currentContext = execSync('kubectl config current-context').toString().trim();
    const user = execSync(`kubectl config view -o jsonpath='{.contexts[?(@.name=="${currentContext}")].context.user}'`).toString().trim();
    const userConfig = execSync(`kubectl config view -o jsonpath='{.users[?(@.name=="${user}")].user.exec}'`).toString().trim();

    const profileArgMatch = userConfig.match(/--profile["\s]+([a-zA-Z0-9_\-]+)/);
    if (profileArgMatch) return profileArgMatch[1];

    const envMatch = userConfig.match(/"name":"AWS_PROFILE","value":"([a-zA-Z0-9_\-]+)"/);
    if (envMatch) return envMatch[1];
    
    return 'default';
  } catch (e) {
    console.warn("Could not determine local profile from kubectl, defaulting to 'default'");
    return 'default';
  }
}

export class S3NotificationTask implements ITask {
  name = "Configure S3 Notification & Access Role";
  description = "Sets up SQS, S3 Events, and IAM Roles for Ingext";

  async validate(ctx: TaskContext): Promise<boolean> {
    if (!ctx.userInputs.bucketName || !ctx.userInputs.region) {
      console.error("Missing required inputs: bucketName or region");
      return false;
    }
    // Validation: Check if other scripts exist (we removed s3_bucket_notify_setup.sh dependency)
    /*
    const requiredScripts = [
      'scripts/aws/internal-role_setup.sh',
      'scripts/aws/external-role_setup.sh'
    ];
    for (const script of requiredScripts) {
      if (!fs.existsSync(script)) {
        console.error(`Missing script: ${script}`);
        return false;
      }
      try { execSync(`chmod +x ${script}`); } catch (e) {}
    }*/
    return true;
  }

  async execute(ctx: TaskContext): Promise<ResourceRecord> {
    const localProfile = getLocalIngextProfile();
    const remoteProfile = ctx.userInputs.remoteProfile || localProfile;
    const bucket = ctx.userInputs.bucketName;
    const region = ctx.userInputs.region;
    const prefix = ctx.userInputs.prefix ? ctx.userInputs.prefix.replace(/^\//, '') : ""; // Clean prefix
    const queueName = ctx.userInputs.queueName || `${bucket}-notify`;
    
    // Track resources created *during* this execution for immediate cleanup on error
    let createdQueueUrl: string | null = null;
    let s3NotificationConfigured = false;

    console.log(`[TASK] Local Profile: ${localProfile} | Remote Profile: ${remoteProfile}`);

    try {
      // --- STEP 1: NATIVE TYPESCRIPT IMPLEMENTATION OF S3/SQS SETUP ---
      console.log(`[STEP 1] Setting up S3 Notification & SQS (Native TS)...`);

      // A. Get Account ID (needed for policy generation)
      //
      const accountId = execSync(`aws sts get-caller-identity --query Account --output text --profile ${remoteProfile}`).toString().trim();

      // B. Create SQS Queue
      //
      console.log(`   Creating Queue: ${queueName}`);
      createdQueueUrl = execSync(
        `aws sqs create-queue --queue-name ${queueName} --region ${region} --profile ${remoteProfile} --query QueueUrl --output text`
      ).toString().trim();
      
      const queueArn = execSync(
        `aws sqs get-queue-attributes --queue-url ${createdQueueUrl} --attribute-names QueueArn --region ${region} --profile ${remoteProfile} --query Attributes.QueueArn --output text`
      ).toString().trim();

      console.log(`   Queue Created: ${queueArn}`);

      // C. Set SQS Access Policy (Allow S3 to SendMessage)
      //
      const sqsPolicy = {
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "s3.amazonaws.com" },
          Action: "sqs:SendMessage",
          Resource: queueArn,
          Condition: {
            ArnEquals: { "aws:SourceArn": `arn:aws:s3:::${bucket}` }
          }
        }]
      };

      // We must stringify twice or escape for the CLI command 'Policy' attribute
      // Using a temp file is safer for complex JSON passing to CLI
      const sqsAttribsFile = path.join('/tmp', `sqs-attr-${Date.now()}.json`);
      fs.writeFileSync(sqsAttribsFile, JSON.stringify({ Policy: JSON.stringify(sqsPolicy) }));
      
      execSync(`aws sqs set-queue-attributes --queue-url ${createdQueueUrl} --attributes file://${sqsAttribsFile} --region ${region} --profile ${remoteProfile}`);
      fs.unlinkSync(sqsAttribsFile);

      // D. Configure S3 Bucket Notifications
      //
      console.log(`   Wiring S3 Bucket Notification...`);
      const filterConfig = prefix ? {
        Filter: { Key: { FilterRules: [{ Name: "prefix", Value: prefix }] } }
      } : {};

      const notifyConfig = {
        QueueConfigurations: [{
          QueueArn: queueArn,
          Events: ["s3:ObjectCreated:*"],
          ...filterConfig
        }]
      };

      const s3ConfigFile = path.join('/tmp', `s3-conf-${Date.now()}.json`);
      fs.writeFileSync(s3ConfigFile, JSON.stringify(notifyConfig));

      execSync(`aws s3api put-bucket-notification-configuration --bucket ${bucket} --notification-configuration file://${s3ConfigFile} --region ${region} --profile ${remoteProfile}`);
      fs.unlinkSync(s3ConfigFile);
      s3NotificationConfigured = true;

      // E. Generate Consumer Policy JSON (The Output)
      //
      const s3Resource = prefix ? `arn:aws:s3:::${bucket}/${prefix}*` : `arn:aws:s3:::${bucket}/*`;
      
      const consumerPolicy = {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "S3Access",
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:ListBucket"],
            Resource: [`arn:aws:s3:::${bucket}`, s3Resource]
          },
          {
            Sid: "SQSAccess",
            Effect: "Allow",
            Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueUrl", "sqs:GetQueueAttributes"],
            Resource: queueArn
          }
        ]
      };
      
      const policyJson = JSON.stringify(consumerPolicy);

      // --- STEP 2: IAM ROLE SETUP (Using existing shell scripts) ---
      console.log(`[STEP 2] Setting up IAM Roles...`);
      /*
      const targetRoleName = `Ingext-${bucket}-AccessRole`;
      const tempPolicyFile = path.join('/tmp', `policy-${Date.now()}.json`);
      fs.writeFileSync(tempPolicyFile, policyJson);

      let roleSetupOutput = "";
      try {
        const script = (localProfile === remoteProfile) 
          ? `scripts/aws/internal-role_setup.sh ${localProfile} ${targetRoleName} ${tempPolicyFile}`
          : `scripts/aws/external-role_setup.sh ${localProfile} ${remoteProfile} ${targetRoleName} ${tempPolicyFile}`;
          
        roleSetupOutput = execSync(script).toString();
        console.log(roleSetupOutput);
      } finally {
        if (fs.existsSync(tempPolicyFile)) fs.unlinkSync(tempPolicyFile);
      }*/
      const iamTask = new IamRoleSetupTask();

      // Inject the context needed for IAM
      const iamContext = {
        ...ctx,
        userInputs: {
          ...ctx.userInputs,
          targetRoleName: `Ingext-${bucket}-AccessRole`,
          policyJson: policyJson // The JSON generated in Step 1
        } 
      };

      // Execute IAM Setup
      const iamRecord = await iamTask.execute(iamContext);

      // --- STEP 3: PREPARE RECORD ---
      //const roleArnMatch = roleSetupOutput.match(/Target Role ARN:\s*(\S+)/);
      //const roleArn = roleArnMatch ? roleArnMatch[1] : `arn:aws:iam::UNKNOWN:role/${targetRoleName}`;

      return {
        id: `${bucket}-config`,
        type: "Ingext_S3_DataSource",
        details: {
          bucketName: bucket,
          region: region,
          queueName: queueName,
          queueUrl: createdQueueUrl, // Use the URL we captured
          targetRoleName: iamRecord.targetRoleName,
          targetRoleArn: iamRecord.targetRoleArn,
          remoteProfile: remoteProfile,
          localProfile: localProfile
        },
        timestamp: Date.now()
      };

    } catch (error: any) {
      console.error(`\n[ERROR] Task Execution Failed: ${error.message}`);
      
      // --- IMMEDIATE LOCAL CLEANUP ---
      // If we failed halfway, we must clean up what we just created because
      // the TransactionManager won't know about it yet (since we throw before returning a Record).
      console.log("!!! Performing Immediate Cleanup of Partial Resources !!!");

      if (s3NotificationConfigured) {
        console.log(` -> Reverting S3 Notification on ${bucket}`);
        try {
          execSync(`aws s3api put-bucket-notification-configuration --bucket ${bucket} --notification-configuration "{}" --region ${region} --profile ${remoteProfile}`);
        } catch (e) { console.warn("   Failed to revert S3 config"); }
      }

      if (createdQueueUrl) {
        console.log(` -> Deleting SQS Queue: ${createdQueueUrl}`);
        try {
          execSync(`aws sqs delete-queue --queue-url ${createdQueueUrl} --region ${region} --profile ${remoteProfile}`);
        } catch (e) { console.warn("   Failed to delete queue"); }
      }

      throw error; // Re-throw so the Agent knows the task failed
    }
  }

  // --- FULL ROLLBACK (Called if a LATER task fails) ---
  async rollback(record: ResourceRecord, ctx: TaskContext): Promise<void> {
    const { 
        bucketName, region, queueUrl, targetRoleName, 
        remoteProfile, localProfile, targetRoleArn 
    } = record.details;

    console.log(`[ROLLBACK] Cleaning up Ingext Data Source for bucket: ${bucketName}`);

    // 1. Unregister
    try {
        const accountId = targetRoleArn.split(':')[4];
        const registrationName = `${accountId}:${targetRoleName}`;
        execSync(`ingext eks remove-assumed-role --name "${registrationName}"`, { stdio: 'ignore' });
    } catch (e) {}

    // 2. Cleanup Remote Role
    try {
        execSync(`aws iam delete-role-policy --role-name ${targetRoleName} --policy-name ${targetRoleName}-Permissions --profile ${remoteProfile}`);
        execSync(`aws iam delete-role --role-name ${targetRoleName} --profile ${remoteProfile}`);
    } catch (e) {}

    // 3. Cleanup Local Pod Role Policy
    try {
        const podRole = execSync(`ingext eks get-pod-role`).toString().trim();
        execSync(`aws iam delete-role-policy --role-name ${podRole} --policy-name "AllowAssume-${targetRoleName}" --profile ${localProfile}`);
    } catch (e) {}

    // 4. Cleanup S3 & SQS
    try {
        execSync(`aws s3api put-bucket-notification-configuration --bucket ${bucketName} --notification-configuration "{}" --region ${region} --profile ${remoteProfile}`);
    } catch (e) {}

    if (queueUrl) {
        try {
            execSync(`aws sqs delete-queue --queue-url ${queueUrl} --region ${region} --profile ${remoteProfile}`);
        } catch (e) {}
    }
  }
}
