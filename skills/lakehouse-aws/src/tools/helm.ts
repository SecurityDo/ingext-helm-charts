import { run } from "./shell.js";

export type Env = Record<string, string>;

export async function helm(args: string[], env?: Env) {
  return run("helm", args, env);
}

export async function upgradeInstall(
  release: string,
  chart: string,
  namespace: string,
  set?: Record<string, string>,
  env?: Env
) {
  // First check if another operation is in progress
  const locked = await isHelmLocked(release, namespace, env);
  if (locked) {
    const ready = await waitForHelmReady(release, namespace, env);
    if (!ready.ok) {
      return { ok: false, stdout: "", stderr: `Helm release ${release} is locked by another operation: ${ready.error}` };
    }
  }

  const args = ["upgrade", "--install", release, chart, "--namespace", namespace];
  if (set) {
    for (const [key, value] of Object.entries(set)) {
      args.push("--set", `${key}=${value}`);
    }
  }
  return helm(args, env);
}

/**
 * Check if a Helm release has a pending operation
 * Returns true if another operation is in progress
 */
export async function getHelmReleaseStatus(release: string, namespace: string, env?: Env): Promise<string | null> {
  const result = await helm(["list", "-a", "-n", namespace, "-o", "json"], env);
  if (!result.ok) return null;
  
  try {
    const releases = JSON.parse(result.stdout);
    const rel = releases.find((r: any) => r.name === release);
    return rel ? rel.status : null;
  } catch {
    return null;
  }
}

/**
 * Check if a Helm release is locked by another operation
 */
export async function isHelmLocked(release: string, namespace: string, env?: Env): Promise<boolean> {
  const status = await getHelmReleaseStatus(release, namespace, env);
  if (!status) return false;
  
  const s = status.toLowerCase();
  return s.includes("pending") || s.includes("deploying");
}

/**
 * Wait for any pending Helm operation to complete
 * Polls every 10 seconds, shows progress
 */
export async function waitForHelmReady(
  release: string,
  namespace: string,
  env?: Env,
  options?: { maxWaitSeconds?: number; verbose?: boolean }
): Promise<{ ok: boolean; error?: string }> {
  const maxWaitSeconds = options?.maxWaitSeconds || 300;
  const verbose = options?.verbose ?? true;
  const startTime = Date.now();
  
  if (verbose) {
    console.error(`⏳ Checking if Helm release '${release}' has pending operations...`);
  }
  
  while (true) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    
    if (elapsed > maxWaitSeconds) {
      return {
        ok: false,
        error: `Timeout after ${maxWaitSeconds}s waiting for Helm operation to complete`
      };
    }
    
    const status = await getHelmReleaseStatus(release, namespace, env);
    const locked = status && (status.toLowerCase().includes("pending") || status.toLowerCase().includes("deploying"));
    
    if (!locked) {
      if (verbose && elapsed > 0) {
        console.error(`✓ Helm release is ready (waited ${elapsed}s)`);
      }
      return { ok: true };
    }
    
    // Auto-fix for stuck pending-install: if we've waited > 60s and it's still pending-install
    if (status === "pending-install" && elapsed > 60) {
      if (verbose) {
        console.error(`⚠️  Release '${release}' is stuck in 'pending-install'. Attempting to fix by uninstalling...`);
      }
      await uninstallRelease(release, namespace, env);
      return { ok: true }; 
    }

    // Auto-fix for stuck pending-upgrade: if we've waited > 60s and it's still pending-upgrade
    if (status === "pending-upgrade" && elapsed > 60) {
      if (verbose) {
        console.error(`⚠️  Release '${release}' is stuck in 'pending-upgrade'. Attempting to fix by rolling back...`);
      }
      await helm(["rollback", release, "0", "-n", namespace], env); // Rollback to last working revision
      return { ok: true };
    }
    
    if (verbose) {
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;
      process.stderr.write(`   [${minutes}m ${seconds}s] Helm operation in progress (${status}), waiting...\n`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 10000)); // Check every 10s
  }
}

export async function listReleases(namespace: string, env?: Env) {
  return helm(["list", "-a", "-n", namespace, "-o", "json"], env);
}

export async function getRelease(release: string, namespace: string, env?: Env) {
  return helm(["status", release, "-n", namespace, "-o", "json"], env);
}

export async function uninstallRelease(release: string, namespace: string, env?: Env) {
  return helm(["uninstall", release, "-n", namespace], env);
}
