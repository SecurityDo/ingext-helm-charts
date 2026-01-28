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
  // Step 1: Attempt to clear Helm lock by deleting the secret
  await run(
    "bash",
    ["-c", `kubectl delete secret -n kube-system -l owner=helm,name=karpenter 2>&1 || true`],
    { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region }
  );
  
  // Step 2: Force uninstall the stuck release
  await run(
    "bash",
    ["-c", `helm uninstall karpenter -n kube-system --wait --timeout 5m 2>&1 || true`],
    { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region }
  );
  
  // Step 3: Wait for resources to clear
  await new Promise(resolve => setTimeout(resolve, 10000)); // 10s wait
  
  // Step 4: Clean up any remaining pods/deployments
  await kubectl(
    ["delete", "deployment", "karpenter", "-n", "kube-system", "--ignore-not-found=true"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  
  await new Promise(resolve => setTimeout(resolve, 5000)); // 5s wait
  
  // Step 5: Fresh install
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

export type KarpenterDiagnostics = {
  podLogs: string;
  podEvents: string;
  helmHistory: string;
  deploymentStatus: string;
};

export async function captureKarpenterDiagnostics(
  profile: string,
  region: string
): Promise<KarpenterDiagnostics> {
  const diagnostics: KarpenterDiagnostics = {
    podLogs: "",
    podEvents: "",
    helmHistory: "",
    deploymentStatus: "",
  };

  // Capture pod logs (last 50 lines from first pod)
  const podsResult = await kubectl(
    ["get", "pods", "-n", "kube-system", "-l", "app.kubernetes.io/name=karpenter", "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  
  if (podsResult.ok) {
    try {
      const podsData = JSON.parse(podsResult.stdout);
      const pods = podsData.items || [];
      if (pods.length > 0) {
        const podName = pods[0].metadata.name;
        const logsResult = await kubectl(
          ["logs", "-n", "kube-system", podName, "--tail=50"],
          { AWS_PROFILE: profile, AWS_REGION: region }
        );
        if (logsResult.ok) {
          diagnostics.podLogs = logsResult.stdout;
        }
        
        // Capture pod events
        const describeResult = await kubectl(
          ["describe", "pod", "-n", "kube-system", podName],
          { AWS_PROFILE: profile, AWS_REGION: region }
        );
        if (describeResult.ok) {
          const lines = describeResult.stdout.split("\n");
          const eventsIndex = lines.findIndex(line => line.startsWith("Events:"));
          if (eventsIndex !== -1) {
            diagnostics.podEvents = lines.slice(eventsIndex).join("\n");
          }
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Capture Helm history
  const historyResult = await helm(
    ["history", "karpenter", "-n", "kube-system", "--max", "10"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  if (historyResult.ok) {
    diagnostics.helmHistory = historyResult.stdout;
  }

  // Capture deployment status
  const deployResult = await kubectl(
    ["get", "deployment", "karpenter", "-n", "kube-system", "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  if (deployResult.ok) {
    try {
      const deploy = JSON.parse(deployResult.stdout);
      diagnostics.deploymentStatus = `Ready: ${deploy.status?.readyReplicas || 0}/${deploy.spec?.replicas || 0}`;
    } catch (e) {
      diagnostics.deploymentStatus = deployResult.stdout;
    }
  }

  return diagnostics;
}
