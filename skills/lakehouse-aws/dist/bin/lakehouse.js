#!/usr/bin/env node
import { discoverEnvFiles, readEnvFile } from "../src/tools/file.js";
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
function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--"))
            continue;
        const key = a.slice(2);
        const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
        out[key] = val;
    }
    return out;
}
/**
 * Execute a command with the given environment
 */
async function executeCommand(command, env, args) {
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
        case "skills":
            // Show skills doesn't need env
            const { showSkills } = await import("../src/tools/help.js");
            showSkills();
            return 0;
        default:
            console.error(`Unknown command: ${command}`);
            console.error("Run 'lakehouse help' for available commands");
            return 1;
    }
}
/**
 * Execute preflight command
 */
async function execPreflight(env, args) {
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
    setExecMode(raw.execMode);
    const input = PreflightInputSchema.parse(raw);
    console.error("\n⏳ Running preflight...");
    const result = await runPreflight(input);
    console.error("✓ Preflight completed");
    if (result.okToInstall) {
        console.error("\n✓ Preflight passed! Ready to install.");
        console.error(`\nNext step: lakehouse install`);
        return 0;
    }
    else {
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
async function execInstall(env, args) {
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
    setExecMode(execMode);
    console.error("\n⏳ Running install...");
    const result = await runInstall({
        approve: args["approve"] === "true",
        env: envFile.env,
        force: args["force"] === "true",
        namespace: namespace,
        envFile: envFilePath,
        verbose: args["verbose"] !== "false",
    }, undefined);
    // Display result information
    if (result.status === "needs_input") {
        // Re-render plan with colors for display
        const { renderInstallPlan } = await import("../src/install.js");
        const GREEN = "\x1b[0;32m";
        const NC = "\x1b[0m";
        const planWithColors = renderInstallPlan(envFile.env, { GREEN, NC });
        console.error("\n" + planWithColors);
        console.error("\n⚠️  Approval required to proceed.");
        console.error("   Run: lakehouse install --approve true");
        return 2;
    }
    else if (result.status === "error") {
        console.error("\n❌ Install failed");
        if (result.phase) {
            console.error(`   Phase: ${result.phase}`);
        }
        if (result.blockers && result.blockers.length > 0) {
            console.error("\n   Blockers:");
            result.blockers.forEach(b => console.error(`     - ${b.message}`));
        }
        return 1;
    }
    else if (result.status === "blocked_phase") {
        console.error("\n⚠️  Install blocked");
        if (result.phase) {
            console.error(`   Phase: ${result.phase}`);
        }
        if (result.blockers && result.blockers.length > 0) {
            console.error("\n   Blockers:");
            result.blockers.forEach(b => console.error(`     - ${b.message}`));
        }
        if (result.next) {
            if (result.next.action === "fix" && result.next.phase) {
                console.error(`\n   Next: Fix issues in Phase ${result.next.phase}, then retry`);
            }
        }
        return 1;
    }
    else if (result.status === "completed_phase") {
        console.error("\n✓ Install completed phase");
        if (result.phase) {
            console.error(`   Completed: ${result.phase}`);
        }
        console.error("\n   Next: Run 'lakehouse install' again to continue");
        return 0;
    }
    else if (result.status === "completed") {
        console.error("\n✓ Install completed successfully!");
        return 0;
    }
    else {
        console.error("\n✓ Install completed");
        return 0;
    }
}
/**
 * Execute status command
 */
async function execStatus(env, args) {
    const execMode = args["exec"] === "docker" ? "docker" : "local";
    setExecMode(execMode);
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
async function execCleanup(env, args) {
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
    setExecMode(execMode);
    // First call to get the plan
    const result = await runCleanup({
        awsProfile: args["profile"] || env.AWS_PROFILE || "default",
        awsRegion: args["region"] || env.AWS_REGION || "us-east-2",
        clusterName: args["cluster"] || env.CLUSTER_NAME || "",
        s3Bucket: args["bucket"] || env.S3_BUCKET,
        namespace: namespace,
        approve: args["approve"] === "true",
        envFile: envFilePath,
    });
    // Handle approval flow
    if (result.status === "needs_approval") {
        // Display the plan
        console.error("");
        console.error(result.plan);
        console.error("");
        console.error("⚠️  WARNING: Cleanup will DELETE and UNALLOCATE resources");
        console.error("   This action cannot be undone!");
        console.error("");
        // Prompt for confirmation
        const { prompt } = await import("../src/tools/interactive-menu.js");
        const confirmation = await prompt("Type 'DELETE' to confirm cleanup: ");
        if (confirmation === "DELETE") {
            // Re-run with approval
            console.error("\n⏳ Running cleanup...");
            const approvedResult = await runCleanup({
                awsProfile: args["profile"] || env.AWS_PROFILE || "default",
                awsRegion: args["region"] || env.AWS_REGION || "us-east-2",
                clusterName: args["cluster"] || env.CLUSTER_NAME || "",
                s3Bucket: args["bucket"] || env.S3_BUCKET,
                namespace: namespace,
                approve: true,
                envFile: envFilePath,
            });
            return await handleCleanupResult(approvedResult, env, args);
        }
        else {
            console.error("Cleanup aborted.");
            return 0;
        }
    }
    return await handleCleanupResult(result, env, args);
}
/**
 * Handle cleanup result and run status verification
 */
async function handleCleanupResult(result, env, args) {
    if (result.status === "completed") {
        // Run status verification
        console.error("\n⏳ Verifying cleanup completion...");
        try {
            const statusResult = await runStatus({
                awsProfile: args["profile"] || env.AWS_PROFILE || "default",
                awsRegion: args["region"] || env.AWS_REGION || "us-east-2",
                clusterName: args["cluster"] || env.CLUSTER_NAME || "",
                s3Bucket: args["bucket"] || env.S3_BUCKET,
                namespace: args["namespace"] || env.NAMESPACE || "ingext",
                rootDomain: args["root-domain"] || env.ROOT_DOMAIN,
                siteDomain: args["domain"] || env.SITE_DOMAIN,
                certArn: args["cert-arn"] || env.CERT_ARN,
            });
            // Check if cluster still exists - use the actual cluster status from infrastructure check
            const clusterStatus = statusResult.cluster.status;
            const clusterDetails = statusResult.cluster.details;
            const eksStatus = clusterDetails?.eksStatus || "UNKNOWN";
            console.error("");
            console.error("=".repeat(80));
            console.error("Cleanup Verification");
            console.error("=".repeat(80));
            if (clusterStatus === "deployed" || eksStatus === "ACTIVE" || eksStatus === "CREATING" || eksStatus === "DELETING") {
                console.error("⚠️  Cluster still exists:");
                console.error(`   Status: ${eksStatus}`);
                if (eksStatus === "DELETING") {
                    console.error(`   Cluster deletion is in progress. This takes ~15 minutes.`);
                }
                else if (eksStatus === "ACTIVE") {
                    console.error(`   ⚠️  WARNING: Cluster is still ACTIVE! Cleanup may have failed.`);
                    console.error(`   Run 'lakehouse cleanup' again or manually delete the cluster.`);
                }
                else {
                    console.error(`   This is normal if cluster deletion is in progress.`);
                }
            }
            else {
                console.error("✓ Cluster: Deleted or not found");
            }
            if (statusResult.infrastructure.s3.exists) {
                console.error(`⚠️  S3 Bucket still exists: ${statusResult.infrastructure.s3.bucketName}`);
            }
            else {
                console.error("✓ S3 Bucket: Deleted or not found");
            }
            if (statusResult.helm.releases && statusResult.helm.releases.length > 0) {
                console.error(`⚠️  ${statusResult.helm.releases.length} Helm release(s) still exist`);
            }
            else {
                console.error("✓ Helm Releases: All uninstalled");
            }
            console.error("=".repeat(80));
            console.error("");
        }
        catch (err) {
            console.error("⚠️  Could not verify cleanup status (cluster may be deleted):");
            console.error(`   ${err instanceof Error ? err.message : String(err)}`);
        }
        console.error("✓ Cleanup completed");
        return 0;
    }
    else if (result.status === "error") {
        console.error("❌ Cleanup failed with errors");
        return 1;
    }
    else {
        console.error("⚠️  Cleanup completed with partial success");
        return 3; // partial completion
    }
}
/**
 * Format status output (from run.ts)
 */
function formatStatusOutput(result) {
    const GREEN = "\x1b[0;32m";
    const YELLOW = "\x1b[1;33m";
    const RED = "\x1b[0;31m";
    const NC = "\x1b[0m";
    const getStatusColor = (status) => {
        // Success states (green)
        if (status === "ACTIVE" || status === "Running" || status === "EXISTS" || status === "deployed" ||
            status === "Issued" || status === "Attached" || status === "Installed" || status === "Succeeded") {
            return `${GREEN}${status}${NC}`;
        }
        // Warning/In-progress states (yellow)
        else if (status === "CREATING" || status === "PROVISIONING..." || status === "Pending" ||
            status === "PENDING_VALIDATION" || status === "Starting" || status === "Pending Validation" ||
            status === "Terminating" || status === "UPDATING") {
            return `${YELLOW}${status}${NC}`;
        }
        // Error states (red)
        else if (status === "CrashLoopBackOff" || status === "Failed" || status === "Error" ||
            status === "NOT DEPLOYED" || status === "Unknown" || status === "Error" ||
            status === "ImagePullBackOff" || status === "ErrImagePull" || status === "CreateContainerConfigError") {
            return `${RED}${status}${NC}`;
        }
        // Unknown/other states (red by default)
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
        }
        else if (lb.status === "deployed") {
            ingressStatus = "PROVISIONING";
            console.log(`  ${"Ingress".padEnd(43)} ${YELLOW}${ingressStatus}${NC}`);
        }
        else {
            console.log(`  ${"Ingress".padEnd(43)} ${RED}${ingressStatus}${NC}`);
        }
    }
    else {
        console.log(`  ${"Ingress".padEnd(43)} ${RED}NOT INSTALLED${NC}`);
    }
    if (result.networking.loadBalancer) {
        const lb = result.networking.loadBalancer;
        if (lb.hostname) {
            console.log(`  ${"AWS Load Balancer".padEnd(43)} ${GREEN}${lb.hostname}${NC}`);
        }
        else if (lb.ip) {
            console.log(`  ${"AWS Load Balancer".padEnd(43)} ${GREEN}${lb.ip}${NC}`);
        }
        else if (lb.status === "degraded") {
            // Ingress exists but ALB not provisioned yet (no hostname/IP in ingress status)
            console.log(`  ${"AWS Load Balancer".padEnd(43)} ${YELLOW}PROVISIONING...${NC}`);
            console.log(`     (Ingress created, waiting for AWS to provision ALB - takes 2-5 minutes)`);
        }
        else if (lb.status === "unknown") {
            // Can't check - cluster might be deleting or unreachable
            console.log(`  ${"AWS Load Balancer".padEnd(43)} ${YELLOW}UNKNOWN${NC}`);
            console.log(`     (Cannot check - cluster may be deleting or unreachable)`);
        }
        else {
            console.log(`  ${"AWS Load Balancer".padEnd(43)} ${RED}NOT READY${NC}`);
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
    // Show details about non-running pods if any
    if (result.podSummary.total > result.podSummary.running) {
        const notRunning = result.podSummary.total - result.podSummary.running;
        console.log(`${YELLOW}⚠️  ${notRunning} pod(s) not running. Check 'kubectl get pods' for details.${NC}`);
    }
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
async function executeMenuChoice(choice, env, args) {
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
            return await executeCommand("skills", env, args);
        case "6":
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
        }
        else if (!command) {
            // Interactive: prompt for preflight
            const shouldRunPreflight = await showFirstTimeSetup();
            if (shouldRunPreflight) {
                return await executeCommand("preflight", {}, args);
            }
            return 0;
        }
        else {
            console.error("❌ No configuration found. Run preflight first:");
            console.error("   lakehouse preflight --root-domain example.com");
            return 1;
        }
    }
    // Select env file
    let selectedNamespace;
    if (args["namespace"]) {
        selectedNamespace = args["namespace"];
    }
    else if (envFiles.length === 1) {
        selectedNamespace = envFiles[0];
    }
    else {
        // Multiple env files - prompt user if interactive, or default to first
        if (!command) {
            selectedNamespace = await selectEnvPrompt(envFiles);
        }
        else {
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
    setExecMode(execMode);
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
