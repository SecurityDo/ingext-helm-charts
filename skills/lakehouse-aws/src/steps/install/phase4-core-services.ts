import { checkPlatformHealth } from "../../tools/platform.js";
import { checkKarpenterInstalled, checkKarpenterReady } from "../../tools/karpenter.js";
import { kubectl, getPodEvents } from "../../tools/kubectl.js";
import { helm, upgradeInstall, waitForHelmReady } from "../../tools/helm.js";

export type Phase4Evidence = {
  platform: {
    healthy: boolean;
    karpenterInstalled: boolean;
    karpenterControllerReady: boolean;
  };
  namespace: {
    name: string;
    existed: boolean;
    created: boolean;
  };
  appSecret: {
    name: string;
    existed: boolean;
    created: boolean;
  };
  helm: {
    releases: Array<{
      name: string;
      status: string;
      revision: number;
      chart: string;
      version?: string;
      elapsedSeconds?: number;
      error?: string;
    }>;
  };
  pods: {
    ready: boolean;
    total: number;
    readyCount: number;
    notReady: Array<{
      name: string;
      status: string;
      reason?: string;
    }>;
    eventsTail?: string;
  };
};

function generateRandomToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 15; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `tok_${result}`;
}

export async function runPhase4CoreServices(
  env: Record<string, string>,
  options?: { force?: boolean; verbose?: boolean }
): Promise<{
  ok: boolean;
  evidence: Phase4Evidence;
  blockers: Array<{ code: string; message: string }>;
}> {
  const blockers: Array<{ code: string; message: string }> = [];
  
  const region = env.AWS_REGION;
  const profile = env.AWS_PROFILE;
  const namespace = env.NAMESPACE || "ingext";

  const evidence: Phase4Evidence = {
    platform: {
      healthy: false,
      karpenterInstalled: false,
      karpenterControllerReady: false,
    },
    namespace: {
      name: namespace,
      existed: false,
      created: false,
    },
    appSecret: {
      name: "app-secret",
      existed: false,
      created: false,
    },
    helm: {
      releases: [],
    },
    pods: {
      ready: false,
      total: 0,
      readyCount: 0,
      notReady: [],
    },
  };

  // STEP 0: Platform Health Gate
  const platformHealth = await checkPlatformHealth(profile, region);
  evidence.platform.healthy = platformHealth.healthy;

  // Check Karpenter status if installed
  const karpenterCheck = await checkKarpenterInstalled(profile, region);
  evidence.platform.karpenterInstalled = karpenterCheck.exists;
  
  if (karpenterCheck.exists) {
    const karpenterReady = await checkKarpenterReady(profile, region);
    evidence.platform.karpenterControllerReady = karpenterReady.ready;
  }

  // Block if platform unhealthy and Karpenter not ready (unless forced)
  if (!platformHealth.healthy) {
    blockers.push(...platformHealth.blockers);
    
    if (evidence.platform.karpenterInstalled && !evidence.platform.karpenterControllerReady && !options?.force) {
      blockers.push({
        code: "KARPENTER_NOT_READY",
        message: "Karpenter is installed but controller is not ready. Cluster may not be able to schedule pods. Use --force to proceed anyway.",
      });
    }

    // Capture kube-system events if available
    const eventsResult = await kubectl(
      ["get", "events", "-n", "kube-system", "--sort-by=.lastTimestamp", "-o", "json"],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );
    
    if (eventsResult.ok) {
      try {
        const eventsData = JSON.parse(eventsResult.stdout);
        const events = eventsData.items || [];
        const recentEvents = events.slice(-25).map((e: any) => 
          `${e.lastTimestamp || ""} ${e.type || ""} ${e.reason || ""} ${e.message || ""}`
        ).join("\n");
        
        if (recentEvents) {
          blockers.push({
            code: "PLATFORM_EVENTS",
            message: `Recent kube-system events:\n${recentEvents}`,
          });
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    if (!options?.force) {
      return { ok: false, evidence, blockers };
    }
  }

  // STEP 1: Ensure Namespace Exists (Idempotent)
  const nsCheckResult = await kubectl(
    ["get", "namespace", namespace, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  evidence.namespace.existed = nsCheckResult.ok;

  if (!nsCheckResult.ok) {
    const nsCreateResult = await kubectl(
      ["create", "namespace", namespace],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );
    
    if (!nsCreateResult.ok && !nsCreateResult.stderr.includes("already exists")) {
      blockers.push({
        code: "NAMESPACE_CREATE_FAILED",
        message: `Failed to create namespace: ${nsCreateResult.stderr}`,
      });
    } else {
      evidence.namespace.created = true;
    }
  }

  // STEP 2: Ensure app-secret Token Exists (Idempotent)
  const secretCheckResult = await kubectl(
    ["get", "secret", "app-secret", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  evidence.appSecret.existed = secretCheckResult.ok;

  if (!secretCheckResult.ok) {
    const token = generateRandomToken();
    const secretCreateResult = await kubectl(
      ["create", "secret", "generic", "app-secret", "-n", namespace, "--from-literal", `token=${token}`],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );
    
    if (!secretCreateResult.ok && !secretCreateResult.stderr.includes("already exists")) {
      blockers.push({
        code: "APP_SECRET_CREATE_FAILED",
        message: `Failed to create app-secret: ${secretCreateResult.stderr}`,
      });
    } else {
      evidence.appSecret.created = true;
    }
  }

  // STEP 3: Install ingext-serviceaccount Chart (Optional, Non-blocking)
  const serviceAccountChartResult = await upgradeInstall(
    "ingext-serviceaccount",
    "oci://public.ecr.aws/ingext/ingext-serviceaccount",
    namespace,
    undefined,
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  // Track in evidence but don't fail if it doesn't exist
  if (serviceAccountChartResult.ok) {
    // Try to get release info
    const helmCheck = await helm(
      ["list", "-n", namespace, "-o", "json"],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );
    if (helmCheck.ok) {
      try {
        const releases = JSON.parse(helmCheck.stdout);
        const release = releases.find((r: any) => r.name === "ingext-serviceaccount");
        if (release) {
          evidence.helm.releases.push({
            name: "ingext-serviceaccount",
            status: release.status || "unknown",
            revision: release.revision || 0,
            chart: release.chart || "ingext-serviceaccount",
            version: release.app_version || undefined,
          });
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  // STEP 3.5: Install ingext-manager-role Chart (RBAC permissions for service account)
  // This must be installed before Phase 5 pods start, as they need to read secrets and configmaps
  const managerRoleStartTime = Date.now();
  const managerRoleResult = await helm(
    [
      "upgrade", "--install", "ingext-manager-role",
      "oci://public.ecr.aws/ingext/ingext-manager-role",
      "--namespace", namespace,
      "--wait",
      "--timeout", "5m"
    ],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  const managerRoleElapsed = Math.floor((Date.now() - managerRoleStartTime) / 1000);
  evidence.helm.releases.push({
    name: "ingext-manager-role",
    status: managerRoleResult.ok ? "deployed" : "failed",
    revision: 1,
    chart: "oci://public.ecr.aws/ingext/ingext-manager-role",
    elapsedSeconds: managerRoleElapsed,
    error: managerRoleResult.ok ? undefined : managerRoleResult.stderr.substring(0, 500),
  });

  if (!managerRoleResult.ok) {
    blockers.push({
      code: "RBAC_INSTALL_FAILED",
      message: `Failed to install ingext-manager-role (required for Phase 5): ${managerRoleResult.stderr.substring(0, 500)}`,
    });
    return { ok: false, evidence, blockers };
  }

  // STEP 4: Install Core Helm Charts (Idempotent)
  const charts = [
    { release: 'ingext-stack', chart: 'oci://public.ecr.aws/ingext/ingext-stack' },
    { release: 'etcd-single', chart: 'oci://public.ecr.aws/ingext/etcd-single' },
    { release: 'etcd-single-cronjob', chart: 'oci://public.ecr.aws/ingext/etcd-single-cronjob' },
  ];

  for (const { release, chart } of charts) {
    const startTime = Date.now();
    
    // Use helm directly to add --wait --timeout flags
    const installResult = await helm(
      [
        "upgrade", "--install", release, chart,
        "--namespace", namespace,
        "--wait",
        "--timeout", "10m"
      ],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );

    const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);

    // Get release info
    const helmCheck = await helm(
      ["list", "-n", namespace, "-o", "json"],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );

    let releaseInfo: any = {
      name: release,
      status: installResult.ok ? "deployed" : "failed",
      revision: 0,
      chart: chart,
      elapsedSeconds,
    };

    if (helmCheck.ok) {
      try {
        const releases = JSON.parse(helmCheck.stdout);
        const found = releases.find((r: any) => r.name === release);
        if (found) {
          releaseInfo.status = found.status || releaseInfo.status;
          releaseInfo.revision = found.revision || 0;
          releaseInfo.version = found.app_version || undefined;
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    if (!installResult.ok) {
      releaseInfo.error = installResult.stderr.split("\n").slice(-10).join("\n");
      blockers.push({
        code: `HELM_INSTALL_FAILED_${release.toUpperCase().replace(/-/g, '_')}`,
        message: `Failed to install ${release}: ${releaseInfo.error}`,
      });
    }

    evidence.helm.releases.push(releaseInfo);
  }

  // STEP 5: Active pod readiness polling (NO SILENT 10-MINUTE WAITS!)
  const verbose = options?.verbose ?? true;
  if (verbose) console.error(`\n⏳ Waiting for all pods to be Ready (checking every 30s, max 10 minutes)...`);
  
  const maxWaitSeconds = 600;
  const pollIntervalSeconds = 30;
  const startTime = Date.now();
  let allPodsReady = false;
  let lastPodStatus = "";
  
  while (!allPodsReady && (Date.now() - startTime) < maxWaitSeconds * 1000) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    
    if (verbose) {
      process.stderr.write(`   [${minutes}m ${seconds}s] Checking pod status...\n`);
    }
    
    // Get all pods in namespace
    const podsResult = await kubectl(
      ["get", "pods", "-n", namespace, "-o", "json"],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );
    
    if (podsResult.ok) {
      try {
        const podsData = JSON.parse(podsResult.stdout);
        const pods = podsData.items || [];
        evidence.pods.total = pods.length;
        evidence.pods.readyCount = 0;
        evidence.pods.notReady = [];
        
        // Filter out completed/succeeded/failed pods and cronjob pods
        const activePods = pods.filter((p: any) => {
          const phase = p.status?.phase;
          if (phase === "Succeeded" || phase === "Failed") return false;
          
          // Exclude pods created by CronJobs (they are meant to complete/fail)
          const ownerRefs = p.metadata?.ownerReferences || [];
          const isCronJobPod = ownerRefs.some((ref: any) => ref.kind === "Job" && p.metadata.name.includes("cronjob"));
          if (isCronJobPod) return false;
          
          return true;
        });
        
        for (const pod of activePods) {
          const containerStatuses = pod.status.containerStatuses || [];
          const readyCondition = pod.status?.conditions?.find((c: any) => c.type === "Ready");
          const ready = readyCondition && readyCondition.status === "True";
          
          if (ready) {
            evidence.pods.readyCount++;
          } else {
            const phase = pod.status.phase || "Unknown";
            const reason = pod.status.containerStatuses?.[0]?.state?.waiting?.reason ||
                         pod.status.containerStatuses?.[0]?.state?.terminated?.reason ||
                         pod.status.reason ||
                         undefined;
            
            evidence.pods.notReady.push({
              name: pod.metadata.name,
              status: phase,
              reason,
            });
          }
        }
        
        evidence.pods.ready = evidence.pods.notReady.length === 0 && activePods.length > 0;
        
        if (evidence.pods.ready) {
          allPodsReady = true;
          if (verbose) {
            console.error(`✓ All pods are Ready! (${activePods.length} pods)`);
          }
          break;
        }
        
        // Show what we're waiting for
        const statusSummary = evidence.pods.notReady.map((p: any) => `${p.name}: ${p.status}${p.reason ? `(${p.reason})` : ""}`).slice(0, 5).join(", ");
        if (verbose && statusSummary !== lastPodStatus) {
          console.error(`   Waiting for ${evidence.pods.notReady.length} pod(s): ${statusSummary}`);
          lastPodStatus = statusSummary;
        }
      } catch (e) {
        if (verbose) console.error(`   Warning: Failed to parse pod status`);
      }
    }
    
    // Wait before next check
    if (!allPodsReady) {
      if (verbose) {
        process.stderr.write(`   Next check in ${pollIntervalSeconds}s...\n`);
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalSeconds * 1000));
    }
  }
  
  const waitResult = { ok: allPodsReady, stdout: "", stderr: "" };

  // If wait failed, capture diagnostics
  if (!waitResult.ok || !evidence.pods.ready) {
    // Get pods wide output
    const podsWideResult = await kubectl(
      ["get", "pods", "-n", namespace, "-o", "wide"],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );

    // Get events
    const eventsResult = await kubectl(
      ["get", "events", "-n", namespace, "--sort-by=.lastTimestamp"],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );

    if (eventsResult.ok) {
      const eventsLines = eventsResult.stdout.split("\n").slice(-25);
      evidence.pods.eventsTail = eventsLines.join("\n");
    }

    // Get describe for worst offenders (first 3 not ready pods)
    for (const pod of evidence.pods.notReady.slice(0, 3)) {
      const describeResult = await getPodEvents(pod.name, namespace, profile, region);
      if (describeResult.ok && describeResult.events) {
        // Add events to blocker message
        const eventsExcerpt = describeResult.events.split("\n").slice(0, 15).join("\n");
        blockers.push({
          code: `POD_NOT_READY_${pod.name.toUpperCase().replace(/-/g, '_')}`,
          message: `Pod ${pod.name} is not ready (${pod.status}${pod.reason ? `: ${pod.reason}` : ""})\n\nEvents:\n${eventsExcerpt}`,
        });
      }
    }

    if (podsWideResult.ok) {
      blockers.push({
        code: "PODS_NOT_READY",
        message: `Not all pods are ready in namespace ${namespace}.\n\nPod status:\n${podsWideResult.stdout}\n\nRecent events:\n${evidence.pods.eventsTail || "No events found"}`,
      });
    } else {
      blockers.push({
        code: "POD_READINESS_TIMEOUT",
        message: `Timeout waiting for pods to be ready in namespace ${namespace}. Check pod status manually.`,
      });
    }
  }

  return {
    ok: blockers.length === 0 && evidence.pods.ready,
    evidence,
    blockers,
  };
}
