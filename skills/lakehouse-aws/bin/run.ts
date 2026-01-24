import { PreflightInputSchema } from "../src/schema.js";
import { runPreflight } from "../src/skill.js";
import { runInstall } from "../src/install.js";
import { runStatus } from "../src/status.js";
import { setExecMode } from "../src/tools/shell.js";

function parseArgs(argv: string[]) {
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

const args = parseArgs(process.argv.slice(2));

// Check for action/command
const action = args["action"] || "preflight"; // preflight, install, status

// Map CLI args -> schema fields
const raw = {
  awsProfile: args["profile"],
  awsRegion: args["region"],
  clusterName: args["cluster"],
  s3Bucket: args["bucket"],
  rootDomain: args["root-domain"],
  siteDomain: args["domain"], // optional - will be constructed from rootDomain if not provided
  certArn: args["cert-arn"],
  namespace: args["namespace"],
  nodeType: args["node-type"],
  nodeCount: args["node-count"],
  outputEnvPath: args["output-env"],
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
setExecMode(raw.execMode as "docker" | "local");

// Handle different actions
if (action === "status") {
  // Status action - show what's deployed
  const statusResult = await runStatus({
    awsProfile: raw.awsProfile || "default",
    awsRegion: raw.awsRegion || "us-east-2",
    clusterName: raw.clusterName || "ingext-lakehouse",
    s3Bucket: raw.s3Bucket,
    namespace: raw.namespace || "ingext",
    rootDomain: raw.rootDomain,
    siteDomain: raw.siteDomain,
  });
  
  console.log(JSON.stringify(statusResult, null, 2));
  process.exit(0);
} else {
  // Default: preflight + install flow
  const input = PreflightInputSchema.parse(raw);
  console.error("\n⏳ Running preflight...");
  const preflightResult = await runPreflight(input);
  console.error("✓ Preflight completed");

  // Prepare output structure
  const output: { preflight: typeof preflightResult; install?: any } = {
    preflight: preflightResult,
  };

  // If preflight passed, run install (which will show plan if not approved, or execute if approved)
  if (preflightResult.okToInstall) {
    console.error("\n⏳ Running install...");
    const installResult = await runInstall(
      {
        approve: input.approve ?? false,
        env: preflightResult.env,
      },
      preflightResult
    );
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
    } else if (output.install.status === "error") {
      process.exit(1);
    } else {
      process.exit(2); // needs_input
    }
  } else {
    process.exit(preflightResult.okToInstall ? 0 : 2);
  }
}
