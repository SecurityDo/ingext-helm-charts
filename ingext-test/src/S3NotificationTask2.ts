import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ITask, TaskContext, ResourceRecord } from './types';


function getLocalIngextProfile(): string {
  try {
    // 1. Get the current context name
    // e.g., "arn:aws:eks:us-east-1:123456789012:cluster/my-cluster"
    const currentContext = execSync('kubectl config current-context').toString().trim();
    
    // 2. Get the "user" associated with this context
    // JSONPath query to find the user name for the current context
    const user = execSync(
      `kubectl config view -o jsonpath='{.contexts[?(@.name=="${currentContext}")].context.user}'`
    ).toString().trim();

    // 3. Extract the AWS_PROFILE environment variable or arg from the user's exec config
    // This looks for the "--profile" flag or "env" vars inside the user's exec configuration
    const userConfig = execSync(
        `kubectl config view -o jsonpath='{.users[?(@.name=="${user}")].user.exec}'`
    ).toString().trim();

    // Parse the JSON output from kubectl (it returns a stringified JSON object for the 'exec' block)
    // Note: kubectl output might need parsing if it returns complex structures, 
    // but often we can just regex the raw string output for robustness against formatting.
    
    // Check for explicit --profile arg
    const profileArgMatch = userConfig.match(/--profile["\s]+([a-zA-Z0-9_\-]+)/);
    if (profileArgMatch) return profileArgMatch[1];

    // Check for env variable AWS_PROFILE
    const envMatch = userConfig.match(/"name":"AWS_PROFILE","value":"([a-zA-Z0-9_\-]+)"/);
    if (envMatch) return envMatch[1];
    
    // If we found a context but no specific profile, it usually implies 'default'
    return 'default';

  } catch (e) {
    console.warn("Could not determine local profile from kubectl context, defaulting to 'default'");
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
    
    // Check if scripts exist
    const requiredScripts = [
      'scripts/aws/s3_bucket_notify_setup.sh',
      'scripts/aws/internal-role_setup.sh',
      'scripts/aws/external-role_setup.sh'
    ];
    
    for (const script of requiredScripts) {
      if (!fs.existsSync(script)) {
        console.error(`Missing script: ${script}`);
        return false;
      }
      // Ensure executable
      try { execSync(`chmod +x ${script}`); } catch (e) {}
    }
    
    return true;
  }

  async execute(ctx: TaskContext): Promise<ResourceRecord> {
    const localProfile = getLocalIngextProfile();
    const remoteProfile = ctx.userInputs.remoteProfile || localProfile;
    const bucket = ctx.userInputs.bucketName;
    const region = ctx.userInputs.region;
    const prefix = ctx.userInputs.prefix || ""; 
    const queueName = ctx.userInputs.queueName || `${bucket}-notify`;
    const targetRoleName = `Ingext-${bucket}-AccessRole`;

    console.log(`[TASK] Local Profile: ${localProfile} | Remote Profile: ${remoteProfile}`);

    // --- STEP 1: S3 Notification & SQS Setup ---
    console.log(`[STEP 1] Setting up S3 Notification & SQS...`);
    
    // We capture stdout because the script outputs the Policy JSON
    const s3Script = `scripts/aws/s3_bucket_notify_setup.sh ${remoteProfile} ${region} ${bucket} "${prefix}" ${queueName}`;
    let policyJson = "";
    
    try {
      policyJson = execSync(s3Script).toString().trim();
      // Clean up any extraneous log lines if the script outputs them to stdout instead of stderr
      const jsonStart = policyJson.indexOf('{');
      if (jsonStart > -1) policyJson = policyJson.substring(jsonStart);
    } catch (error: any) {
      throw new Error(`S3 Setup Failed: ${error.message}`);
    }

    if (!policyJson.startsWith("{")) {
        console.error("Invalid Output:", policyJson);
        throw new Error("Step 1 did not return valid JSON policy.");
    }

    // --- STEP 2: IAM Role Setup ---
    console.log(`[STEP 2] Setting up IAM Roles...`);
    
    const tempPolicyFile = path.join('/tmp', `policy-${Date.now()}.json`);
    fs.writeFileSync(tempPolicyFile, policyJson);

    let roleSetupOutput = "";
    let setupScriptCmd = "";

    try {
        if (localProfile === remoteProfile) {
            console.log("--> Detected SAME Account (Internal Setup)");
            setupScriptCmd = `scripts/aws/internal-role_setup.sh ${localProfile} ${targetRoleName} ${tempPolicyFile}`;
        } else {
            console.log("--> Detected CROSS Account (External Setup)");
            setupScriptCmd = `scripts/aws/external-role_setup.sh ${localProfile} ${remoteProfile} ${targetRoleName} ${tempPolicyFile}`;
        }

        roleSetupOutput = execSync(setupScriptCmd).toString();
        console.log(roleSetupOutput);

    } catch (error: any) {
        throw new Error(`Role Setup Failed: ${error.message}`);
    } finally {
        if (fs.existsSync(tempPolicyFile)) fs.unlinkSync(tempPolicyFile);
    }

    // --- Extract Data ---
    const queueUrl = execSync(
        `aws sqs get-queue-url --queue-name ${queueName} --profile ${remoteProfile} --region ${region} --output text`
    ).toString().trim();
    
    const roleArnMatch = roleSetupOutput.match(/Target Role ARN:\s*(\S+)/);
    const roleArn = roleArnMatch ? roleArnMatch[1] : `arn:aws:iam::UNKNOWN:role/${targetRoleName}`;

    return {
      id: `${bucket}-config`,
      type: "Ingext_S3_DataSource",
      details: {
        bucketName: bucket,
        region: region,
        queueName: queueName,
        queueUrl: queueUrl,
        targetRoleName: targetRoleName,
        targetRoleArn: roleArn,
        remoteProfile: remoteProfile,
        localProfile: localProfile,
        isCrossAccount: localProfile !== remoteProfile
      },
      timestamp: Date.now()
    };
  }

  async rollback(record: ResourceRecord, ctx: TaskContext): Promise<void> {
    // (Rollback logic omitted for brevity in test runner, but you can paste the previous code here)
    console.log("Rollback called for:", record.id);
  }
}
