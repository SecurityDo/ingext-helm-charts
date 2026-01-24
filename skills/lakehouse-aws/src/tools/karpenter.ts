import { run } from "./shell.js";
import { kubectl } from "./kubectl.js";
import { helm } from "./helm.js";

export async function setupKarpenter(
  profile: string,
  region: string,
  clusterName: string
) {
  return run(
    "bash",
    ["scripts/setup_karpenter.sh", profile, region, clusterName],
    { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region }
  );
}

export type KarpenterReleaseInfo = {
  exists: boolean;
  installed: boolean;  // true only if status is "deployed"
  needsRepair: boolean;  // true if status is "failed" or any "pending-*" state
  version?: string;
  namespace?: string;
  status?: string;  // "deployed" | "failed" | "pending-install" | "pending-upgrade" | etc.
  revision?: number;
};

export async function checkKarpenterInstalled(
  profile: string,
  region: string
): Promise<KarpenterReleaseInfo> {
  // Check via Helm (most reliable for version info)
  // Use -a flag to show ALL releases including pending/failed
  const helmCheck = await helm(
    ["list", "-A", "-a", "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  
  if (helmCheck.ok) {
    try {
      const releases = JSON.parse(helmCheck.stdout);
      const karpenter = releases.find((r: any) => r.name === "karpenter");
      if (karpenter) {
        const status = (karpenter.status || "").toLowerCase();
        // Need repair if failed or stuck in any pending state
        const needsRepair = status === "failed" || 
                           status.startsWith("pending-") ||
                           status === "uninstalling" ||
                           status === "superseded";
        return {
          exists: true,
          installed: status === "deployed",
          needsRepair,
          version: karpenter.chart.split("-").pop() || "unknown",
          namespace: karpenter.namespace,
          status: karpenter.status,
          revision: karpenter.revision,
        };
      }
    } catch (e) {
      // Ignore parse errors
    }
  }
  
  return {
    exists: false,
    installed: false,
    needsRepair: false,
  };
}

export async function repairKarpenter(
  profile: string,
  region: string,
  clusterName: string
) {
  // First attempt to rollback any pending/failed release to clear locks
  const rollback = await run(
    "bash",
    ["-c", `helm rollback karpenter -n kube-system 2>&1 || true`],
    { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region }
  );
  
  // Wait a moment for rollback to settle
  await new Promise(resolve => setTimeout(resolve, 5000));
  
  // Now attempt helm upgrade with longer timeout (10 minutes)
  return run(
    "bash",
    ["-c", `
      helm upgrade --install karpenter oci://public.ecr.aws/karpenter/karpenter \\
        --version 1.8.3 \\
        --namespace kube-system \\
        --create-namespace \\
        --set settings.clusterName=${clusterName} \\
        --set settings.interruptionQueue="" \\
        --set controller.resources.requests.cpu=1 \\
        --set controller.resources.requests.memory=1Gi \\
        --set controller.resources.limits.cpu=1 \\
        --set controller.resources.limits.memory=1Gi \\
        --wait --timeout 10m
    `],
    { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region }
  );
}

export async function checkKarpenterReady(
  profile: string,
  region: string
) {
  // Check deployment rollout status
  const rolloutCheck = await kubectl(
    ["rollout", "status", "deployment/karpenter", "-n", "kube-system", "--timeout=10s"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  
  return { ready: rolloutCheck.ok };
}
