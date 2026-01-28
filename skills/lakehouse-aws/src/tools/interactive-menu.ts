import { inferState, formatStateDescription } from "./state-inference.js";
import { createInterface } from "node:readline";

/**
 * Show interactive menu for lakehouse operations
 */
export async function showInteractiveMenu(
  env: Record<string, string>,
  namespace: string
): Promise<string> {
  const state = await inferState(env);
  
  console.error("=".repeat(60));
  console.error("Ingext Lakehouse (AWS)");
  console.error("=".repeat(60));
  console.error("");
  console.error(`Config: lakehouse_${namespace}.env`);
  console.error(`Cluster: ${env.CLUSTER_NAME}`);
  console.error(`Region: ${env.AWS_REGION}`);
  console.error("");
  
  // Show current state
  console.error("Current Status:");
  console.error(`  ${formatStateDescription(state.state)}`);
  
  // Show evidence summary
  if (state.evidence.clusterExists) {
    console.error(`  Cluster: ${state.evidence.clusterStatus}`);
    if (state.evidence.helmReleases.length > 0) {
      console.error(`  Releases: ${state.evidence.helmReleases.length} deployed`);
    }
    if (state.evidence.podsTotal > 0) {
      console.error(`  Pods: ${state.evidence.podsReady}/${state.evidence.podsTotal} ready`);
    }
  }
  
  console.error("");
  
  // Show recommendation
  console.error("Recommended Action:");
  console.error(`  ${state.recommendation.action}: ${state.recommendation.reason}`);
  console.error(`  Command: ${state.recommendation.command}`);
  console.error("");
  
  // Show menu
  console.error("Available Actions:");
  console.error("  1) Install (continue from current phase)");
  console.error("  2) Status (detailed view)");
  console.error("  3) Diagnose (AI-powered diagnostics)");
  console.error("  4) Logs (view component logs)");
  console.error("  5) Skills (list all skills and what they do)");
  console.error("  6) Cleanup (tear down)");
  console.error("  q) Quit");
  console.error("");
  
  const choice = await prompt("Select action [1]: ");
  return choice || "1";
}

/**
 * Prompt user for input using readline
 */
export async function prompt(message: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompt user to select from multiple env files
 */
export async function selectEnvPrompt(namespaces: string[]): Promise<string> {
  console.error("\nMultiple lakehouse configurations found:");
  console.error("");
  
  namespaces.forEach((ns, idx) => {
    console.error(`  ${idx + 1}) ${ns}`);
  });
  
  console.error("");
  const choice = await prompt(`Select configuration [1]: `);
  
  const index = parseInt(choice || "1", 10) - 1;
  
  if (index >= 0 && index < namespaces.length) {
    return namespaces[index];
  }
  
  // Default to first
  return namespaces[0];
}

/**
 * Run interactive wizard for preflight inputs
 */
export async function execPreflightWizard(
  env: Record<string, string>,
  args: Record<string, any>
): Promise<any> {
  console.error("\n" + "=".repeat(60));
  console.error("Ingext Lakehouse Preflight Wizard");
  console.error("=".repeat(60));
  console.error("This wizard will help you configure your AWS Lakehouse deployment.\n");

  // 1) AWS Profile Selection
  const { listProfiles, getCallerIdentity } = await import("./aws.js");
  const profiles = await listProfiles();
  let awsProfile = args["profile"] || env.AWS_PROFILE || "default";

  if (profiles.length > 0) {
    console.error("Available AWS profiles:");
    profiles.forEach(p => console.error(`  - ${p}`));
    console.error("");
    const chosenProfile = await prompt(`Which AWS Profile would you like to use? [${awsProfile}]: `);
    if (chosenProfile) awsProfile = chosenProfile;
  }

  // Verify identity and get Account ID for S3 bucket default
  console.error(`\nChecking authentication for profile '${awsProfile}'...`);
  const ident = await getCallerIdentity(awsProfile, args["region"] || env.AWS_REGION || "us-east-2");
  let accountId = "ACCOUNT_ID";
  if (ident.ok) {
    accountId = ident.accountId;
    console.error(`✓ Authenticated as AWS Account: ${accountId}`);
  } else {
    console.error(`⚠️  Warning: Could not verify AWS identity: ${ident.error}`);
    console.error("   Preflight will continue, but technical checks may fail.");
  }

  // 2) Collect inputs
  const awsRegion = await prompt(`AWS Region [${args["region"] || env.AWS_REGION || "us-east-2"}]: `) || args["region"] || env.AWS_REGION || "us-east-2";
  
  const clusterNameRaw = await prompt(`EKS Cluster Name [${args["cluster"] || env.CLUSTER_NAME || "ingext-lakehouse"}]: `) || args["cluster"] || env.CLUSTER_NAME || "ingext-lakehouse";
  const clusterName = clusterNameRaw.toLowerCase().replace(/[^a-z0-9]/g, "");

  const s3BucketDefault = args["bucket"] || env.S3_BUCKET || `ingext-lakehouse-${accountId}`;
  const s3BucketRaw = await prompt(`S3 Bucket Name (for Datalake) [${s3BucketDefault}]: `) || s3BucketDefault;
  const s3Bucket = s3BucketRaw.toLowerCase().replace(/[^a-z0-9]/g, "");

  const rootDomainDefault = args["root-domain"] || env.ROOT_DOMAIN || "ingext.io";
  const rootDomain = await prompt(`Root Domain (e.g., example.com) [${rootDomainDefault}]: `) || rootDomainDefault;

  const siteDomainDefault = args["domain"] || env.SITE_DOMAIN || `lakehouse.k8.${rootDomain}`;
  const siteDomain = await prompt(`Public Domain [${siteDomainDefault}]: `) || siteDomainDefault;

  const namespaceRaw = await prompt(`Kubernetes Namespace [${args["namespace"] || env.NAMESPACE || "ingext"}]: `) || args["namespace"] || env.NAMESPACE || "ingext";
  const namespace = namespaceRaw.toLowerCase().replace(/[^a-z0-9]/g, "");

  console.error("\nDNS & Certificate Management:");
  const useAwsDnsStr = await prompt("Use AWS Route53 for DNS hosting? [yes/no] (yes): ") || "yes";
  const useAwsDns = useAwsDnsStr.toLowerCase().startsWith("y");

  const useAwsCertStr = await prompt("Use AWS ACM for SSL certificates? [yes/no] (yes): ") || "yes";
  const useAwsCert = useAwsCertStr.toLowerCase().startsWith("y");

  let certArn = args["cert-arn"] || env.CERT_ARN || "";

  if (useAwsCert) {
    const { findCertificatesForDomain } = await import("./acm.js");
    console.error(`\nSearching for existing ACM certificates for ${siteDomain}...`);
    const certsResult = await findCertificatesForDomain(siteDomain, awsRegion);
    
    if (certsResult.ok && certsResult.matches && certsResult.matches.length > 0) {
      console.error(`\nFound ${certsResult.matches.length} matching certificate(s):`);
      certsResult.matches.forEach((c, idx) => {
        const type = c.wildcard ? "Wildcard" : "Exact match";
        console.error(`  ${idx + 1}) ${c.domain} (${type})`);
        console.error(`     ARN: ${c.arn}`);
      });
      console.error("");
      
      const certChoice = await prompt(`Use the first certificate found? [Y/n]: `);
      if (certChoice.toLowerCase() !== "n") {
        certArn = certsResult.matches[0].arn;
        console.error(`✓ Selected: ${certArn}`);
      } else {
        const manualCert = await prompt(`Enter ACM Certificate ARN [${certArn || "None"}]: `);
        if (manualCert) certArn = manualCert;
      }
    } else {
      console.error("ℹ️  No matching ACM certificates found.");
      const manualCert = await prompt(`Enter ACM Certificate ARN (Required for HTTPS) [${certArn || "None"}]: `);
      if (manualCert) certArn = manualCert;
    }
  } else {
    console.error("\nℹ️  Non-AWS certificates selected.");
    console.error("   You will need to manually configure certificates in Phase 7.");
    console.error("   Common options: cert-manager, external-dns, or a pivot tunnel.");
    certArn = "EXTERNAL";
  }

  console.error("\nNode Recommendations:");
  console.error("  - m5a.large (AMD EPYC) - Recommended for general purpose");
  console.error("  - t3.large (Intel)     - Cost-effective for testing");
  const nodeType = await prompt(`Primary Node Instance Type [${args["node-type"] || env.NODE_TYPE || "t3.large"}]: `) || args["node-type"] || env.NODE_TYPE || "t3.large";
  const nodeCount = await prompt(`Initial Node Count [${args["node-count"] || env.NODE_COUNT || "2"}]: `) || args["node-count"] || env.NODE_COUNT || "2";

  console.error("\nReadiness Checklist:");
  const hasBillingStr = await prompt("Do you have active billing enabled? [yes/no] (yes): ") || "yes";
  const hasAdminStr = await prompt("Do you have AdministratorAccess to create IAM, VPC, EKS? [yes/no] (yes): ") || "yes";
  const hasDnsStr = await prompt(`Do you control DNS for '${siteDomain}'? [yes/no] (yes): `) || "yes";

  return {
    awsProfile,
    awsRegion,
    clusterName,
    s3Bucket,
    rootDomain,
    siteDomain,
    certArn,
    namespace,
    nodeType,
    nodeCount,
    useAwsDns,
    useAwsCert,
    readiness: {
      hasBilling: hasBillingStr.toLowerCase().startsWith("y"),
      hasAdmin: hasAdminStr.toLowerCase().startsWith("y"),
      hasDns: hasDnsStr.toLowerCase().startsWith("y"),
    },
    execMode: args["exec"] || "local",
    writeEnvFile: true,
    dnsCheck: true,
  };
}

/**
 * Show first-time setup guidance
 */
export async function showFirstTimeSetup(): Promise<boolean> {
  console.error("=".repeat(60));
  console.error("Welcome to Ingext Lakehouse (AWS)");
  console.error("=".repeat(60));
  console.error("");
  console.error("No lakehouse configuration found.");
  console.error("");
  console.error("This appears to be your first time setting up a lakehouse.");
  console.error("");
  console.error("Next step: Preflight");
  console.error("  Preflight will gather your AWS/cluster config and validate");
  console.error("  prerequisites before installation.");
  console.error("");
  
  const choice = await prompt("Run preflight now? [Y/n] ");
  return choice.toLowerCase() !== "n";
}
