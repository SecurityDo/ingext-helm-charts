import { setupKarpenter, checkKarpenterInstalled, checkKarpenterReady, repairKarpenter, captureKarpenterDiagnostics } from "../../tools/karpenter.js";
import { checkPlatformHealth } from "../../tools/platform.js";
import { getPodEvents, getPodsInNamespace } from "../../tools/kubectl.js";

export type Phase3Evidence = {
  platform: {
    nodesTotal: number;
    nodesReady: number;
    corednsReady: boolean;
    platformHealthy: boolean;
  };
  karpenter: {
    release: {
      exists: boolean;
      status: string;  // "deployed" | "failed" | etc.
      revision: number;
    };
    existed: boolean;
    installed: boolean;  // true only if status is "deployed"
    needsRepair: boolean;
    repairAttempted: boolean;
    repairSucceeded: boolean;
    version: string;
    namespace: string;
    controllerReady: boolean;
    scriptRan: boolean;
    pendingPods: Array<{
      name: string;
      events: string;
    }>;
  };
};

export async function runPhase3Compute(
  env: Record<string, string>,
  options?: { force?: boolean; verbose?: boolean }
): Promise<{
  ok: boolean;
  evidence: Phase3Evidence;
  blockers: Array<{ code: string; message: string }>;
}> {
  const verbose = options?.verbose !== false;
  const blockers: Array<{ code: string; message: string }> = [];
  
  const clusterName = env.CLUSTER_NAME;
  const region = env.AWS_REGION;
  const profile = env.AWS_PROFILE;

  const evidence: Phase3Evidence = {
    platform: {
      nodesTotal: 0,
      nodesReady: 0,
      corednsReady: false,
      platformHealthy: false,
    },
    karpenter: {
      release: { exists: false, status: "unknown", revision: 0 },
      existed: false,
      installed: false,
      needsRepair: false,
      repairAttempted: false,
      repairSucceeded: false,
      version: "unknown",
      namespace: "kube-system",
      controllerReady: false,
      scriptRan: false,
      pendingPods: [],
    },
  };

  // STEP 1: Check platform health (nodes + CoreDNS)
  const platformHealth = await checkPlatformHealth(profile, region);
  evidence.platform = {
    nodesTotal: platformHealth.nodes.total,
    nodesReady: platformHealth.nodes.ready,
    corednsReady: platformHealth.coredns.ready,
    platformHealthy: platformHealth.healthy,
  };

  if (!platformHealth.healthy) {
    blockers.push(...platformHealth.blockers);
    // Add remediation hint
    if (platformHealth.nodes.total === 0) {
      blockers.push({
        code: "PHASE1_INCOMPLETE",
        message: "Phase 1 may not have completed successfully. Re-run Phase 1 or check eksctl logs.",
      });
    }
    return { ok: false, evidence, blockers };
  }

  // STEP 2: Check if Karpenter is already installed
  const installCheck = await checkKarpenterInstalled(profile, region);
  evidence.karpenter.existed = installCheck.exists;
  evidence.karpenter.release = {
    exists: installCheck.exists,
    status: installCheck.status || "unknown",
    revision: installCheck.revision || 0,
  };

  // STEP 3: Handle different installation states
  if (installCheck.needsRepair) {
    // Helm release exists but status is "failed" - attempt repair
    evidence.karpenter.needsRepair = true;
    evidence.karpenter.repairAttempted = true;
    
    // Capture diagnostics before repair
    const diagnostics = await captureKarpenterDiagnostics(profile, region);
    
    const repairResult = await repairKarpenter(profile, region, clusterName);
    evidence.karpenter.repairSucceeded = repairResult.ok;
    
    if (!repairResult.ok) {
      // Build comprehensive error message with diagnostics
      let errorMessage = `Failed to repair Karpenter installation: ${repairResult.stderr.split("\n").slice(-5).join("\n")}\n\n`;
      
      errorMessage += "Diagnostics captured before repair:\n";
      if (diagnostics.deploymentStatus) {
        errorMessage += `Deployment Status: ${diagnostics.deploymentStatus}\n`;
      }
      if (diagnostics.helmHistory) {
        errorMessage += `Helm History:\n${diagnostics.helmHistory}\n`;
      }
      if (diagnostics.podEvents) {
        const eventsExcerpt = diagnostics.podEvents.split("\n").slice(0, 20).join("\n");
        errorMessage += `Pod Events:\n${eventsExcerpt}\n`;
      }
      if (diagnostics.podLogs) {
        const logsExcerpt = diagnostics.podLogs.split("\n").slice(-30).join("\n");
        errorMessage += `Pod Logs (last 30 lines):\n${logsExcerpt}\n`;
      }
      
      errorMessage += "\nRecommended diagnostic commands:\n";
      errorMessage += "  kubectl -n kube-system describe pod -l app.kubernetes.io/name=karpenter\n";
      errorMessage += "  kubectl -n kube-system logs -l app.kubernetes.io/name=karpenter --tail=100\n";
      errorMessage += "  helm history karpenter -n kube-system\n";
      errorMessage += "  kubectl get nodes -o wide\n";
      
      blockers.push({
        code: "KARPENTER_REPAIR_FAILED",
        message: errorMessage,
      });
      return { ok: false, evidence, blockers };
    }
    
    // Re-check after repair
    const postRepairCheck = await checkKarpenterInstalled(profile, region);
    evidence.karpenter.installed = postRepairCheck.installed;
    evidence.karpenter.version = postRepairCheck.version || "unknown";
    evidence.karpenter.release.status = postRepairCheck.status || "unknown";
  } else if (!installCheck.installed && !installCheck.exists) {
    // Fresh installation needed
    const setupResult = await setupKarpenter(profile, region, clusterName);
    evidence.karpenter.scriptRan = true;
    
    if (!setupResult.ok) {
      let errorMessage = `Karpenter setup failed: ${setupResult.stderr.split("\n").slice(-10).join("\n")}\n\n`;
      errorMessage += "Recommended diagnostic commands:\n";
      errorMessage += "  kubectl -n kube-system get pods -l app.kubernetes.io/name=karpenter\n";
      errorMessage += "  helm list -n kube-system -a | grep karpenter\n";
      errorMessage += "  aws iam get-role --role-name KarpenterControllerRole-<cluster>\n";
      errorMessage += "  eksctl get podidentityassociation --cluster <cluster>\n";
      errorMessage += "\nCommon fixes:\n";
      errorMessage += "  • Verify IAM roles exist and have correct policies\n";
      errorMessage += "  • Check pod identity association is created\n";
      errorMessage += "  • Ensure VPC subnets are tagged with karpenter.sh/discovery\n";
      errorMessage += "  • Verify cluster has available node capacity\n";
      
      blockers.push({
        code: "KARPENTER_SETUP_FAILED",
        message: errorMessage,
      });
      return { ok: false, evidence, blockers };
    }

    // Re-check after installation
    const postInstallCheck = await checkKarpenterInstalled(profile, region);
    evidence.karpenter.installed = postInstallCheck.installed;
    evidence.karpenter.version = postInstallCheck.version || "unknown";
    evidence.karpenter.release = {
      exists: postInstallCheck.exists,
      status: postInstallCheck.status || "unknown",
      revision: postInstallCheck.revision || 0,
    };
  } else if (installCheck.installed) {
    // Already installed and healthy
    evidence.karpenter.installed = true;
    evidence.karpenter.version = installCheck.version || "unknown";
  }

  // STEP 4: Verify controller is ready
  const readyCheck = await checkKarpenterReady(profile, region);
  evidence.karpenter.controllerReady = readyCheck.ready;

  if (!readyCheck.ready) {
    // STEP 5: Capture pod events if not ready
    const podsResult = await getPodsInNamespace(
      "kube-system",
      "app.kubernetes.io/name=karpenter",
      profile,
      region
    );

    if (podsResult.ok && podsResult.pods.length > 0) {
      for (const pod of podsResult.pods.slice(0, 2)) {  // Limit to first 2 pods
        const podName = pod.metadata.name;
        const phase = pod.status.phase;
        
        if (phase === "Pending") {
          const eventsResult = await getPodEvents(podName, "kube-system", profile, region);
          if (eventsResult.ok) {
            evidence.karpenter.pendingPods.push({
              name: podName,
              events: eventsResult.events,
            });
          }
        }
      }
    }

    // Create actionable blocker with events and diagnostic commands
    let blockerMessage = "Karpenter controller deployment is not ready.";
    if (evidence.karpenter.pendingPods.length > 0) {
      const firstPodEvents = evidence.karpenter.pendingPods[0].events;
      const schedulingReason = firstPodEvents.split("\n")
        .find(line => line.includes("FailedScheduling"))
        ?.trim() || "";
      
      if (schedulingReason) {
        blockerMessage += `\n\nScheduling issue:\n${schedulingReason}\n`;
      }
    }

    blockerMessage += "\n\nRecommended diagnostic commands:\n";
    blockerMessage += "  kubectl -n kube-system describe pod -l app.kubernetes.io/name=karpenter\n";
    blockerMessage += "  kubectl -n kube-system logs -l app.kubernetes.io/name=karpenter --tail=100\n";
    blockerMessage += "  kubectl get nodes -o wide\n";
    blockerMessage += "  kubectl -n kube-system get events --sort-by=.lastTimestamp | tail -n 25\n";
    blockerMessage += "\nCommon fixes:\n";
    blockerMessage += "  • Ensure nodes have capacity: kubectl get nodes\n";
    blockerMessage += "  • Check IAM roles: aws iam get-role --role-name KarpenterControllerRole-<cluster>\n";
    blockerMessage += "  • Verify pod identity: eksctl get podidentityassociation --cluster <cluster>\n";
    blockerMessage += "  • Check VPC tags: aws ec2 describe-subnets --filters Name=tag:karpenter.sh/discovery,Values=<cluster>\n";

    blockers.push({
      code: "KARPENTER_NOT_READY",
      message: blockerMessage,
    });
  }

  // FINAL: Phase 3 is only "complete" if controller is Ready
  return {
    ok: evidence.karpenter.controllerReady || options?.force || false,
    evidence,
    blockers,
  };
}
