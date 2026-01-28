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
): Promise<{ 
  ok: boolean; 
  total: number; 
  ready: number; 
  notReadyPods: any[];
  error?: string;
}> {
  const maxWaitMinutes = options.maxWaitMinutes || 5;
  const maxWaitSeconds = maxWaitMinutes * 60;
  const pollIntervalSeconds = options.pollIntervalSeconds || 15;
  const verbose = options.verbose !== false;
  const description = options.description || `pods in namespace '${namespace}'`;
  
  const startTime = Date.now();
  let lastStatus = "";
  let lastLogTime = 0;
  let currentNotReadyPods: any[] = [];
  
  if (verbose) {
    console.error(`⏳ Waiting for ${description} to be Ready (max ${maxWaitMinutes} minutes)...`);
    // Initial feedback using console.error to ensure it bypasses any buffering
    console.error(`   [0m 0s elapsed, ${maxWaitMinutes}m 0s remaining] Initializing poll...`);
  }
  
  while (true) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed > maxWaitSeconds) {
      return { 
        ok: false, 
        total: 0, 
        ready: 0, 
        notReadyPods: currentNotReadyPods,
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
          
          // Exclude pods that are being deleted
          if (p.metadata?.deletionTimestamp) return false;
          
          // Exclude pods created by CronJobs (they are meant to complete/fail)
          const ownerRefs = p.metadata?.ownerReferences || [];
          const isCronJobPod = ownerRefs.some((ref: any) => ref.kind === "Job" && (p.metadata.name.includes("cronjob") || ref.name.includes("cronjob")));
          if (isCronJobPod) return false;
          
          return true;
        });
        
        const elapsedMinutes = Math.floor(elapsed / 60);
        const elapsedSeconds = elapsed % 60;
        const remaining = Math.max(0, maxWaitSeconds - elapsed);
        const remMinutes = Math.floor(remaining / 60);
        const remSeconds = remaining % 60;
        const timeStr = `[${elapsedMinutes}m ${elapsedSeconds}s elapsed, ${remMinutes}m ${remSeconds}s remaining]`;

        if (activePods.length === 0) {
          if (verbose) {
            const msg = `   ${timeStr} No active pods found yet with selector '${options.labelSelector || "all"}', waiting...`;
            if (process.stderr.isTTY) {
              process.stderr.write(`\r${msg}${" ".repeat(20)}`);
            } else {
              console.error(msg);
            }
          }
          currentNotReadyPods = [];
        } else {
          let readyCount = 0;
          const notReadyPods: any[] = [];
          
          for (const pod of activePods) {
            const readyCondition = pod.status?.conditions?.find((c: any) => c.type === "Ready");
            const isReady = readyCondition && readyCondition.status === "True";
            
            if (isReady) {
              readyCount++;
            } else {
              notReadyPods.push(pod);
            }
          }
          
          currentNotReadyPods = notReadyPods;
          const statusSummary = `${readyCount}/${activePods.length} pods ready`;
          
          if (verbose) {
            const notReadyNames = notReadyPods.map(p => p.metadata?.name || "unknown");
            const waitingFor = notReadyNames.length > 0 
              ? `. Waiting for: ${notReadyNames.slice(0, 2).join(", ")}${notReadyNames.length > 2 ? ` (+${notReadyNames.length-2})` : ""}`
              : "";
            const msg = `   ${timeStr} ${statusSummary}${waitingFor}`;
            
            const now = Date.now();
            const shouldLog = statusSummary !== lastStatus || (now - lastLogTime) > 60000;

            if (process.stderr.isTTY) {
              process.stderr.write(`\r${msg}${" ".repeat(20)}`);
            } else if (shouldLog) {
              console.error(msg);
              lastLogTime = now;
            }
            lastStatus = statusSummary;
          }
          
          if (readyCount > 0 && readyCount === activePods.length) {
            if (verbose) {
              if (process.stderr.isTTY) process.stderr.write("\n");
              console.error(`✓ All ${activePods.length} pods are Ready!`);
            }
            return { ok: true, total: activePods.length, ready: readyCount, notReadyPods: [] };
          }
        }
      } catch (e) {
        if (verbose) console.error(`   ⚠️  Failed to parse Kubernetes response: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else {
      if (verbose) {
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        const msg = `   [${minutes}m ${seconds}s] ⚠️  Kubernetes API call failed, retrying...`;
        if (process.stderr.isTTY) {
          process.stderr.write(`\r${msg}${" ".repeat(20)}`);
        } else {
          console.error(msg);
        }
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, pollIntervalSeconds * 1000));
  }
}
