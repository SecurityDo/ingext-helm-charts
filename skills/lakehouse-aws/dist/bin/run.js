import { PreflightInputSchema } from "../src/schema.js";
import { runPreflight } from "../src/skill.js";
import { runInstall } from "../src/install.js";
import { runStatus } from "../src/status.js";
import { runCleanup } from "../src/cleanup.js";
import { setExecMode } from "../src/tools/shell.js";
import { readEnvFile, discoverEnvFiles } from "../src/tools/file.js";
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
const args = parseArgs(process.argv.slice(2));
// Check for action/command
const action = args["action"] || "preflight"; // preflight, install, status, cleanup
// Helper to get value from CLI args, then env file, then undefined
function getValue(cliKey, envKey, envVars) {
    return args[cliKey] || envVars[envKey] || undefined;
}
// Get namespace first (needed to compute env file path)
const namespaceFromArgs = args["namespace"];
let namespace = namespaceFromArgs;
// Try to load namespace-scoped .env file as fallback (CLI args take precedence)
// If namespace is provided, use it; otherwise try to infer from available env files
let envVars = {};
let envFilePath;
if (namespace) {
    // Namespace provided: use namespace-scoped env file
    envFilePath = args["output-env"] || `./lakehouse_${namespace}.env`;
    const envFile = await readEnvFile(envFilePath);
    if (envFile.ok && envFile.env) {
        envVars = envFile.env;
        // If namespace wasn't in env file, use the one from CLI
        namespace = namespace || envFile.env.NAMESPACE || namespace;
    }
}
else {
    // No namespace provided: try to discover available env files
    const discoveredNamespaces = discoverEnvFiles(".");
    if (discoveredNamespaces.length === 0) {
        // No env files found: default to "ingext" (will be created on preflight)
        namespace = "ingext";
        envFilePath = args["output-env"] || `./lakehouse_${namespace}.env`;
    }
    else if (discoveredNamespaces.length === 1) {
        // Exactly one env file: use it automatically
        namespace = discoveredNamespaces[0];
        envFilePath = args["output-env"] || `./lakehouse_${namespace}.env`;
        const envFile = await readEnvFile(envFilePath);
        if (envFile.ok && envFile.env) {
            envVars = envFile.env;
            namespace = envFile.env.NAMESPACE || namespace;
        }
    }
    else {
        // Multiple env files found: require namespace to be specified
        // For now, default to "ingext" but this should ideally be an error for install/status
        // For preflight, it's OK to default since it will create the file
        if (action === "preflight") {
            namespace = "ingext";
            envFilePath = args["output-env"] || `./lakehouse_${namespace}.env`;
        }
        else {
            // For install/status, try "ingext" first, then first discovered
            namespace = discoveredNamespaces.includes("ingext") ? "ingext" : discoveredNamespaces[0];
            envFilePath = args["output-env"] || `./lakehouse_${namespace}.env`;
            const envFile = await readEnvFile(envFilePath);
            if (envFile.ok && envFile.env) {
                envVars = envFile.env;
                namespace = envFile.env.NAMESPACE || namespace;
            }
            // Warn user that namespace was inferred
            if (action === "install" || action === "status") {
                console.error(`⚠️  Multiple env files found. Using namespace: ${namespace}`);
                console.error(`   Available namespaces: ${discoveredNamespaces.join(", ")}`);
                console.error(`   Specify --namespace to use a different one.`);
            }
        }
    }
}
// Map CLI args -> schema fields (CLI args override env file)
const raw = {
    awsProfile: getValue("profile", "AWS_PROFILE", envVars) || "default",
    awsRegion: getValue("region", "AWS_REGION", envVars) || "us-east-2",
    clusterName: getValue("cluster", "CLUSTER_NAME", envVars),
    s3Bucket: getValue("bucket", "S3_BUCKET", envVars),
    rootDomain: getValue("root-domain", "ROOT_DOMAIN", envVars),
    siteDomain: getValue("domain", "SITE_DOMAIN", envVars), // optional - will be constructed from rootDomain if not provided
    certArn: getValue("cert-arn", "CERT_ARN", envVars),
    namespace: namespace || getValue("namespace", "NAMESPACE", envVars) || "ingext",
    nodeType: getValue("node-type", "NODE_TYPE", envVars),
    nodeCount: getValue("node-count", "NODE_COUNT", envVars),
    outputEnvPath: args["output-env"], // Will be computed in preflight as lakehouse_{namespace}.env
    writeEnvFile: args["write-env"] !== "false",
    overwriteEnv: args["overwrite-env"] !== undefined && args["overwrite-env"] !== "false",
    dnsCheck: args["dns-check"] !== "false",
    approve: args["approve"] === "true",
    execMode: args["exec"] === "docker" ? "docker" : "local",
    readiness: {
        hasBilling: args["has-billing"] !== "false",
        hasAdmin: args["has-admin"] !== "false",
        hasDns: args["has-dns"] !== "false",
    },
};
// Set execution mode globally for all tool wrappers
setExecMode(raw.execMode);
function formatStatusOutput(result) {
    const GREEN = "\x1b[0;32m";
    const YELLOW = "\x1b[1;33m";
    const RED = "\x1b[0;31m";
    const NC = "\x1b[0m"; // No Color
    const getStatusColor = (status) => {
        if (status === "ACTIVE" || status === "Running" || status === "EXISTS" || status === "deployed" || status === "Issued") {
            return `${GREEN}${status}${NC}`;
        }
        else if (status === "CREATING" || status === "PROVISIONING..." || status === "Pending" || status === "PENDING_VALIDATION" || status === "Starting") {
            return `${YELLOW}${status}${NC}`;
        }
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
    // Ingress status
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
    // ALB DNS name
    if (result.networking.loadBalancer) {
        const lb = result.networking.loadBalancer;
        if (lb.hostname) {
            console.log(`  ${"AWS Load Balancer".padEnd(43)} ${GREEN}${lb.hostname}${NC}`);
        }
        else if (lb.ip) {
            console.log(`  ${"AWS Load Balancer".padEnd(43)} ${GREEN}${lb.ip}${NC}`);
        }
        else {
            console.log(`  ${"AWS Load Balancer".padEnd(43)} ${YELLOW}PROVISIONING...${NC}`);
        }
    }
    if (result.networking.siteDomain) {
        console.log(`  ${"DNS Domain".padEnd(43)} ${result.networking.siteDomain}`);
    }
    // TLS Certificate status
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
    console.log("=".repeat(80));
    console.log("");
    console.log("💡 TIP: If components are 'NOT DEPLOYED' or stuck, check logs:");
    console.log("   kubectl logs -n <namespace> <pod-name>");
    console.log("");
}
// Handle different actions
if (action === "status") {
    // Status action - show what's deployed
    // Use namespace-scoped env file values as fallback if CLI args not provided
    const statusResult = await runStatus({
        awsProfile: raw.awsProfile,
        awsRegion: raw.awsRegion,
        clusterName: raw.clusterName || envVars.CLUSTER_NAME || "ingext-lakehouse",
        s3Bucket: raw.s3Bucket || envVars.S3_BUCKET,
        namespace: raw.namespace || envVars.NAMESPACE || "ingext",
        rootDomain: raw.rootDomain || envVars.ROOT_DOMAIN,
        siteDomain: raw.siteDomain || envVars.SITE_DOMAIN,
        certArn: raw.certArn || envVars.CERT_ARN,
    });
    // Format output similar to bash script
    formatStatusOutput(statusResult);
    // Also output JSON for programmatic use
    if (args["json"] === "true" || args["json"] === true) {
        console.log("\n" + JSON.stringify(statusResult, null, 2));
    }
    process.exit(0);
}
else if (action === "install") {
    // Standalone install action: requires namespace and env file
    if (!namespace) {
        const discovered = discoverEnvFiles(".");
        console.error("❌ Error: Namespace is required for install action.");
        if (discovered.length > 0) {
            console.error(`   Available namespaces: ${discovered.join(", ")}`);
            console.error(`   Specify --namespace <namespace> to use one of these.`);
        }
        else {
            console.error(`   No env files found. Run preflight first to create one.`);
        }
        process.exit(1);
    }
    // Load env file for install (use already discovered path or compute)
    const installEnvFilePath = envFilePath || args["output-env"] || `./lakehouse_${namespace}.env`;
    const envFileForInstall = await readEnvFile(installEnvFilePath);
    if (!envFileForInstall.ok || !envFileForInstall.env) {
        console.error(`❌ Error: No environment file found for namespace '${namespace}'.`);
        console.error(`   Expected: ${installEnvFilePath}`);
        console.error(`   Run preflight first to generate the env file.`);
        process.exit(1);
    }
    // Merge env file with CLI args (CLI takes precedence)
    const installEnv = { ...envFileForInstall.env };
    console.error("\n⏳ Running install (standalone mode)...");
    const installResult = await runInstall({
        approve: raw.approve ?? false,
        env: installEnv,
        force: args["force"] === "true" || args["force"] === true,
        namespace: namespace,
        envFile: installEnvFilePath,
        verbose: args["verbose"] !== "false", // Default to true for user feedback
    }, undefined // No preflight result for standalone install
    );
    console.error("✓ Install completed");
    console.log(JSON.stringify({ install: installResult }, null, 2));
    // Exit code logic
    if (installResult.status === "completed_phase") {
        process.exit(0);
    }
    else if (installResult.status === "error") {
        process.exit(1);
    }
    else {
        process.exit(2); // needs_input
    }
}
else if (action === "cleanup") {
    // Cleanup action: requires namespace and env file
    if (!namespace) {
        const discovered = discoverEnvFiles(".");
        console.error("❌ Error: Namespace is required for cleanup action.");
        if (discovered.length > 0) {
            console.error(`   Available namespaces: ${discovered.join(", ")}`);
            console.error(`   Specify --namespace <namespace> to use one of these.`);
        }
        else {
            console.error(`   No env files found. Cannot determine what to clean up.`);
        }
        process.exit(1);
    }
    // Load env file for cleanup
    const cleanupEnvFilePath = envFilePath || args["output-env"] || `./lakehouse_${namespace}.env`;
    const envFileForCleanup = await readEnvFile(cleanupEnvFilePath);
    if (!envFileForCleanup.ok || !envFileForCleanup.env) {
        console.error(`❌ Error: No environment file found for namespace '${namespace}'.`);
        console.error(`   Expected: ${cleanupEnvFilePath}`);
        console.error(`   Cannot proceed without env file to know what to clean up.`);
        process.exit(1);
    }
    // Merge env file with CLI args (CLI takes precedence)
    const cleanupEnv = { ...envFileForCleanup.env };
    console.error("\n⏳ Running cleanup...");
    const cleanupResult = await runCleanup({
        awsProfile: raw.awsProfile || cleanupEnv.AWS_PROFILE || "default",
        awsRegion: raw.awsRegion || cleanupEnv.AWS_REGION || "us-east-2",
        clusterName: raw.clusterName || cleanupEnv.CLUSTER_NAME || "",
        s3Bucket: raw.s3Bucket || cleanupEnv.S3_BUCKET,
        namespace: namespace,
        approve: raw.approve === true,
        envFile: cleanupEnvFilePath,
    });
    console.error("✓ Cleanup completed");
    console.log(JSON.stringify({ cleanup: cleanupResult }, null, 2));
    // Exit code logic
    if (cleanupResult.status === "completed") {
        process.exit(0);
    }
    else if (cleanupResult.status === "error") {
        process.exit(1);
    }
    else if (cleanupResult.status === "needs_approval") {
        process.exit(2); // needs approval
    }
    else {
        process.exit(3); // partial completion
    }
}
else {
    // Default: preflight + install flow
    const input = PreflightInputSchema.parse(raw);
    console.error("\n⏳ Running preflight...");
    const preflightResult = await runPreflight(input);
    console.error("✓ Preflight completed");
    // Prepare output structure
    const output = {
        preflight: preflightResult,
    };
    // If preflight passed, run install (which will show plan if not approved, or execute if approved)
    if (preflightResult.okToInstall) {
        console.error("\n⏳ Running install...");
        const installResult = await runInstall({
            approve: input.approve ?? false,
            env: preflightResult.env,
            force: args["force"] === "true" || args["force"] === true,
            namespace: preflightResult.env.NAMESPACE,
            envFile: preflightResult.envFile,
            verbose: args["verbose"] !== "false", // Default to true for user feedback
        }, preflightResult);
        console.error("✓ Install completed");
        output.install = installResult;
    }
    console.error("\n⏳ Preparing JSON output...");
    console.log(JSON.stringify(output, null, 2));
    console.error("✓ Output complete");
    // Exit code logic
    if (output.install) {
        if (output.install.status === "completed_phase") {
            process.exit(0);
        }
        else if (output.install.status === "error") {
            process.exit(1);
        }
        else {
            process.exit(2); // needs_input
        }
    }
    else {
        process.exit(preflightResult.okToInstall ? 0 : 2);
    }
}
