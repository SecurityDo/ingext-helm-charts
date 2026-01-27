import { run } from "./shell.js";

export type Env = Record<string, string>;

export async function kubectl(args: string[], env?: Env) {
  return run("kubectl", args, env);
}

export async function getNodes(env?: Env) {
  return kubectl(["get", "nodes", "--output", "json"], env);
}

export async function apply(manifest: string, env?: Env) {
  return kubectl(["apply", "-f", "-"], env);
}

export async function getPodEvents(
  podName: string,
  namespace: string,
  profile: string,
  region: string
): Promise<{ ok: boolean; events: string }> {
  const result = await kubectl(
    ["describe", "pod", podName, "-n", namespace],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (result.ok) {
    // Extract Events section
    const lines = result.stdout.split("\n");
    const eventsIndex = lines.findIndex(line => line.startsWith("Events:"));
    if (eventsIndex !== -1) {
      const events = lines.slice(eventsIndex, eventsIndex + 15).join("\n");
      return { ok: true, events };
    }
  }

  return { ok: false, events: "" };
}

export async function getPodsInNamespace(
  namespace: string,
  labelSelector: string,
  profile: string,
  region: string
): Promise<{ ok: boolean; pods: any[] }> {
  const result = await kubectl(
    ["get", "pods", "-n", namespace, "-l", labelSelector, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (result.ok) {
    try {
      const data = JSON.parse(result.stdout);
      return { ok: true, pods: data.items || [] };
    } catch (e) {
      return { ok: false, pods: [] };
    }
  }

  return { ok: false, pods: [] };
}

/**
 * Wait for pods in a namespace to be ready
 */
export async function waitForPodsReady(
  namespace: string,
  profile: string,
  region: string,
  options: { 
    labelSelector?: string; 
    maxWaitMinutes?: number; 
    pollIntervalSeconds?: number;
    verbose?: boolean;
    description?: string;
  } = {}
): Promise<{ ok: boolean; total: number; ready: number; error?: string }> {
  const maxWaitMinutes = options.maxWaitMinutes || 5;
  const maxWaitSeconds = maxWaitMinutes * 60;
  const pollIntervalSeconds = options.pollIntervalSeconds || 15;
  const verbose = options.verbose !== false;
  const description = options.description || `pods in namespace '${namespace}'`;
  
  const startTime = Date.now();
  let lastStatus = "";
  
  if (verbose) {
    console.error(`⏳ Waiting for ${description} to be Ready (max ${maxWaitMinutes} minutes)...`);
  }
  
  while (true) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed > maxWaitSeconds) {
      return { 
        ok: false, 
        total: 0, 
        ready: 0, 
        error: `Timeout waiting for ${description} after ${maxWaitMinutes} minutes.` 
      };
    }
    
    const args = ["get", "pods", "-n", namespace, "-o", "json"];
    if (options.labelSelector) {
      args.push("-l", options.labelSelector);
    }
    
    const result = await kubectl(args, { AWS_PROFILE: profile, AWS_REGION: region });
    
    if (result.ok) {
      try {
        const data = JSON.parse(result.stdout);
        const pods = data.items || [];
        
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
        
        if (activePods.length === 0) {
          // No active pods yet, wait
          if (verbose) {
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            process.stderr.write(`\r   [${minutes}m ${seconds}s] No active pods found yet, waiting...${" ".repeat(20)}`);
          }
        } else {
          let readyCount = 0;
          const notReadyNames: string[] = [];
          
          for (const pod of activePods) {
            const containerStatuses = pod.status.containerStatuses || [];
            const readyCondition = pod.status?.conditions?.find((c: any) => c.type === "Ready");
            const isReady = readyCondition && readyCondition.status === "True";
            
            if (isReady) {
              readyCount++;
            } else {
              notReadyNames.push(pod.metadata?.name || "unknown");
            }
          }
          
          const statusSummary = `${readyCount}/${activePods.length} pods ready`;
          if (verbose && statusSummary !== lastStatus) {
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            process.stderr.write(`\r   [${minutes}m ${seconds}s] ${statusSummary}. Waiting for: ${notReadyNames.slice(0, 2).join(", ")}${notReadyNames.length > 2 ? ` (+${notReadyNames.length-2})` : ""}${" ".repeat(20)}`);
            lastStatus = statusSummary;
          }
          
          if (readyCount > 0 && readyCount === activePods.length) {
            if (verbose) {
              process.stderr.write(`\n✓ All ${activePods.length} pods are Ready!\n`);
            }
            return { ok: true, total: activePods.length, ready: readyCount };
          }
        }
      } catch (e) { /* ignore parse errors */ }
    }
    
    await new Promise(resolve => setTimeout(resolve, pollIntervalSeconds * 1000));
  }
}
