import { kubectl } from "./kubectl.js";

export type CrashAnalysis = {
  code: string;
  message: string;
  remediation?: string;
};

/**
 * Crash loop analyzer: detects common crash patterns and returns actionable blockers
 */
export async function analyzeCrashLoop(
  podName: string,
  namespace: string,
  env: { AWS_PROFILE?: string; AWS_REGION?: string; S3_BUCKET?: string; CLUSTER_NAME?: string }
): Promise<CrashAnalysis | null> {
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

/**
 * Capture pod diagnostics: events and describe output
 */
export async function capturePodDiagnostics(
  podName: string,
  namespace: string,
  profile: string,
  region: string
): Promise<{ events: string; describe: string }> {
  const eventsResult = await kubectl(
    ["get", "events", "-n", namespace, "--field-selector", `involvedObject.name=${podName}`, "--sort-by=.lastTimestamp"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  const describeResult = await kubectl(
    ["describe", "pod", podName, "-n", namespace],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  return {
    events: eventsResult.ok ? eventsResult.stdout : "Failed to get events",
    describe: describeResult.ok ? describeResult.stdout : "Failed to describe pod"
  };
}

/**
 * Capture recent namespace events
 */
export async function captureNamespaceEvents(
  namespace: string,
  profile: string,
  region: string,
  limit: number = 25
): Promise<string> {
  const eventsResult = await kubectl(
    ["get", "events", "-n", namespace, "--sort-by=.lastTimestamp", "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (eventsResult.ok) {
    try {
      const eventsData = JSON.parse(eventsResult.stdout);
      const events = eventsData.items || [];
      return events
        .slice(-limit)
        .map((e: any) => `${e.lastTimestamp || ""} ${e.type || ""} ${e.reason || ""} ${e.message || ""}`)
        .join("\n");
    } catch (e) {
      return "Failed to parse events JSON";
    }
  }

  return "Failed to get events";
}
