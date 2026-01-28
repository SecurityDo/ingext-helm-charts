import { kubectl, waitForPodsReady } from "../../tools/kubectl.js";
import { upgradeInstall, helm, isHelmLocked, waitForHelmReady } from "../../tools/helm.js";
import { headBucket } from "../../tools/aws.js";
import { checkKarpenterReady, checkKarpenterInstalled } from "../../tools/karpenter.js";
import { eksctl } from "../../tools/eksctl.js";
import { analyzeCrashLoop, captureNamespaceEvents, capturePodDiagnostics } from "../../tools/diagnostics.js";

export type Phase6Evidence = {
  gates: {
    streamHealthy: boolean;
    storageReady: boolean;
    karpenterHealthy: boolean;
  };
  lakeConfigInstalled: boolean;
  nodePoolsInstalled: string[];
  rbacVerified: boolean;
  s3LakeInstalled: boolean;
  lakeInstalled: boolean;
  helm: {
    releases: Array<{
      name: string;
      status: string;
      revision: number;
      chart: string;
      elapsedSeconds?: number;
      error?: string;
    }>;
  };
  nodePools: {
    merge: { installed: boolean; status?: string; verified?: boolean };
    search: { installed: boolean; status?: string; verified?: boolean };
  };
  pods: {
    ready: boolean;
    total: number;
    readyCount: number;
    notReady: Array<{ name: string; status: string; reason?: string }>;
    eventsTail?: string;
    crashAnalysis?: Array<{
      podName: string;
      code: string;
      message: string;
      remediation?: string;
    }>;
  };
};

export async function runPhase6Datalake(
  env: Record<string, string>,
  options: { force?: boolean; verbose?: boolean } = {}
): Promise<{
  ok: boolean;
  evidence: Phase6Evidence;
  blockers: Array<{ code: string; message: string }>;
}> {
  const verbose = options?.verbose !== false;
  const blockers: Array<{ code: string; message: string }> = [];
  const namespace = env.NAMESPACE || "ingext";
  const bucketName = env.S3_BUCKET;
  const clusterName = env.CLUSTER_NAME;
  const profile = env.AWS_PROFILE;
  const region = env.AWS_REGION;
  const serviceAccountName = `${namespace}-sa`;

  const evidence: Phase6Evidence = {
    gates: {
      streamHealthy: false,
      storageReady: false,
      karpenterHealthy: false,
    },
    lakeConfigInstalled: false,
    nodePoolsInstalled: [],
    rbacVerified: false,
    s3LakeInstalled: false,
    lakeInstalled: false,
    helm: {
      releases: [],
    },
    nodePools: {
      merge: { installed: false },
      search: { installed: false },
    },
    pods: {
      ready: false,
      total: 0,
      readyCount: 0,
      notReady: [],
    },
  };

  // Gate A: Stream Health - Check Phase 5 pods (api-0, platform-0) are Ready (graceful wait)
  if (verbose) console.error(`   Checking Phase 5 (Stream) pods readiness...`);
  const streamWait = await waitForPodsReady(namespace, profile, region, {
    maxWaitMinutes: 5,
    verbose,
    description: "Phase 5 (Stream) pods",
    // Specifically looking for api and platform pods
    labelSelector: "ingext.io/app in (api, platform)" 
  });

  evidence.gates.streamHealthy = streamWait.ok;

  if (!streamWait.ok && !options.force) {
    blockers.push({
      code: "STREAM_PODS_NOT_READY",
      message: `Phase 5 Stream pods are not all ready after waiting. Ensure Phase 5 completes successfully before proceeding. Use --force to bypass.`,
    });
    return { ok: false, evidence, blockers };
  }

  // Gate B: Storage Readiness - Verify S3 bucket exists and accessible, pod identity association exists
  const bucketCheck = await headBucket(bucketName, profile, region);
  evidence.gates.storageReady = bucketCheck.exists;

  if (!bucketCheck.exists) {
    if (!options.force) {
      blockers.push({
        code: "S3_BUCKET_NOT_FOUND",
        message: `S3 bucket '${bucketName}' does not exist. Run Phase 2: Storage to create it. Use --force to bypass.`,
      });
      return { ok: false, evidence, blockers };
    }
  } else {
    // Verify bucket access by attempting head-bucket again (already done, but we can verify)
    // Also check pod identity association
    const podIdentityCheck = await eksctl(
      [
        "get",
        "podidentityassociation",
        "--cluster",
        clusterName,
        "--namespace",
        namespace,
        "--service-account-name",
        serviceAccountName,
        "--region",
        region,
      ],
      { AWS_PROFILE: profile, AWS_DEFAULT_REGION: region }
    );

    // If eksctl get fails, try checking ServiceAccount annotation as fallback
    if (!podIdentityCheck.ok) {
      const saCheck = await kubectl(
        ["get", "serviceaccount", serviceAccountName, "-n", namespace, "-o", "json"],
        { AWS_PROFILE: profile, AWS_REGION: region }
      );

      if (saCheck.ok) {
        try {
          const saData = JSON.parse(saCheck.stdout);
          const roleArn = saData.metadata?.annotations?.["eks.amazonaws.com/role-arn"];
          if (roleArn) {
            evidence.gates.storageReady = true; // Pod identity exists via annotation
          } else {
            if (!options.force) {
              blockers.push({
                code: "POD_IDENTITY_NOT_FOUND",
                message: `Pod identity association for service account '${serviceAccountName}' not found. Run Phase 2: Storage to create it. Use --force to bypass.`,
              });
              return { ok: false, evidence, blockers };
            }
          }
        } catch (e) {
          // Ignore parse errors
        }
      } else {
        if (!options.force) {
          blockers.push({
            code: "POD_IDENTITY_CHECK_FAILED",
            message: `Failed to verify pod identity association. Service account may not exist. Use --force to bypass.`,
          });
          return { ok: false, evidence, blockers };
        }
      }
    } else {
      evidence.gates.storageReady = true; // Pod identity exists
    }
  }

  // Gate C: Karpenter Health - Check deployment is Ready and no scheduling issues
  const karpenterCheck = await checkKarpenterInstalled(profile, region);
  if (karpenterCheck.exists) {
    const karpenterReady = await checkKarpenterReady(profile, region);
    evidence.gates.karpenterHealthy = karpenterReady.ready;

    if (!karpenterReady.ready) {
      // Check for scheduling issues in kube-system events
      const eventsResult = await kubectl(
        ["get", "events", "-n", "kube-system", "--sort-by=.lastTimestamp", "-o", "json"],
        { AWS_PROFILE: profile, AWS_REGION: region }
      );

      let schedulingIssues = "";
      if (eventsResult.ok) {
        try {
          const eventsData = JSON.parse(eventsResult.stdout);
          const events = eventsData.items || [];
          const recentEvents = events.slice(-25);
          const failedScheduling = recentEvents.filter((e: any) =>
            e.reason === "FailedScheduling" ||
            e.message?.includes("no nodes available") ||
            e.message?.includes("Insufficient resources")
          );

          if (failedScheduling.length > 0) {
            schedulingIssues = failedScheduling
              .map((e: any) => `${e.lastTimestamp || ""} ${e.reason || ""} ${e.message || ""}`)
              .join("\n");
          }
        } catch (e) {
          // Ignore parse errors
        }
      }

      if (!options.force) {
        blockers.push({
          code: "KARPENTER_NOT_READY",
          message: `Karpenter deployment is not ready. Node pools may not provision correctly.${schedulingIssues ? `\n\nScheduling issues detected:\n${schedulingIssues}` : ""}\n\nUse --force to bypass.`,
        });
        return { ok: false, evidence, blockers };
      }
    }
  } else {
    if (!options.force) {
      blockers.push({
        code: "KARPENTER_NOT_INSTALLED",
        message: `Karpenter is not installed. Node pools require Karpenter. Run Phase 3: Compute to install it. Use --force to bypass.`,
      });
      return { ok: false, evidence, blockers };
    }
  }

  // Step 1: Check if already deployed and healthy (Smart Resume)
  const currentHelmReleases = await helm(
    ["list", "-a", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  
  let deployedReleases: any[] = [];
  if (currentHelmReleases.ok) {
    try {
      deployedReleases = JSON.parse(currentHelmReleases.stdout);
    } catch (e) { /* ignore */ }
  }

  const lakeCharts = ["ingext-lake-config", "ingext-merge-pool", "ingext-search-pool", "ingext-s3-lake", "ingext-lake"];
  const allDeployed = lakeCharts.every(c => deployedReleases.some((r: any) => r.name === c && r.status === "deployed"));
  
  if (allDeployed) {
    // Verify pods are ready
    const podsCheck = await kubectl(
      ["get", "pods", "-n", namespace, "-l", "app.kubernetes.io/part-of=ingext-lake", "-o", "json"],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );
    
    let allReady = false;
    if (podsCheck.ok) {
      try {
        const pods = JSON.parse(podsCheck.stdout).items || [];
        allReady = pods.length > 0 && pods.every((p: any) => p.status.phase === "Running" && p.status?.conditions?.some((c: any) => c.type === "Ready" && c.status === "True"));
      } catch (e) { /* ignore */ }
    }
    
    if (allReady) {
      if (verbose) process.stderr.write(`\n✓ Phase 6 Application Datalake is already complete and healthy. Skipping...\n`);
      evidence.pods.ready = true;
      lakeCharts.forEach(c => {
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

  // Step 1: Install ingext-lake-config
  const startTime1 = Date.now();
  const lakeConfigResult = await upgradeInstall(
    "ingext-lake-config",
    "oci://public.ecr.aws/ingext/ingext-lake-config",
    namespace,
    {
      storageType: "s3",
      "s3.bucket": bucketName,
      "s3.region": region,
      // Provide dummy values for other storage types to avoid Helm template nil pointer errors
      "gcs.bucket": "unused",
      "gcs.project": "unused",
      "blob.storageAccount": "unused",
      "blob.container": "unused",
    },
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  const elapsed1 = Math.floor((Date.now() - startTime1) / 1000);
  evidence.helm.releases.push({
    name: "ingext-lake-config",
    status: lakeConfigResult.ok ? "deployed" : "failed",
    revision: 1,
    chart: "oci://public.ecr.aws/ingext/ingext-lake-config",
    elapsedSeconds: elapsed1,
    error: lakeConfigResult.ok ? undefined : lakeConfigResult.stderr.substring(0, 500),
  });

  if (!lakeConfigResult.ok) {
    blockers.push({
      code: "HELM_INSTALL_FAILED",
      message: `Failed to install ingext-lake-config: ${lakeConfigResult.stderr.substring(0, 500)}`,
    });
    return { ok: false, evidence, blockers };
  }

  evidence.lakeConfigInstalled = true;

  // Verify configmaps/secrets created by ingext-lake-config (non-blocking, diagnostic)
  const cmCheck = await kubectl(
    ["get", "configmaps", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  if (cmCheck.ok) {
    try {
      const cmData = JSON.parse(cmCheck.stdout);
      const cms = cmData.items || [];
      const lakeConfigMaps = cms.filter((cm: any) => 
        cm.metadata?.name?.toLowerCase().includes("lake")
      );
      // Log findings (non-blocking)
    } catch (e) {
      // Ignore parse errors
    }
  }

  const secretCheck = await kubectl(
    ["get", "secrets", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  if (secretCheck.ok) {
    try {
      const secretData = JSON.parse(secretCheck.stdout);
      const secrets = secretData.items || [];
      const lakeSecrets = secrets.filter((s: any) => 
        s.metadata?.name?.toLowerCase().includes("lake")
      );
      // Log findings (non-blocking)
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Step 2: Install Node Pools
  // Install ingext-merge-pool
  const mergePoolStartTime = Date.now();
  const mergePoolResult = await helm(
    [
      "upgrade", "--install", "ingext-merge-pool",
      "oci://public.ecr.aws/ingext/ingext-eks-pool",
      "--namespace", namespace,
      "--set", `poolName=pool-merge`,
      "--set", `clusterName=${clusterName}`,
      // Removed --wait and --timeout as we verify below
    ],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  evidence.nodePools.merge.installed = mergePoolResult.ok;
  evidence.nodePools.merge.status = mergePoolResult.ok ? "deployed" : "failed";

  if (!mergePoolResult.ok) {
    blockers.push({
      code: "NODE_POOL_INSTALL_FAILED",
      message: `Failed to install ingext-merge-pool: ${mergePoolResult.stderr.substring(0, 500)}`,
    });
    return { ok: false, evidence, blockers };
  }

  // Install ingext-search-pool
  const searchPoolStartTime = Date.now();
  const searchPoolResult = await helm(
    [
      "upgrade", "--install", "ingext-search-pool",
      "oci://public.ecr.aws/ingext/ingext-eks-pool",
      "--namespace", namespace,
      "--set", `poolName=pool-search`,
      "--set", `clusterName=${clusterName}`,
      "--set", `cpuLimit=128`,
      "--set", `memoryLimit=512Gi`,
      // Removed --wait and --timeout as we verify below
    ],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  evidence.nodePools.search.installed = searchPoolResult.ok;
  evidence.nodePools.search.status = searchPoolResult.ok ? "deployed" : "failed";

  if (!searchPoolResult.ok) {
    blockers.push({
      code: "NODE_POOL_INSTALL_FAILED",
      message: `Failed to install ingext-search-pool: ${searchPoolResult.stderr.substring(0, 500)}`,
    });
    return { ok: false, evidence, blockers };
  }

  // Verify node pools exist (diagnostic, non-blocking)
  let mergePoolVerified = false;
  let searchPoolVerified = false;

  // Try Karpenter v1beta1 (nodepools)
  const nodepoolsCheck = await kubectl(
    ["get", "nodepools", "-A", "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  if (nodepoolsCheck.ok) {
    try {
      const nodepoolsData = JSON.parse(nodepoolsCheck.stdout);
      const nodepools = nodepoolsData.items || [];
      for (const np of nodepools) {
        const name = np.metadata?.name || "";
        if (name.includes("pool-merge") || name.includes("merge")) {
          mergePoolVerified = true;
          evidence.nodePools.merge.verified = true;
        }
        if (name.includes("pool-search") || name.includes("search")) {
          searchPoolVerified = true;
          evidence.nodePools.search.verified = true;
        }
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Try Karpenter v1alpha1 (provisioners) as fallback
  if (!mergePoolVerified || !searchPoolVerified) {
    const provisionersCheck = await kubectl(
      ["get", "provisioners", "-A", "-o", "json"],
      { AWS_PROFILE: profile, AWS_REGION: region }
    );
    if (provisionersCheck.ok) {
      try {
        const provisionersData = JSON.parse(provisionersCheck.stdout);
        const provisioners = provisionersData.items || [];
        for (const prov of provisioners) {
          const name = prov.metadata?.name || "";
          if (name.includes("pool-merge") || name.includes("merge")) {
            mergePoolVerified = true;
            evidence.nodePools.merge.verified = true;
          }
          if (name.includes("pool-search") || name.includes("search")) {
            searchPoolVerified = true;
            evidence.nodePools.search.verified = true;
          }
        }
      } catch (e) {
        // Ignore parse errors
      }
    }
  }

  // Try EC2NodeClass (Karpenter v1beta1) as additional check
  const ec2NodeClassCheck = await kubectl(
    ["get", "ec2nodeclasses", "-A", "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  if (ec2NodeClassCheck.ok) {
    try {
      const ec2Data = JSON.parse(ec2NodeClassCheck.stdout);
      const ec2Classes = ec2Data.items || [];
      // EC2NodeClasses are referenced by nodepools, so this is just a sanity check
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Update nodePoolsInstalled array
  if (mergePoolVerified) {
    evidence.nodePoolsInstalled.push("pool-merge");
  }
  if (searchPoolVerified) {
    evidence.nodePoolsInstalled.push("pool-search");
  }

  // Step 3: RBAC Verification (verify RBAC exists, not install - Phase 4 already did that)
  const rbacSecretsCheck = await kubectl(
    ["auth", "can-i", "get", "secrets", "-n", namespace, "--as", `system:serviceaccount:${namespace}:${serviceAccountName}`],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  const rbacConfigMapsCheck = await kubectl(
    ["auth", "can-i", "get", "configmaps", "-n", namespace, "--as", `system:serviceaccount:${namespace}:${serviceAccountName}`],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  evidence.rbacVerified = rbacSecretsCheck.ok && 
                          rbacSecretsCheck.stdout.trim().toLowerCase() === "yes" &&
                          rbacConfigMapsCheck.ok &&
                          rbacConfigMapsCheck.stdout.trim().toLowerCase() === "yes";

  if (!evidence.rbacVerified && !options.force) {
    blockers.push({
      code: "RBAC_NOT_VERIFIED",
      message: `RBAC permissions not verified for service account '${serviceAccountName}'. Secrets access: ${rbacSecretsCheck.ok && rbacSecretsCheck.stdout.trim() === "yes" ? "yes" : "no"}, ConfigMaps access: ${rbacConfigMapsCheck.ok && rbacConfigMapsCheck.stdout.trim() === "yes" ? "yes" : "no"}. Phase 4 should have installed ingext-manager-role. Use --force to bypass.`,
    });
    // Non-blocking if force is used (Phase 4 should have installed it)
  }

  // Step 3: Install ingext-s3-lake
  const startTime3 = Date.now();
  const s3LakeResult = await upgradeInstall(
    "ingext-s3-lake",
    "oci://public.ecr.aws/ingext/ingext-s3-lake",
    namespace,
    {
      "bucket.name": bucketName,
      "bucket.region": region,
    },
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  const elapsed3 = Math.floor((Date.now() - startTime3) / 1000);
  evidence.helm.releases.push({
    name: "ingext-s3-lake",
    status: s3LakeResult.ok ? "deployed" : "failed",
    revision: 1,
    chart: "oci://public.ecr.aws/ingext/ingext-s3-lake",
    elapsedSeconds: elapsed3,
    error: s3LakeResult.ok ? undefined : s3LakeResult.stderr.substring(0, 500),
  });

  if (!s3LakeResult.ok) {
    blockers.push({
      code: "HELM_INSTALL_FAILED",
      message: `Failed to install ingext-s3-lake: ${s3LakeResult.stderr.substring(0, 500)}`,
    });
    return { ok: false, evidence, blockers };
  }

  evidence.s3LakeInstalled = true;

  // Verify jobs/configmaps created by ingext-s3-lake (non-blocking, diagnostic)
  const jobsCheck = await kubectl(
    ["get", "jobs", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  if (jobsCheck.ok) {
    try {
      const jobsData = JSON.parse(jobsCheck.stdout);
      const jobs = jobsData.items || [];
      const s3LakeJobs = jobs.filter((job: any) => 
        job.metadata?.name?.toLowerCase().includes("s3") ||
        job.metadata?.name?.toLowerCase().includes("lake")
      );
      // Log findings (non-blocking)
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Check events for any immediate failures
  const eventsCheck = await kubectl(
    ["get", "events", "-n", namespace, "--sort-by=.lastTimestamp", "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );
  if (eventsCheck.ok) {
    try {
      const eventsData = JSON.parse(eventsCheck.stdout);
      const events = eventsData.items || [];
      const recentFailures = events.slice(-10).filter((e: any) => 
        e.type === "Warning" || e.reason?.includes("Failed")
      );
      // Log findings (non-blocking)
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Step 4: Install ingext-lake
  const startTime4 = Date.now();
  
  // Check if locked
  const lakeLocked = await isHelmLocked("ingext-lake", namespace, { AWS_PROFILE: profile, AWS_REGION: region });
  if (lakeLocked) {
    await waitForHelmReady("ingext-lake", namespace, { AWS_PROFILE: profile, AWS_REGION: region });
  }

  // We remove --wait here to avoid the generic "context deadline exceeded" error
  // and instead rely on our more diagnostic waitForPodsReady below.
  const lakeResult = await helm(
    [
      "upgrade", "--install", "ingext-lake",
      "oci://public.ecr.aws/ingext/ingext-lake",
      "--namespace", namespace,
      // We removed --wait and --timeout 15m to handle the wait in a more robust way below
    ],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  const elapsed4 = Math.floor((Date.now() - startTime4) / 1000);
  evidence.helm.releases.push({
    name: "ingext-lake",
    status: lakeResult.ok ? "deployed" : "failed",
    revision: 1,
    chart: "oci://public.ecr.aws/ingext/ingext-lake",
    elapsedSeconds: elapsed4,
    error: lakeResult.ok ? undefined : lakeResult.stderr.substring(0, 500),
  });

  if (!lakeResult.ok) {
    blockers.push({
      code: "HELM_INSTALL_FAILED",
      message: `Failed to install ingext-lake: ${lakeResult.stderr.substring(0, 500)}`,
    });
    return { ok: false, evidence, blockers };
  }

  evidence.lakeInstalled = true;

  // Step 5: Wait for pods to be ready
  if (verbose) console.error(`\n⏳ Waiting for datalake pods to be Ready (max 15 minutes)...`);
  
  const waitResult = await waitForPodsReady(namespace, env.AWS_PROFILE!, env.AWS_REGION!, {
    maxWaitMinutes: 15,
    verbose,
    description: "Phase 6 (Datalake) pods"
  });

  evidence.pods.ready = waitResult.ok;
  evidence.pods.total = waitResult.total;
  evidence.pods.readyCount = waitResult.ready;

  if (!waitResult.ok) {
    // Capture diagnostics
    evidence.pods.eventsTail = await captureNamespaceEvents(namespace, profile, region);
    evidence.pods.crashAnalysis = [];
    
    for (const pod of waitResult.notReadyPods) {
      const podName = pod.metadata?.name || "unknown";
      const podStatus = pod.status?.phase || "Unknown";
      
      const crashAnalysis = await analyzeCrashLoop(podName, namespace, { AWS_PROFILE: profile, AWS_REGION: region, S3_BUCKET: bucketName, CLUSTER_NAME: clusterName });
      
      if (crashAnalysis) {
        // Self-healing: if RBAC or S3 failed, kick the pod once
        if ((crashAnalysis.code === "RBAC_MISSING_PERMISSIONS" || crashAnalysis.code === "S3_ACCESS_DENIED") && options.force !== true) {
          if (verbose) console.error(`   Attempting self-healing: kicking pod ${podName} due to ${crashAnalysis.code}...`);
          await kubectl(["delete", "pod", podName, "-n", namespace], { AWS_PROFILE: profile, AWS_REGION: region });
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
        const podDiag = await capturePodDiagnostics(podName, namespace, profile, region);
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
