import { kubectl } from "../../tools/kubectl.js";
import { upgradeInstall, helm } from "../../tools/helm.js";
import { headBucket } from "../../tools/aws.js";
import { checkKarpenterReady, checkKarpenterInstalled } from "../../tools/karpenter.js";
import { eksctl } from "../../tools/eksctl.js";

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

// Crash loop analyzer: detects common crash patterns and returns actionable blockers
// (Reused from Phase 5)
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
    (logs.includes("environment variable") && logs.includes("not set"))
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
    (logs.includes("mount") && (logs.includes("failed") || logs.includes("error")))
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

  // Pattern 7: S3 access denied / IAM permission issues
  if (
    logs.includes("AccessDenied") ||
    logs.includes("access denied") ||
    (logs.includes("403") && logs.includes("s3")) ||
    (logs.includes("Forbidden") && logs.includes("s3"))
  ) {
    const bucketMatch = logs.match(/s3:\/\/([a-z0-9-]+)/i);
    const bucket = bucketMatch ? bucketMatch[1] : env.S3_BUCKET || "unknown";
    
    return {
      code: "S3_ACCESS_DENIED",
      message: `Pod ${podName} cannot access S3 bucket '${bucket}'. Check IAM policy and pod identity association.`,
      remediation: `Check pod identity: eksctl get podidentityassociation --cluster ${env.CLUSTER_NAME || "CLUSTER"} --namespace ${namespace}\n  Check IAM policy: aws iam get-policy --policy-arn <policy-arn>\n  Check bucket access: aws s3 ls s3://${bucket}`,
    };
  }

  return null; // No pattern matched
}

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

  // Gate A: Stream Health - Check Phase 5 pods (api-0, platform-0) are Ready
  const streamPodsCheck = await kubectl(
    ["get", "pods", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (streamPodsCheck.ok) {
    try {
      const podsData = JSON.parse(streamPodsCheck.stdout);
      const pods = podsData.items || [];
      let apiReady = false;
      let platformReady = false;

      for (const pod of pods) {
        const podName = pod.metadata?.name || "";
        const readyCondition = pod.status?.conditions?.find(
          (c: any) => c.type === "Ready"
        );
        const isReady = readyCondition && readyCondition.status === "True";

        if (podName.startsWith("api-")) {
          apiReady = isReady;
        } else if (podName.startsWith("platform-")) {
          platformReady = isReady;
        }
      }

      evidence.gates.streamHealthy = apiReady && platformReady;

      if (!evidence.gates.streamHealthy && !options.force) {
        blockers.push({
          code: "STREAM_PODS_NOT_READY",
          message: `Phase 5 Stream pods (api-0, platform-0) are not all ready. Ensure Phase 5 completes successfully before proceeding. Use --force to bypass.`,
        });
        return { ok: false, evidence, blockers };
      }
    } catch (e) {
      // Ignore parse errors, but don't mark as healthy
      if (!options.force) {
        blockers.push({
          code: "STREAM_PODS_CHECK_FAILED",
          message: `Failed to check Phase 5 Stream pods status. Use --force to bypass.`,
        });
        return { ok: false, evidence, blockers };
      }
    }
  } else {
    if (!options.force) {
      blockers.push({
        code: "STREAM_PODS_CHECK_FAILED",
        message: `Failed to check Phase 5 Stream pods: ${streamPodsCheck.stderr}. Use --force to bypass.`,
      });
      return { ok: false, evidence, blockers };
    }
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
      "--wait",
      "--timeout", "10m"
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
      "--wait",
      "--timeout", "10m"
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
  const lakeResult = await helm(
    [
      "upgrade", "--install", "ingext-lake",
      "oci://public.ecr.aws/ingext/ingext-lake",
      "--namespace", namespace,
      "--wait",
      "--timeout", "15m"
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

  // Step 5: Wait for pods to be ready (with diagnostics on timeout)
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
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (!waitResult.ok) {
    // Capture diagnostics
    const podsCheck = await kubectl(
      ["get", "pods", "-n", namespace, "-o", "wide"],
      { AWS_PROFILE: profile, AWS_REGION: region }
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
      { AWS_PROFILE: profile, AWS_REGION: region }
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
        { AWS_PROFILE: profile, AWS_REGION: region }
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

    // Classify failure types for better diagnostics
    const pendingPods = evidence.pods.notReady.filter(p => p.status === "Pending");
    const crashLoopPods = evidence.pods.notReady.filter(p => 
      p.status === "CrashLoopBackOff" || p.reason?.includes("CrashLoopBackOff")
    );
    const otherNotReady = evidence.pods.notReady.filter(p => 
      p.status !== "Pending" && p.status !== "CrashLoopBackOff"
    );

    let classification = "";
    if (pendingPods.length > 0) {
      classification += `\n• Pending pods (${pendingPods.length}): ${pendingPods.map(p => p.name).join(", ")} → likely compute/Karpenter/capacity issue`;
    }
    if (crashLoopPods.length > 0) {
      const crashCodes = evidence.pods.crashAnalysis?.map(a => a.code) || [];
      if (crashCodes.includes("RBAC_MISSING_PERMISSIONS")) {
        classification += `\n• CrashLoop pods (${crashLoopPods.length}): ${crashLoopPods.map(p => p.name).join(", ")} → RBAC permissions issue`;
      } else if (crashCodes.includes("S3_ACCESS_DENIED")) {
        classification += `\n• CrashLoop pods (${crashLoopPods.length}): ${crashLoopPods.map(p => p.name).join(", ")} → S3 access/IAM issue`;
      } else {
        classification += `\n• CrashLoop pods (${crashLoopPods.length}): ${crashLoopPods.map(p => p.name).join(", ")} → check crash analysis below`;
      }
    }
    if (otherNotReady.length > 0) {
      classification += `\n• Other not ready (${otherNotReady.length}): ${otherNotReady.map(p => `${p.name} (${p.status})`).join(", ")}`;
    }

    blockers.push({
      code: "PODS_NOT_READY",
      message: `Not all pods in namespace '${namespace}' are ready after 15 minutes. ${evidence.pods.readyCount}/${evidence.pods.total} pods ready.${classification}${evidence.pods.eventsTail ? `\n\nRecent events:\n${evidence.pods.eventsTail}` : ""}\n\nTo diagnose:\n  kubectl get pods -n ${namespace} -o wide\n  kubectl describe pod <pod-name> -n ${namespace}\n  kubectl get events -n ${namespace} --sort-by=.lastTimestamp | tail -n 25`,
    });

    return { ok: false, evidence, blockers };
  }

  // All pods are ready
  const finalPodsCheck = await kubectl(
    ["get", "pods", "-n", namespace, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
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
