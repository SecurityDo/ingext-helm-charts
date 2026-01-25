#!/usr/bin/env node

import { discoverEnvFiles, readEnvFile } from "../src/tools/file.js";
import { inferState } from "../src/tools/state-inference.js";
import { showInteractiveMenu, selectEnvPrompt, showFirstTimeSetup } from "../src/tools/interactive-menu.js";
import { showHelp } from "../src/tools/help.js";
import { runPreflight } from "../src/skill.js";
import { runInstall } from "../src/install.js";
import { runStatus } from "../src/status.js";
import { runCleanup } from "../src/cleanup.js";
import { setExecMode } from "../src/tools/shell.js";
import { PreflightInputSchema } from "../src/schema.js";

/**
 * Parse command line arguments
 */
function parseArgs(argv: string[]): Record<string, any> {
  const out: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    out[key] = val;
  }
  return out;
}

/**
 * Execute a command with the given environment
 */
async function executeCommand(
  command: string,
  env: Record<string, string>,
  args: Record<string, any>
): Promise<number> {
  switch (command) {
    case "preflight":
      return await execPreflight(env, args);
    
    case "install":
      return await execInstall(env, args);
    
    case "status":
      return await execStatus(env, args);
    
    case "diagnose":
      // Future: AI-powered diagnostics
      console.error("AI diagnostics coming soon...");
      console.error("Running status check instead:\n");
      return await execStatus(env, args);
    
    case "logs":
      const component = process.argv[3] || "all";
      console.error(`Logs for component: ${component}`);
      console.error("Coming soon...");
      return 0;
    
    case "cleanup":
      return await execCleanup(env, args);
    
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run 'lakehouse help' for available commands");
      return 1;
  }
}

/**
 * Execute preflight command
 */
async function execPreflight(
  env: Record<string, string>,
  args: Record<string, any>
): Promise<number> {
  const raw = {
    awsProfile: args["profile"] || env.AWS_PROFILE || "default",
    awsRegion: args["region"] || env.AWS_REGION || "us-east-2",
    clusterName: args["cluster"] || env.CLUSTER_NAME || "ingext-lakehouse",
    s3Bucket: args["bucket"] || env.S3_BUCKET,
    rootDomain: args["root-domain"] || env.ROOT_DOMAIN,
    siteDomain: args["domain"] || env.SITE_DOMAIN,
    certArn: args["cert-arn"] || env.CERT_ARN,
    namespace: args["namespace"] || env.NAMESPACE || "ingext",
    nodeType: args["node-type"] || env.NODE_TYPE || "t3.xlarge",
    nodeCount: args["node-count"] || env.NODE_COUNT || "2",
    outputEnvPath: args["output-env"],
    writeEnvFile: args["write-env"] !== "false",
    overwriteEnv: args["overwrite-env"] === "true",
    dnsCheck: args["dns-check"] !== "false",
    approve: args["approve"] === "true",
    execMode: args["exec"] === "docker" ? "docker" : "local",
    readiness: {
      hasBilling: args["has-billing"] !== "false",
      hasAdmin: args["has-admin"] !== "false",
      hasDns: args["has-dns"] !== "false",
    },
  };

  setExecMode(raw.execMode as "docker" | "local");

  const input = PreflightInputSchema.parse(raw);
  console.error("\n⏳ Running preflight...");
  const result = await runPreflight(input);
  console.error("✓ Preflight completed");

  if (result.okToInstall) {
    console.error("\n✓ Preflight passed! Ready to install.");
    console.error(`\nNext step: lakehouse install`);
    return 0;
  } else {
    console.error("\n❌ Preflight found issues:");
    result.blockers.forEach(b => console.error(`  - ${b.message}`));
    if (result.remediation.length > 0) {
      console.error("\nRemediation:");
      result.remediation.forEach(r => console.error(`  ${r.message}`));
    }
    return 1;
  }
}

/**
 * Execute install command
 */
async function execInstall(
  env: Record<string, string>,
  args: Record<string, any>
): Promise<number> {
  const namespace = args["namespace"] || env.NAMESPACE || "ingext";
  const envFilePath = `./lakehouse_${namespace}.env`;

  // Check if env file exists
  const envFile = await readEnvFile(envFilePath);
  if (!envFile.ok || !envFile.env) {
    console.error(`❌ Error: No environment file found for namespace '${namespace}'.`);
    console.error(`   Expected: ${envFilePath}`);
    console.error(`   Run preflight first to generate the env file:`);
    console.error(`   lakehouse preflight --root-domain example.com`);
    return 1;
  }

  const execMode = args["exec"] === "docker" ? "docker" : "local";
  setExecMode(execMode as "docker" | "local");

  console.error("\n⏳ Running install...");
  const result = await runInstall(
    {
      approve: args["approve"] === "true",
      env: envFile.env,
      force: args["force"] === "true",
      namespace: namespace,
      envFile: envFilePath,
      verbose: args["verbose"] !== "false",
    },
    undefined
  );
  console.error("✓ Install completed");

  if (result.status === "completed_phase") {
    return 0;
  } else if (result.status === "error") {
    return 1;
  } else {
    return 2; // needs_input
  }
}

/**
 * Execute status command
 */
async function execStatus(
  env: Record<string, string>,
  args: Record<string, any>
): Promise<number> {
  const execMode = args["exec"] === "docker" ? "docker" : "local";
  setExecMode(execMode as "docker" | "local");

  const result = await runStatus({
    awsProfile: args["profile"] || env.AWS_PROFILE || "default",
    awsRegion: args["region"] || env.AWS_REGION || "us-east-2",
    clusterName: args["cluster"] || env.CLUSTER_NAME || "ingext-lakehouse",
    s3Bucket: args["bucket"] || env.S3_BUCKET,
    namespace: args["namespace"] || env.NAMESPACE || "ingext",
    rootDomain: args["root-domain"] || env.ROOT_DOMAIN,
    siteDomain: args["domain"] || env.SITE_DOMAIN,
    certArn: args["cert-arn"] || env.CERT_ARN,
  });

  // Format output (reuse formatting from run.ts)
  formatStatusOutput(result);

  if (args["json"] === "true") {
    console.log("\n" + JSON.stringify(result, null, 2));
  }

  return 0;
}

/**
 * Execute cleanup command
 */
async function execCleanup(
  env: Record<string, string>,
  args: Record<string, any>
): Promise<number> {
  const namespace = args["namespace"] || env.NAMESPACE || "ingext";
  const envFilePath = `./lakehouse_${namespace}.env`;

  // Check if env file exists
  const envFile = await readEnvFile(envFilePath);
  if (!envFile.ok || !envFile.env) {
    console.error(`❌ Error: No environment file found for namespace '${namespace}'.`);
    console.error(`   Expected: ${envFilePath}`);
    console.error(`   Cannot proceed without env file to know what to clean up.`);
    return 1;
  }

  const execMode = args["exec"] === "docker" ? "docker" : "local";
  setExecMode(execMode as "docker" | "local");

  console.error("\n⏳ Running cleanup...");
  const result = await runCleanup({
    awsProfile: args["profile"] || env.AWS_PROFILE || "default",
    awsRegion: args["region"] || env.AWS_REGION || "us-east-2",
    clusterName: args["cluster"] || env.CLUSTER_NAME || "",
    s3Bucket: args["bucket"] || env.S3_BUCKET,
    namespace: namespace,
    approve: args["approve"] === "true",
    envFile: envFilePath,
  });
  console.error("✓ Cleanup completed");

  if (result.status === "completed") {
    return 0;
  } else if (result.status === "error") {
    return 1;
  } else if (result.status === "needs_approval") {
    return 2;
  } else {
    return 3; // partial completion
  }
}

/**
 * Format status output (from run.ts)
 */
function formatStatusOutput(result: any) {
  const GREEN = "\x1b[0;32m";
  const YELLOW = "\x1b[1;33m";
  const RED = "\x1b[0;31m";
  const NC = "\x1b[0m";
  
  const getStatusColor = (status: string): string => {
    // Success states (green)
    if (status === "ACTIVE" || status === "Running" || status === "EXISTS" || status === "deployed" || 
        status === "Issued" || status === "Attached" || status === "Installed") {
      return `${GREEN}${status}${NC}`;
    } 
    // Warning/In-progress states (yellow)
    else if (status === "CREATING" || status === "PROVISIONING..." || status === "Pending" || 
             status === "PENDING_VALIDATION" || status === "Starting" || status === "Pending Validation") {
      return `${YELLOW}${status}${NC}`;
    } 
    // Error states (red)
    else {
      return `${RED}${status}${NC}`;
    }
  };

  console.log("");
  console.log("=".repeat(80));
  console.log(`Lakehouse Status: ${result.cluster.name}`);
  console.log("=".repeat(80));
  console.log(`${"COMPONENT".padEnd(45)} STATUS`);
  console.log("-".repeat(80));

  // Infrastructure
  const eksStatus = result.cluster.details?.eksStatus || result.cluster.status.toUpperCase();
  console.log(`${`EKS Cluster (${result.cluster.name})`.padEnd(45)} ${getStatusColor(eksStatus)}`);

  if (result.infrastructure.s3.bucketName) {
    const s3Status = result.infrastructure.s3.exists ? "EXISTS" : "NOT FOUND";
    console.log(`${`S3 Bucket (${result.infrastructure.s3.bucketName})`.padEnd(45)} ${getStatusColor(s3Status)}`);
  }

  // Core Services
  console.log("");
  console.log("[Core Services]");
  for (const comp of result.components.coreServices || []) {
    console.log(`  ${comp.displayName.padEnd(43)} ${getStatusColor(comp.status)}`);
  }

  // Stream Services
  console.log("");
  console.log("[Ingext Stream]");
  for (const comp of result.components.stream || []) {
    console.log(`  ${comp.displayName.padEnd(43)} ${getStatusColor(comp.status)}`);
  }

  // Datalake Services
  console.log("");
  console.log("[Ingext Datalake]");
  for (const comp of result.components.datalake || []) {
    console.log(`  ${comp.displayName.padEnd(43)} ${getStatusColor(comp.status)}`);
  }

  // Networking & SSL
  console.log("");
  console.log("[Networking & SSL]");
  
  if (result.networking.loadBalancer) {
    const lb = result.networking.loadBalancer;
    let ingressStatus = "NOT INSTALLED";
    
    if (lb.hostname) {
      ingressStatus = "Installed";
      console.log(`  ${"Ingress".padEnd(43)} ${GREEN}${ingressStatus}${NC}`);
    } else if (lb.status === "deployed") {
      ingressStatus = "PROVISIONING";
      console.log(`  ${"Ingress".padEnd(43)} ${YELLOW}${ingressStatus}${NC}`);
    } else {
      console.log(`  ${"Ingress".padEnd(43)} ${RED}${ingressStatus}${NC}`);
    }
  } else {
    console.log(`  ${"Ingress".padEnd(43)} ${RED}NOT INSTALLED${NC}`);
  }
  
  if (result.networking.loadBalancer) {
    const lb = result.networking.loadBalancer;
    if (lb.hostname) {
      console.log(`  ${"AWS Load Balancer".padEnd(43)} ${GREEN}${lb.hostname}${NC}`);
    } else if (lb.ip) {
      console.log(`  ${"AWS Load Balancer".padEnd(43)} ${GREEN}${lb.ip}${NC}`);
    } else {
      console.log(`  ${"AWS Load Balancer".padEnd(43)} ${YELLOW}PROVISIONING...${NC}`);
    }
  }

  if (result.networking.siteDomain) {
    console.log(`  ${"DNS Domain".padEnd(43)} ${result.networking.siteDomain}`);
  }

  if (result.infrastructure.certificate.acmStatus) {
    const certStatus = result.infrastructure.certificate.acmStatus === "ISSUED" 
      ? "Attached" 
      : result.infrastructure.certificate.acmStatus === "PENDING_VALIDATION"
      ? "Pending Validation"
      : result.infrastructure.certificate.acmStatus;
    console.log(`  ${"TLS Certificate".padEnd(43)} ${getStatusColor(certStatus)}`);
  }

  console.log("-".repeat(80));
  console.log(`Pod Summary: ${result.podSummary.running} running / ${result.podSummary.total} total`);
  
  // Show helm error if present
  if (result.helm?.error) {
    console.log("");
    console.log(`${YELLOW}⚠️  ${result.helm.error}${NC}`);
  }
  
  console.log("=".repeat(80));
  console.log("");
}

/**
 * Execute menu choice
 */
async function executeMenuChoice(choice: string, env: Record<string, string>, args: Record<string, any>): Promise<number> {
  switch (choice) {
    case "1":
      return await executeCommand("install", env, args);
    case "2":
      return await executeCommand("status", env, args);
    case "3":
      return await executeCommand("diagnose", env, args);
    case "4":
      return await executeCommand("logs", env, args);
    case "5":
      return await executeCommand("cleanup", env, args);
    case "q":
    case "Q":
      console.error("Exiting.");
      return 0;
    default:
      console.error(`Invalid choice: ${choice}`);
      return 1;
  }
}

/**
 * Main CLI entrypoint
 */
async function main() {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(2));

  // Handle help first (doesn't need env)
  if (command === "help" || command === "-h" || command === "--help") {
    const subCommand = process.argv[3];
    showHelp(subCommand);
    return 0;
  }

  // Discover env files
  const envFiles = discoverEnvFiles(".");
  
  // No env files - guide to preflight or run preflight
  if (envFiles.length === 0) {
    if (!command || command === "preflight") {
      // Allow preflight to run without env file
      return await executeCommand("preflight", {}, args);
    } else if (!command) {
      // Interactive: prompt for preflight
      const shouldRunPreflight = await showFirstTimeSetup();
      if (shouldRunPreflight) {
        return await executeCommand("preflight", {}, args);
      }
      return 0;
    } else {
      console.error("❌ No configuration found. Run preflight first:");
      console.error("   lakehouse preflight --root-domain example.com");
      return 1;
    }
  }

  // Select env file
  let selectedNamespace: string;
  if (args["namespace"]) {
    selectedNamespace = args["namespace"];
  } else if (envFiles.length === 1) {
    selectedNamespace = envFiles[0];
  } else {
    // Multiple env files - prompt user if interactive, or default to first
    if (!command) {
      selectedNamespace = await selectEnvPrompt(envFiles);
    } else {
      // For non-interactive commands, prefer "ingext" or use first
      selectedNamespace = envFiles.includes("ingext") ? "ingext" : envFiles[0];
      console.error(`⚠️  Multiple env files found. Using namespace: ${selectedNamespace}`);
      console.error(`   Available: ${envFiles.join(", ")}`);
      console.error(`   Specify --namespace to use a different one.`);
    }
  }

  // Load env file
  const envFilePath = `./lakehouse_${selectedNamespace}.env`;
  const envFile = await readEnvFile(envFilePath);
  
  if (!envFile.ok || !envFile.env) {
    console.error(`❌ Failed to read env file: ${envFilePath}`);
    return 1;
  }

  const env = envFile.env;

  // Set exec mode from args or default to local
  const execMode = args["exec"] === "docker" ? "docker" : "local";
  setExecMode(execMode as "docker" | "local");

  // If no command, show interactive menu
  if (!command) {
    const choice = await showInteractiveMenu(env, selectedNamespace);
    return await executeMenuChoice(choice, env, args);
  }

  // Execute command
  return await executeCommand(command, env, args);
}

// Run main and exit with code
main()
  .then(code => process.exit(code))
  .catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
