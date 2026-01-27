import { checkPlatformHealth } from "../../tools/platform.js";
import { kubectl, waitForPodsReady } from "../../tools/kubectl.js";
import { upgradeInstall, helm, isHelmLocked, waitForHelmReady } from "../../tools/helm.js";

export type Phase5Evidence = {
  platform: {
    healthy: boolean;
    phase4PodsReady: boolean;
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
    crashAnalysis?: Array<{
      podName: string;
      code: string;
      message: string;
      remediation?: string;
    }>;
  };
};

// Crash loop analyzer: detects common crash patterns and returns actionable blockers
async function analyzeCrashLoop(
  podName: string,
  namespace: string,
  env: Record<string, string>
): Promise<{ code: string; message: string; remediation?: string } | null> {
  // Get logs from previous crash (most informative)
  const previousLogsResult = await kubectl(
    ["logs", "-n", namespace, podName, "--all-containers", "--previous", "--tail=200"],
    { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
  );

  // Fallback to current logs if previous not available
  const logsResult = previousLogsResult.ok
    ? previousLogsResult
    : await kubectl(
        ["logs", "-n", namespace, podName, "--all-containers", "--tail=200"],
        { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
      );

  const logs = logsResult.ok ? logsResult.stdout : "";

  // Pattern 1: RBAC permissions (secrets/configmaps forbidden)
  if (
    logs.includes("forbidden") &&
    (logs.includes("secrets") || logs.includes("configmaps")) &&
    logs.includes("cannot get resource")
  ) {
    const resourceMatch = logs.match(/cannot get resource "([^"]+)"/);
    const resource = resourceMatch ? resourceMatch[1] : "secrets/configmaps";
    
    return {
      code: "RBAC_MISSING_PERMISSIONS",
      message: `Pod ${podName} cannot access ${resource} due to missing RBAC permissions. Service account needs Role/RoleBinding to read ${resource}.`,
      remediation: `Install ingext-manager-role chart: helm upgrade --install ingext-manager-role oci://public.ecr.aws/ingext/ingext-manager-role -n ${namespace}`,
    };
  }

  // Pattern 2: Connection refused / no such host (dependency unreachable)
  if (
    logs.includes("connection refused") ||
    logs.includes("no such host") ||
    logs.includes("dial tcp") ||
    logs.includes("i/o timeout")
  ) {
    const serviceMatch = logs.match(/(?:connection refused|no such host|dial tcp).*?([a-z0-9-]+:[0-9]+|[a-z0-9-]+\.svc)/i);
    const service = serviceMatch ? serviceMatch[1] : "unknown service";
    
    return {
      code: "DEPENDENCY_UNREACHABLE",
      message: `Pod ${podName} cannot reach dependency: ${service}. Check if the service exists and is ready.`,
      remediation: `Check service: kubectl get svc -n ${namespace}\n  Check pods: kubectl get pods -n ${namespace} -o wide\n  Check DNS: kubectl run -it --rm debug --image=busybox --restart=Never -- nslookup ${service}`,
    };
  }

  // Pattern 3: Missing environment variable
  if (
    logs.includes("missing env") ||
    logs.includes("required environment variable") ||
    logs.includes("environment variable") && logs.includes("not set")
  ) {
    const envMatch = logs.match(/(?:missing|required|not set).*?([A-Z_][A-Z0-9_]*)/i);
    const envVar = envMatch ? envMatch[1] : "unknown variable";
    
    return {
      code: "MISSING_ENV_VAR",
      message: `Pod ${podName} requires environment variable that is not set: ${envVar}.`,
      remediation: `Check ConfigMap/Secret: kubectl get cm,secret -n ${namespace}\n  Check pod env: kubectl describe pod ${podName} -n ${namespace} | grep -A 20 "Environment:"`,
    };
  }

  // Pattern 4: Storage/PVC mount issues
  if (
    logs.includes("no space left") ||
    logs.includes("PVC") ||
    logs.includes("mount") && (logs.includes("failed") || logs.includes("error"))
  ) {
    return {
      code: "STORAGE_MOUNT_FAILED",
      message: `Pod ${podName} has storage mount issues. Check PVC status and node disk space.`,
      remediation: `Check PVCs: kubectl get pvc -n ${namespace}\n  Check pod: kubectl describe pod ${podName} -n ${namespace} | grep -A 10 "Volumes:"\n  Check node disk: kubectl get nodes -o json | jq '.items[].status.conditions[] | select(.type=="DiskPressure")'`,
    };
  }

  // Pattern 5: Panic / fatal error
  if (logs.includes("panic:") || logs.includes("fatal error")) {
    const panicMatch = logs.match(/panic: (.+?)(?:\n|$)/);
    const panicMsg = panicMatch ? panicMatch[1].substring(0, 200) : "unknown panic";
    
    return {
      code: "APPLICATION_PANIC",
      message: `Pod ${podName} crashed with panic: ${panicMsg}`,
      remediation: `Check full logs: kubectl logs -n ${namespace} ${podName} --all-containers --previous --tail=500\n  Check image version: kubectl describe pod ${podName} -n ${namespace} | grep Image:`,
    };
  }

  // Pattern 6: Secret/ConfigMap not found (different from RBAC)
  if (
    (logs.includes("secrets") || logs.includes("configmaps")) &&
    logs.includes("not found")
  ) {
    const resourceMatch = logs.match(/(?:secrets|configmaps) "([^"]+)" not found/);
    const resource = resourceMatch ? resourceMatch[1] : "unknown";
    
    return {
      code: "RESOURCE_NOT_FOUND",
      message: `Pod ${podName} references ${resource} that does not exist.`,
      remediation: `Check if resource exists: kubectl get secret,cm -n ${namespace}\n  Create if missing or check Helm chart values.`,
    };
  }

  return null; // No pattern matched
}

export async function runPhase5Stream(
  env: Record<string, string>,
  options: { force?: boolean; verbose?: boolean } = {}
): Promise<{
  ok: boolean;
  evidence: Phase5Evidence;
  blockers: Array<{ code: string; message: string }>;
}> {
  const verbose = options?.verbose !== false;
  const blockers: Array<{ code: string; message: string }> = [];
  const namespace = env.NAMESPACE || "ingext";
  const siteDomain = env.SITE_DOMAIN;

  const evidence: Phase5Evidence = {
    platform: {
      healthy: false,
      phase4PodsReady: false,
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

  // Step 0: Platform health gate (verify Phase 4 pods are ready)
  const platformHealth = await checkPlatformHealth(
    env.AWS_PROFILE,
    env.AWS_REGION
  );

  if (!platformHealth.healthy) {
    if (!options.force) {
      const blockerMessages = platformHealth.blockers.map(b => b.message).join("; ");
      blockers.push({
        code: "PLATFORM_UNHEALTHY",
        message: `Platform health check failed: ${blockerMessages || "Unknown error"}. Use --force to bypass.`,
      });
      return { ok: false, evidence, blockers };
    }
  } else {
    evidence.platform.healthy = true;
  }

  // Check Phase 4 pods are ready (graceful wait)
  if (verbose) console.error(`   Checking Phase 4 (Core Services) pods readiness...`);
  const phase4Wait = await waitForPodsReady(namespace, env.AWS_PROFILE, env.AWS_REGION, {
    maxWaitMinutes: 5,
    verbose,
    description: "Phase 4 (Core Services) pods"
  });

  evidence.platform.phase4PodsReady = phase4Wait.ok;

  if (!phase4Wait.ok && !options.force) {
    blockers.push({
      code: "PHASE4_PODS_NOT_READY",
      message: `Phase 4 pods in namespace '${namespace}' are not all ready after waiting. Ensure Phase 4 completes successfully before proceeding. Use --force to bypass.`,
    });
    return { ok: false, evidence, blockers };
  }

  // Step 1: Check if already deployed and healthy (Smart Resume)
  const currentHelmReleases = await helm(
    ["list", "-a", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
  );
  
  let deployedReleases: any[] = [];
  if (currentHelmReleases.ok) {
    try {
      deployedReleases = JSON.parse(currentHelmReleases.stdout);
    } catch (e) { /* ignore */ }
  }

  const streamCharts = ["ingext-community-config", "ingext-community-init", "ingext-community"];
  const allDeployed = streamCharts.every(c => deployedReleases.some((r: any) => r.name === c && r.status === "deployed"));
  
  if (allDeployed) {
    // Verify pods are ready
    const podsCheck = await kubectl(
      ["get", "pods", "-n", namespace, "-l", "app.kubernetes.io/part-of=ingext-community", "-o", "json"],
      { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
    );
    
    let allReady = false;
    if (podsCheck.ok) {
      try {
        const pods = JSON.parse(podsCheck.stdout).items || [];
        allReady = pods.length > 0 && pods.every((p: any) => p.status.phase === "Running" && p.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True"));
      } catch (e) { /* ignore */ }
    }
    
    if (allReady) {
      if (verbose) process.stderr.write(`\n✓ Phase 5 Application Stream is already complete and healthy. Skipping...\n`);
      evidence.pods.ready = true;
      streamCharts.forEach(c => {
        const found = deployedReleases.find((r: any) => r.name === c);
        evidence.helm.releases.push({
          name: c,
          status: "deployed",
          revision: found.revision || 0,
          chart: found.chart || c,
        });
      });
      return { ok: true, evidence, blockers };
    }
  }

  // Step 1: Install ingext-community-config (with siteDomain)
  const startTime1 = Date.now();
  const configResult = await upgradeInstall(
    "ingext-community-config",
    "oci://public.ecr.aws/ingext/ingext-community-config",
    namespace,
    { siteDomain: siteDomain },
    { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
  );

  const elapsed1 = Math.floor((Date.now() - startTime1) / 1000);
  evidence.helm.releases.push({
    name: "ingext-community-config",
    status: configResult.ok ? "deployed" : "failed",
    revision: 1, // Will be updated if we can parse helm status
    chart: "oci://public.ecr.aws/ingext/ingext-community-config",
    elapsedSeconds: elapsed1,
    error: configResult.ok ? undefined : configResult.stderr.substring(0, 500),
  });

  if (!configResult.ok) {
    blockers.push({
      code: "HELM_INSTALL_FAILED",
      message: `Failed to install ingext-community-config: ${configResult.stderr.substring(0, 500)}`,
    });
    return { ok: false, evidence, blockers };
  }

  // Step 2: Install ingext-community-init
  const startTime2 = Date.now();
  const initResult = await upgradeInstall(
    "ingext-community-init",
    "oci://public.ecr.aws/ingext/ingext-community-init",
    namespace,
    undefined,
    { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
  );

  const elapsed2 = Math.floor((Date.now() - startTime2) / 1000);
  evidence.helm.releases.push({
    name: "ingext-community-init",
    status: initResult.ok ? "deployed" : "failed",
    revision: 1,
    chart: "oci://public.ecr.aws/ingext/ingext-community-init",
    elapsedSeconds: elapsed2,
    error: initResult.ok ? undefined : initResult.stderr.substring(0, 500),
  });

  if (!initResult.ok) {
    blockers.push({
      code: "HELM_INSTALL_FAILED",
      message: `Failed to install ingext-community-init: ${initResult.stderr.substring(0, 500)}`,
    });
    return { ok: false, evidence, blockers };
  }

  // Step 3: Install ingext-community (with --wait --timeout)
  const startTime3 = Date.now();
  
  // Check if locked
  const communityLocked = await isHelmLocked("ingext-community", namespace, { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION });
  if (communityLocked) {
    await waitForHelmReady("ingext-community", namespace, { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION });
  }

  const communityResult = await helm(
    [
      "upgrade", "--install", "ingext-community",
      "oci://public.ecr.aws/ingext/ingext-community",
      "--namespace", namespace,
      "--wait",
      "--timeout", "15m"
    ],
    { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
  );

  const elapsed3 = Math.floor((Date.now() - startTime3) / 1000);
  evidence.helm.releases.push({
    name: "ingext-community",
    status: communityResult.ok ? "deployed" : "failed",
    revision: 1,
    chart: "oci://public.ecr.aws/ingext/ingext-community",
    elapsedSeconds: elapsed3,
    error: communityResult.ok ? undefined : communityResult.stderr.substring(0, 500),
  });

  if (!communityResult.ok) {
    blockers.push({
      code: "HELM_INSTALL_FAILED",
      message: `Failed to install ingext-community: ${communityResult.stderr.substring(0, 500)}`,
    });
    return { ok: false, evidence, blockers };
  }

  // Step 4: Wait for pods to be ready (with diagnostics on timeout)
  // Exclude Failed and Succeeded pods (e.g., cronjobs, init jobs)
  const waitResult = await kubectl(
    [
      "wait",
      "--for=condition=Ready",
      "pods",
      "--all",
      "--field-selector=status.phase!=Failed,status.phase!=Succeeded",
      "-n",
      namespace,
      "--timeout=900s",
    ],
    { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
  );

  if (!waitResult.ok) {
    // Capture diagnostics
    const podsCheck = await kubectl(
      ["get", "pods", "-n", namespace, "-o", "wide"],
      { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
    );

    const podsData = podsCheck.ok
      ? JSON.parse(podsCheck.stdout)
      : { items: [] };
    const pods = podsData.items || [];

    evidence.pods.total = pods.length;
    evidence.pods.readyCount = 0;
    evidence.pods.notReady = [];

    evidence.pods.crashAnalysis = [];

    for (const pod of pods) {
      const readyCondition = pod.status?.conditions?.find(
        (c: any) => c.type === "Ready"
      );
      const podName = pod.metadata?.name || "unknown";
      const podStatus = pod.status?.phase || "Unknown";
      const waitingReason = pod.status?.containerStatuses?.[0]?.state?.waiting?.reason;
      const terminatedReason = pod.status?.containerStatuses?.[0]?.state?.terminated?.reason;
      
      if (readyCondition && readyCondition.status === "True") {
        evidence.pods.readyCount++;
      } else {
        evidence.pods.notReady.push({
          name: podName,
          status: podStatus,
          reason:
            readyCondition?.reason ||
            waitingReason ||
            terminatedReason,
        });

        // Run crash analyzer for CrashLoopBackOff pods
        if (podStatus === "CrashLoopBackOff" || waitingReason === "CrashLoopBackOff") {
          const analysis = await analyzeCrashLoop(podName, namespace, env);
          if (analysis) {
            evidence.pods.crashAnalysis.push({
              podName,
              code: analysis.code,
              message: analysis.message,
              remediation: analysis.remediation,
            });
            
            blockers.push({
              code: analysis.code,
              message: `${analysis.message}${analysis.remediation ? `\n\nRemediation:\n${analysis.remediation}` : ""}`,
            });
          }
        }
      }
    }

    // Get events for diagnostics
    const eventsResult = await kubectl(
      ["get", "events", "-n", namespace, "--sort-by=.lastTimestamp", "-o", "json"],
      { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
    );
    if (eventsResult.ok) {
      try {
        const eventsData = JSON.parse(eventsResult.stdout);
        const events = eventsData.items || [];
        evidence.pods.eventsTail = events
          .slice(-25)
          .map((e: any) => `${e.lastTimestamp || ""} ${e.type || ""} ${e.reason || ""} ${e.message || ""}`)
          .join("\n");
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Get describe output for not-ready pods (limit to 3 worst offenders)
    const notReadyPods = evidence.pods.notReady.slice(0, 3);
    for (const pod of notReadyPods) {
      const describeResult = await kubectl(
        ["describe", "pod", pod.name, "-n", namespace],
        { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
      );
      if (describeResult.ok) {
        // Extract relevant sections (Events, Conditions)
        const describeLines = describeResult.stdout.split("\n");
        const eventsStart = describeLines.findIndex((l) =>
          l.includes("Events:")
        );
        const conditionsStart = describeLines.findIndex((l) =>
          l.includes("Conditions:")
        );

        let relevantOutput = "";
        if (conditionsStart >= 0) {
          relevantOutput +=
            describeLines.slice(conditionsStart, eventsStart >= 0 ? eventsStart : undefined).join("\n") + "\n";
        }
        if (eventsStart >= 0) {
          relevantOutput += describeLines.slice(eventsStart, eventsStart + 20).join("\n");
        }

        pod.reason = (pod.reason || "") + "\n\nPod Details:\n" + relevantOutput.substring(0, 500);
      }
    }

    blockers.push({
      code: "PODS_NOT_READY",
      message: `Not all pods in namespace '${namespace}' are ready after 15 minutes. ${evidence.pods.readyCount}/${evidence.pods.total} pods ready. Not ready: ${evidence.pods.notReady.map((p) => p.name).join(", ")}.${evidence.pods.eventsTail ? `\n\nRecent events:\n${evidence.pods.eventsTail}` : ""}\n\nTo diagnose:\n  kubectl get pods -n ${namespace} -o wide\n  kubectl describe pod <pod-name> -n ${namespace}\n  kubectl get events -n ${namespace} --sort-by=.lastTimestamp | tail -n 25`,
    });

    return { ok: false, evidence, blockers };
  }

  // All pods are ready
  const finalPodsCheck = await kubectl(
    ["get", "pods", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION }
  );

  if (finalPodsCheck.ok) {
    try {
      const podsData = JSON.parse(finalPodsCheck.stdout);
      const pods = podsData.items || [];
      evidence.pods.total = pods.length;
      evidence.pods.readyCount = 0;

      for (const pod of pods) {
        const readyCondition = pod.status?.conditions?.find(
          (c: any) => c.type === "Ready"
        );
        if (readyCondition && readyCondition.status === "True") {
          evidence.pods.readyCount++;
        }
      }

      evidence.pods.ready = evidence.pods.readyCount === evidence.pods.total;
    } catch (e) {
      // Ignore parse errors
    }
  }

  return {
    ok: blockers.length === 0,
    evidence,
    blockers,
  };
}
