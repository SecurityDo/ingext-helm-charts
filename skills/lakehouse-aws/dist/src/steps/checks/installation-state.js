import { kubectl } from "../../tools/kubectl.js";
import { helm } from "../../tools/helm.js";
import { aws } from "../../tools/aws.js";
import { checkKarpenterInstalled } from "../../tools/karpenter.js";
/**
 * Check the current installation state before starting
 * This prevents re-running completed phases
 */
export async function checkInstallationState(env) {
    const state = {
        phase1Complete: false,
        phase2Complete: false,
        phase3Complete: false,
        phase4Complete: false,
        phase5Complete: false,
        phase6Complete: false,
        details: {
            clusterExists: false,
            clusterActive: false,
            s3BucketExists: false,
            iamPolicyExists: false,
            karpenterInstalled: false,
            namespaceExists: false,
            coreChartsInstalled: [],
            streamChartsInstalled: [],
            datalakeChartsInstalled: [],
        },
    };
    const profile = env.AWS_PROFILE || "default";
    const region = env.AWS_REGION || "us-east-2";
    const clusterName = env.CLUSTER_NAME;
    const namespace = env.NAMESPACE || "ingext";
    const s3Bucket = env.S3_BUCKET;
    // Check Phase 1: EKS Cluster
    const clusterCheck = await aws(["eks", "describe-cluster", "--name", clusterName, "--query", "cluster.status", "--output", "text"], profile, region);
    state.details.clusterExists = clusterCheck.ok;
    state.details.clusterActive = clusterCheck.ok && clusterCheck.stdout.trim() === "ACTIVE";
    state.phase1Complete = state.details.clusterActive;
    // Check Phase 2: S3 and IAM
    if (s3Bucket) {
        const s3Check = await aws(["s3api", "head-bucket", "--bucket", s3Bucket], profile, region);
        state.details.s3BucketExists = s3Check.ok;
        const policyName = `ingext_${namespace}_S3_Policy_${clusterName}`;
        const policyCheck = await aws(["iam", "list-policies", "--query", `Policies[?PolicyName=='${policyName}'].Arn`, "--output", "text"], profile, region);
        state.details.iamPolicyExists = policyCheck.ok && policyCheck.stdout.trim().length > 0;
        state.phase2Complete = state.details.s3BucketExists && state.details.iamPolicyExists;
    }
    // Check Phase 3: Karpenter
    if (state.phase1Complete) {
        const karpenterCheck = await checkKarpenterInstalled(profile, region);
        state.details.karpenterInstalled = karpenterCheck.exists;
        state.phase3Complete = karpenterCheck.exists;
    }
    // Check Phase 4: Core Services
    if (state.phase1Complete) {
        const nsCheck = await kubectl(["get", "namespace", namespace, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
        state.details.namespaceExists = nsCheck.ok;
        const helmList = await helm(["list", "-a", "-n", namespace, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
        if (helmList.ok) {
            try {
                const releases = JSON.parse(helmList.stdout);
                const coreCharts = ["ingext-stack", "etcd-single", "etcd-single-cronjob", "ingext-manager-role"];
                state.details.coreChartsInstalled = releases
                    .filter((r) => coreCharts.includes(r.name) && r.status === "deployed")
                    .map((r) => r.name);
                state.phase4Complete = state.details.coreChartsInstalled.length >= 3; // At least 3 core charts
            }
            catch (e) {
                // Ignore parse errors
            }
        }
    }
    // Check Phase 5: Stream Charts
    if (state.phase4Complete) {
        const helmList = await helm(["list", "-a", "-n", namespace, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
        if (helmList.ok) {
            try {
                const releases = JSON.parse(helmList.stdout);
                const streamCharts = ["ingext-community-config", "ingext-community-init", "ingext-community"];
                state.details.streamChartsInstalled = releases
                    .filter((r) => streamCharts.includes(r.name) && r.status === "deployed")
                    .map((r) => r.name);
                state.phase5Complete = state.details.streamChartsInstalled.length >= 3;
            }
            catch (e) {
                // Ignore parse errors
            }
        }
    }
    // Check Phase 6: Datalake Charts
    if (state.phase5Complete) {
        const helmList = await helm(["list", "-a", "-n", namespace, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
        if (helmList.ok) {
            try {
                const releases = JSON.parse(helmList.stdout);
                const datalakeCharts = ["ingext-lake-config", "ingext-eks-pool", "ingext-s3-lake", "ingext-lake"];
                state.details.datalakeChartsInstalled = releases
                    .filter((r) => datalakeCharts.includes(r.name) && r.status === "deployed")
                    .map((r) => r.name);
                state.phase6Complete = state.details.datalakeChartsInstalled.length >= 3;
            }
            catch (e) {
                // Ignore parse errors
            }
        }
    }
    return state;
}
/**
 * Display installation state in a human-readable format
 */
export function displayInstallationState(state) {
    const lines = [];
    lines.push("============================================================");
    lines.push("📋 Current Installation State");
    lines.push("============================================================\n");
    lines.push(`Phase 1: Foundation        ${state.phase1Complete ? "✓ COMPLETE" : "⏳ INCOMPLETE"}`);
    if (state.details.clusterExists) {
        lines.push(`  - Cluster exists: ${state.details.clusterActive ? "✓ ACTIVE" : "⚠️  NOT ACTIVE"}`);
    }
    else {
        lines.push(`  - Cluster: ✗ Not created`);
    }
    lines.push(`\nPhase 2: Storage           ${state.phase2Complete ? "✓ COMPLETE" : "⏳ INCOMPLETE"}`);
    lines.push(`  - S3 Bucket: ${state.details.s3BucketExists ? "✓ EXISTS" : "✗ Not created"}`);
    lines.push(`  - IAM Policy: ${state.details.iamPolicyExists ? "✓ EXISTS" : "✗ Not created"}`);
    lines.push(`\nPhase 3: Compute           ${state.phase3Complete ? "✓ COMPLETE" : "⏳ INCOMPLETE"}`);
    lines.push(`  - Karpenter: ${state.details.karpenterInstalled ? "✓ INSTALLED" : "✗ Not installed"}`);
    lines.push(`\nPhase 4: Core Services     ${state.phase4Complete ? "✓ COMPLETE" : "⏳ INCOMPLETE"}`);
    lines.push(`  - Namespace: ${state.details.namespaceExists ? "✓ EXISTS" : "✗ Not created"}`);
    if (state.details.coreChartsInstalled.length > 0) {
        lines.push(`  - Installed charts: ${state.details.coreChartsInstalled.join(", ")}`);
    }
    else {
        lines.push(`  - Core charts: ✗ Not installed`);
    }
    lines.push(`\nPhase 5: Stream            ${state.phase5Complete ? "✓ COMPLETE" : "⏳ INCOMPLETE"}`);
    if (state.details.streamChartsInstalled.length > 0) {
        lines.push(`  - Installed charts: ${state.details.streamChartsInstalled.join(", ")}`);
    }
    else {
        lines.push(`  - Stream charts: ✗ Not installed`);
    }
    lines.push(`\nPhase 6: Datalake          ${state.phase6Complete ? "✓ COMPLETE" : "⏳ INCOMPLETE"}`);
    if (state.details.datalakeChartsInstalled.length > 0) {
        lines.push(`  - Installed charts: ${state.details.datalakeChartsInstalled.join(", ")}`);
    }
    else {
        lines.push(`  - Datalake charts: ✗ Not installed`);
    }
    lines.push("\n============================================================");
    return lines.join("\n");
}
