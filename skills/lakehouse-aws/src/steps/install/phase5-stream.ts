import { checkPlatformHealth } from "../../tools/platform.js";
import { kubectl, waitForPodsReady } from "../../tools/kubectl.js";
import { upgradeInstall, helm, isHelmLocked, waitForHelmReady } from "../../tools/helm.js";
import { analyzeCrashLoop, captureNamespaceEvents, capturePodDiagnostics } from "../../tools/diagnostics.js";

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

  // We remove --wait here to avoid the generic "context deadline exceeded" error
  // and instead rely on our more diagnostic waitForPodsReady below.
  const communityResult = await helm(
    [
      "upgrade", "--install", "ingext-community",
      "oci://public.ecr.aws/ingext/ingext-community",
      "--namespace", namespace,
      // We removed --wait and --timeout 15m to handle the wait in a more robust way below
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

  // Step 4: Wait for pods to be ready
  if (verbose) console.error(`\n⏳ Waiting for application pods to be Ready (max 15 minutes)...`);
  
  const waitResult = await waitForPodsReady(namespace, env.AWS_PROFILE!, env.AWS_REGION!, {
    maxWaitMinutes: 15,
    verbose,
    description: "Phase 5 (Stream) pods"
  });

  evidence.pods.ready = waitResult.ok;
  evidence.pods.total = waitResult.total;
  evidence.pods.readyCount = waitResult.ready;

  if (!waitResult.ok) {
    // Capture diagnostics
    evidence.pods.eventsTail = await captureNamespaceEvents(namespace, env.AWS_PROFILE!, env.AWS_REGION!);
    evidence.pods.crashAnalysis = [];
    
    for (const pod of waitResult.notReadyPods) {
      const podName = pod.metadata?.name || "unknown";
      const podStatus = pod.status?.phase || "Unknown";
      
      const crashAnalysis = await analyzeCrashLoop(podName, namespace, { AWS_PROFILE: env.AWS_PROFILE, AWS_REGION: env.AWS_REGION });
      
      if (crashAnalysis) {
        // Self-healing: if RBAC failed, kick the pod once
        if (crashAnalysis.code === "RBAC_MISSING_PERMISSIONS" && options.force !== true) {
          if (verbose) console.error(`   Attempting self-healing: kicking pod ${podName} due to RBAC issue...`);
          await kubectl(["delete", "pod", podName, "-n", namespace], { AWS_PROFILE: env.AWS_PROFILE!, AWS_REGION: env.AWS_REGION! });
          // Wait a bit for restart
          await new Promise(resolve => setTimeout(resolve, 5000));
        }

        evidence.pods.crashAnalysis.push({
          podName,
          ...crashAnalysis
        });
        
        blockers.push({
          code: crashAnalysis.code,
          message: `${crashAnalysis.message}${crashAnalysis.remediation ? `\n\nRemediation:\n${crashAnalysis.remediation}` : ""}`,
        });
      } else {
        const podDiag = await capturePodDiagnostics(podName, namespace, env.AWS_PROFILE!, env.AWS_REGION!);
        blockers.push({
          code: "POD_NOT_READY",
          message: `Pod ${podName} is not ready (${podStatus}).\n\nRecent events:\n${podDiag.events.split("\n").slice(0, 10).join("\n")}`,
        });
      }

      evidence.pods.notReady.push({
        name: podName,
        status: podStatus,
        reason: pod.status?.conditions?.find((c: any) => c.type === "Ready")?.reason
      });
    }

    if (blockers.length === 0) {
      blockers.push({
        code: "PODS_NOT_READY",
        message: `Timeout waiting for pods to be ready in namespace ${namespace}.`,
      });
    }

    return { ok: false, evidence, blockers };
  }

  return {
    ok: blockers.length === 0 && evidence.pods.ready,
    evidence,
    blockers,
  };
}
