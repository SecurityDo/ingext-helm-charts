import { describeCluster } from "./aws.js";
import { helm } from "./helm.js";
import { kubectl } from "./kubectl.js";
import { digA } from "./dns.js";
/**
 * Infer the current state of the lakehouse deployment
 * Returns state, evidence, and recommended next action
 */
export async function inferState(env) {
    const evidence = {
        clusterExists: false,
        clusterReachable: false,
        clusterStatus: "UNKNOWN",
        helmReleases: [],
        podsReady: 0,
        podsTotal: 0,
        ingressExists: false,
        albProvisioned: false,
        albHostname: undefined,
        dnsConfigured: false,
    };
    // 1. Check if cluster exists
    const clusterCheck = await checkClusterExists(env.CLUSTER_NAME, env.AWS_PROFILE || "default", env.AWS_REGION);
    evidence.clusterExists = clusterCheck.exists;
    evidence.clusterStatus = clusterCheck.status;
    evidence.clusterReachable = clusterCheck.reachable;
    if (!clusterCheck.exists) {
        return {
            state: "NO_CLUSTER",
            evidence,
            recommendation: {
                action: "install",
                reason: "Cluster does not exist. Start installation from Phase 1.",
                command: "lakehouse install"
            }
        };
    }
    if (!clusterCheck.reachable) {
        return {
            state: "CLUSTER_BLOCKED",
            evidence,
            recommendation: {
                action: "diagnose",
                reason: `Cluster exists but is not reachable (status: ${clusterCheck.status})`,
                command: "lakehouse diagnose"
            }
        };
    }
    // 2. Check helm releases to detect which phase we're in
    const helmCheck = await getHelmReleases(env.NAMESPACE || "ingext", {
        AWS_PROFILE: env.AWS_PROFILE || "default",
        AWS_REGION: env.AWS_REGION,
    });
    evidence.helmReleases = helmCheck.releases;
    // Phase detection based on helm releases
    const hasPhase1 = clusterCheck.exists && clusterCheck.reachable;
    const hasPhase2 = true; // Storage is checked separately, assume OK if cluster exists
    const hasPhase3 = helmCheck.releases.some(r => r === "karpenter");
    const hasPhase4 = helmCheck.releases.some(r => r === "ingext-stack" || r === "etcd-single");
    const hasPhase5 = helmCheck.releases.some(r => r === "ingext-community");
    const hasPhase6 = helmCheck.releases.some(r => r === "ingext-lake");
    const hasPhase7 = helmCheck.releases.some(r => r === "ingext-community-ingress-aws");
    // 3. Check pod health
    const podCheck = await checkPodHealth(env.NAMESPACE || "ingext", {
        AWS_PROFILE: env.AWS_PROFILE || "default",
        AWS_REGION: env.AWS_REGION,
    });
    evidence.podsReady = podCheck.ready;
    evidence.podsTotal = podCheck.total;
    // 4. Check ingress and ALB status
    const ingressCheck = await getIngressStatus(env.NAMESPACE || "ingext", {
        AWS_PROFILE: env.AWS_PROFILE || "default",
        AWS_REGION: env.AWS_REGION,
    });
    evidence.ingressExists = ingressCheck.exists;
    evidence.albProvisioned = !!ingressCheck.albDnsName;
    evidence.albHostname = ingressCheck.albDnsName;
    // 5. Check DNS if domain is configured
    if (env.SITE_DOMAIN && ingressCheck.albDnsName) {
        const dnsCheck = await checkDNS(env.SITE_DOMAIN);
        evidence.dnsConfigured = dnsCheck.resolves;
    }
    // Determine state based on evidence
    if (!hasPhase3) {
        return {
            state: "PHASE_2_COMPLETE",
            evidence,
            recommendation: {
                action: "install",
                reason: "Storage configured. Continue with Phase 3 (Compute).",
                command: "lakehouse install"
            }
        };
    }
    if (!hasPhase4) {
        return {
            state: "PHASE_3_COMPLETE",
            evidence,
            recommendation: {
                action: "install",
                reason: "Compute configured. Continue with Phase 4 (Core Services).",
                command: "lakehouse install"
            }
        };
    }
    if (!hasPhase5) {
        return {
            state: "PHASE_4_COMPLETE",
            evidence,
            recommendation: {
                action: "install",
                reason: "Core services deployed. Continue with Phase 5 (Stream).",
                command: "lakehouse install"
            }
        };
    }
    if (!hasPhase6) {
        return {
            state: "PHASE_5_COMPLETE",
            evidence,
            recommendation: {
                action: "install",
                reason: "Stream services deployed. Continue with Phase 6 (Datalake).",
                command: "lakehouse install"
            }
        };
    }
    if (!hasPhase7) {
        return {
            state: "PHASE_6_COMPLETE",
            evidence,
            recommendation: {
                action: "install",
                reason: "Datalake deployed. Complete with Phase 7 (Ingress).",
                command: "lakehouse install"
            }
        };
    }
    // Phase 7 installed - check if ALB is provisioned
    if (!ingressCheck.albDnsName) {
        return {
            state: "PHASE_7_COMPLETE",
            evidence,
            recommendation: {
                action: "wait",
                reason: "ALB is provisioning (takes 2-5 minutes). Check again soon.",
                command: "lakehouse status"
            }
        };
    }
    // ALB provisioned - check DNS
    if (env.SITE_DOMAIN && !evidence.dnsConfigured) {
        return {
            state: "DNS_PENDING",
            evidence,
            recommendation: {
                action: "configure-dns",
                reason: "ALB is ready but DNS is not configured.",
                command: "npx tsx scripts/configure-dns.ts"
            }
        };
    }
    // Check health
    const healthyThreshold = 0.8; // 80% of pods should be ready
    const healthRatio = evidence.podsTotal > 0 ? evidence.podsReady / evidence.podsTotal : 1;
    if (healthRatio < healthyThreshold && evidence.podsTotal > 0) {
        return {
            state: "HEALTH_DEGRADED",
            evidence,
            recommendation: {
                action: "diagnose",
                reason: `Only ${evidence.podsReady}/${evidence.podsTotal} pods are ready.`,
                command: "lakehouse diagnose"
            }
        };
    }
    // Fully deployed and healthy
    return {
        state: "PHASE_7_COMPLETE",
        evidence,
        recommendation: {
            action: "status",
            reason: "Lakehouse is fully deployed and healthy.",
            command: "lakehouse status"
        }
    };
}
/**
 * Check if EKS cluster exists and is reachable
 */
async function checkClusterExists(clusterName, awsProfile, awsRegion) {
    const result = await describeCluster(clusterName, awsProfile, awsRegion);
    return {
        exists: result.found,
        status: result.status,
        reachable: result.status === "ACTIVE"
    };
}
/**
 * Get list of helm releases in namespace
 */
async function getHelmReleases(namespace, env) {
    const result = await helm(["list", "-a", "-n", namespace, "-o", "json"], env);
    if (!result.ok) {
        return { releases: [] };
    }
    try {
        const data = JSON.parse(result.stdout);
        const releases = data.map((r) => r.name);
        return { releases };
    }
    catch {
        return { releases: [] };
    }
}
/**
 * Check pod health in namespace
 */
async function checkPodHealth(namespace, env) {
    const result = await kubectl(["get", "pods", "-n", namespace, "-o", "json"], env);
    if (!result.ok) {
        return { ready: 0, total: 0 };
    }
    try {
        const data = JSON.parse(result.stdout);
        const pods = data.items || [];
        const total = pods.length;
        const ready = pods.filter((pod) => {
            const conditions = pod.status?.conditions || [];
            const readyCondition = conditions.find((c) => c.type === "Ready");
            return readyCondition?.status === "True";
        }).length;
        return { ready, total };
    }
    catch {
        return { ready: 0, total: 0 };
    }
}
/**
 * Get ingress status and ALB hostname
 */
async function getIngressStatus(namespace, env) {
    const result = await kubectl(["get", "ingress", "-n", namespace, "-o", "json"], env);
    if (!result.ok) {
        return { exists: false };
    }
    try {
        const data = JSON.parse(result.stdout);
        const ingresses = data.items || [];
        if (ingresses.length === 0) {
            return { exists: false };
        }
        const ingress = ingresses[0];
        const albDnsName = ingress?.status?.loadBalancer?.ingress?.[0]?.hostname;
        return {
            exists: true,
            albDnsName
        };
    }
    catch {
        return { exists: false };
    }
}
/**
 * Check if domain resolves (using simplified check)
 */
async function checkDNS(domain) {
    const result = await digA(domain);
    // digA is currently disabled, so we'll assume DNS needs configuration
    // In production, this would do actual DNS lookup
    return {
        resolves: false, // Conservative default
        ip: undefined
    };
}
/**
 * Format state for human-readable display
 */
export function formatStateDescription(state) {
    const stateDescriptions = {
        NO_ENV: "No configuration found",
        NO_CLUSTER: "Cluster does not exist",
        CLUSTER_BLOCKED: "Cluster exists but is not reachable",
        PHASE_1_COMPLETE: "Phase 1 complete: Cluster created",
        PHASE_2_COMPLETE: "Phase 2 complete: Storage configured",
        PHASE_3_COMPLETE: "Phase 3 complete: Compute configured",
        PHASE_4_COMPLETE: "Phase 4 complete: Core services deployed",
        PHASE_5_COMPLETE: "Phase 5 complete: Stream services deployed",
        PHASE_6_COMPLETE: "Phase 6 complete: Datalake deployed",
        PHASE_7_COMPLETE: "Phase 7 complete: Fully deployed",
        HEALTH_DEGRADED: "Deployment exists but health is degraded",
        DNS_PENDING: "Deployment complete, DNS configuration pending"
    };
    return stateDescriptions[state] || "Unknown state";
}
