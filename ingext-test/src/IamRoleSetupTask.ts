import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { ITask, TaskContext, ResourceRecord } from '../../../types'; // Adjust path as needed

export class IamRoleSetupTask implements ITask {
  name = "Setup IAM Role Chain";
  description = "Configures IAM Roles (Internal or Cross-Account) and registers with Ingext";

  async validate(ctx: TaskContext): Promise<boolean> {
    const { targetRoleName, policyJson } = ctx.userInputs;
    
    if (!targetRoleName || !policyJson) {
      console.error("Missing required inputs: targetRoleName or policyJson");
      return false;
    }

    // Regex validation from original script
    if (!/^[a-zA-Z0-9_+=,.@-]{1,64}$/.test(targetRoleName)) {
      console.error(`Invalid Role Name: ${targetRoleName}`);
      return false;
    }

    // Verify Ingext CLI is available
    try { execSync('ingext --version', { stdio: 'ignore' }); } 
    catch { console.error("ingext CLI not found"); return false; }

    return true;
  }

  async execute(ctx: TaskContext): Promise<ResourceRecord> {
    const { 
      targetRoleName, 
      policyJson, 
      localProfile = 'default', 
      remoteProfile = 'default' 
    } = ctx.userInputs;

    console.log(`[IAM] Setting up role '${targetRoleName}' (Local: ${localProfile}, Remote: ${remoteProfile})`);

    // 1. Identify Identities
    const localAccountId = this.getAccountId(localProfile);
    const remoteAccountId = this.getAccountId(remoteProfile);
    const podRoleName = this.getPodRoleName();

    console.log(`   Local Account: ${localAccountId} | Remote Account: ${remoteAccountId}`);
    console.log(`   Pod Role: ${podRoleName}`);

    // 2. Construct ARNs
    // The "Principal" is always the Pod Role (Source).
    // If different accounts, we MUST use the full ARN. If same, we can use ARN or relative (ARN is safer).
    const podRoleArn = `arn:aws:iam::${localAccountId}:role/${podRoleName}`;
    const targetRoleArn = `arn:aws:iam::${remoteAccountId}:role/${targetRoleName}`;

    // 3. TARGET SIDE: Create/Update the Service Role
    let roleWasCreated = false;
    
    // Check if exists
    if (!this.roleExists(targetRoleName, remoteProfile)) {
      console.log(`   Role '${targetRoleName}' does not exist. Creating...`);
      
      // Strategy: Create with a safe "Root" trust policy first to avoid Principal errors
      const placeholderTrust = {
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${remoteAccountId}:root` },
            Action: "sts:AssumeRole"
        }]
      };
      
      this.createRole(targetRoleName, placeholderTrust, remoteProfile);
      roleWasCreated = true;
      
      // Wait for propagation
      console.log("   Waiting for role propagation...");
      execSync(`aws iam wait role-exists --role-name ${targetRoleName} --profile ${remoteProfile}`);
    } else {
      console.log(`   Role '${targetRoleName}' exists. Updating...`);
    }

    // Update Trust Policy to the REAL Trust (The Pod Role)
    console.log("   Updating Trust Policy...");
    const realTrustPolicy = {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Principal: { AWS: podRoleArn },
        Action: ["sts:AssumeRole", "sts:TagSession"]
      }]
    };
    this.updateTrustPolicy(targetRoleName, realTrustPolicy, remoteProfile);

    // Attach Permissions (The actual S3/SQS access)
    console.log("   Attaching Permissions Policy...");
    this.putRolePolicy(targetRoleName, `${targetRoleName}-Permissions`, policyJson, remoteProfile);

    // 4. SOURCE SIDE: Authorize Pod Role to Assume Target
    console.log(`   Authorizing Pod Role (${podRoleName}) to assume Target...`);
    const assumePolicy = {
      Version: "2012-10-17",
      Statement: [{
        Effect: "Allow",
        Action: ["sts:AssumeRole", "sts:TagSession"],
        Resource: targetRoleArn
      }]
    };
    this.putRolePolicy(podRoleName, `AllowAssume-${targetRoleName}`, JSON.stringify(assumePolicy), localProfile);

    // 5. VERIFICATION
    console.log("   Verifying connectivity via Ingext CLI...");
    // Sleep briefly for eventual consistency
    await new Promise(r => setTimeout(r, 5000));

    try {
      const testResult = execSync(`ingext eks test-assumed-role --roleArn "${targetRoleArn}"`).toString().trim();
      if (testResult !== "OK") {
        throw new Error(`Verification Failed: ${testResult}`);
      }
      console.log("   Verification Successful: OK");
    } catch (e: any) {
      throw new Error(`Connectivity Test Failed: ${e.message}`);
    }

    // 6. REGISTRATION
    // Only register if we created it OR if forced (logic from script says 'only if newly created', 
    // but in an agentic idempotent flow, we might want to check if registered. 
    // For now, we follow the script logic: if roleWasCreated is true).
    
    // Note: You might want to always ensure registration in a declarative model.
    if (roleWasCreated) {
        console.log("   Registering with Ingext...");
        const regName = `${remoteAccountId}:${targetRoleName}`;
        try {
            const output = execSync(
                `ingext eks add-assumed-role --name "${regName}" --roleArn "${targetRoleArn}"`
            ).toString();
            console.log(`   Registration Output: ${output}`);
        } catch (e: any) {
             console.warn(`   Registration Warning: ${e.message}`);
        }
    } else {
        console.log("   Role pre-existed. Skipping registration (idempotency).");
    }

    return {
      id: targetRoleName,
      type: "Ingext_IAM_Chain",
      details: {
        targetRoleName,
        targetRoleArn,
        podRoleName,
        localProfile,
        remoteProfile,
        permissionsPolicyName: `${targetRoleName}-Permissions`,
        assumePolicyName: `AllowAssume-${targetRoleName}`,
        registrationName: `${remoteAccountId}:${targetRoleName}`
      },
      timestamp: Date.now()
    };
  }

  // --- ROLLBACK LOGIC ---
  async rollback(record: ResourceRecord, ctx: TaskContext): Promise<void> {
    const d = record.details;
    console.log(`[ROLLBACK] Cleaning up IAM Chain: ${d.targetRoleName}`);

    // 1. Unregister
    try {
        execSync(`ingext eks remove-assumed-role --name "${d.registrationName}"`, { stdio: 'ignore' });
    } catch (e) {}

    // 2. Remove Source Policy (Pod Role)
    try {
        console.log(`   Removing policy from Pod Role: ${d.podRoleName}`);
        execSync(`aws iam delete-role-policy --role-name ${d.podRoleName} --policy-name ${d.assumePolicyName} --profile ${d.localProfile}`);
    } catch (e) {}

    // 3. Remove Target Role & Policies
    try {
        console.log(`   Removing Target Role: ${d.targetRoleName}`);
        execSync(`aws iam delete-role-policy --role-name ${d.targetRoleName} --policy-name ${d.permissionsPolicyName} --profile ${d.remoteProfile}`);
        execSync(`aws iam delete-role --role-name ${d.targetRoleName} --profile ${d.remoteProfile}`);
    } catch (e) {
        console.warn(`   Cleanup warning: ${e.message}`);
    }
  }

  // --- HELPERS (Private) ---

  private getAccountId(profile: string): string {
    return execSync(`aws sts get-caller-identity --query Account --output text --profile ${profile}`).toString().trim();
  }

  private getPodRoleName(): string {
    return execSync(`ingext eks get-pod-role`).toString().trim();
  }

  private roleExists(roleName: string, profile: string): boolean {
    try {
      execSync(`aws iam get-role --role-name ${roleName} --profile ${profile}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private createRole(roleName: string, trustPolicy: any, profile: string) {
    const file = this.writeTempJson(trustPolicy);
    try {
        execSync(`aws iam create-role --role-name ${roleName} --assume-role-policy-document file://${file} --profile ${profile}`);
    } finally {
        fs.unlinkSync(file);
    }
  }

  private updateTrustPolicy(roleName: string, trustPolicy: any, profile: string) {
    const file = this.writeTempJson(trustPolicy);
    try {
        execSync(`aws iam update-assume-role-policy --role-name ${roleName} --policy-document file://${file} --profile ${profile}`);
    } finally {
        fs.unlinkSync(file);
    }
  }

  private putRolePolicy(roleName: string, policyName: string, policyJson: string, profile: string) {
    // Check if policyJson is object or string
    const content = (typeof policyJson === 'string') ? policyJson : JSON.stringify(policyJson);
    const file = this.writeTempJson(JSON.parse(content)); // parse/stringify ensures clean format
    try {
        execSync(`aws iam put-role-policy --role-name ${roleName} --policy-name ${policyName} --policy-document file://${file} --profile ${profile}`);
    } finally {
        fs.unlinkSync(file);
    }
  }

  private writeTempJson(obj: any): string {
    const tmpPath = path.join('/tmp', `iam-${Date.now()}-${Math.floor(Math.random() * 1000)}.json`);
    fs.writeFileSync(tmpPath, JSON.stringify(obj));
    return tmpPath;
  }
}
