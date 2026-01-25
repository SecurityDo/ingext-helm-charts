import { run } from "./shell.js";
export async function helm(args, env) {
    return run("helm", args, env);
}
export async function upgradeInstall(release, chart, namespace, set, env) {
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
export async function isHelmLocked(release, namespace, env) {
    const result = await helm(["list", "-n", namespace, "-o", "json"], env);
    if (!result.ok)
        return false;
    try {
        const releases = JSON.parse(result.stdout);
        const rel = releases.find((r) => r.name === release);
        if (!rel)
            return false;
        // Check if status indicates an ongoing operation
        const status = rel.status?.toLowerCase() || "";
        return status.includes("pending") || status.includes("deploying");
    }
    catch {
        return false;
    }
}
/**
 * Wait for any pending Helm operation to complete
 * Polls every 10 seconds, shows progress
 */
export async function waitForHelmReady(release, namespace, env, options) {
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
        const locked = await isHelmLocked(release, namespace, env);
        if (!locked) {
            if (verbose && elapsed > 0) {
                console.error(`✓ Helm release is ready (waited ${elapsed}s)`);
            }
            return { ok: true };
        }
        if (verbose) {
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            process.stderr.write(`   [${minutes}m ${seconds}s] Helm operation in progress, waiting...\n`);
        }
        await new Promise(resolve => setTimeout(resolve, 10000)); // Check every 10s
    }
}
export async function listReleases(namespace, env) {
    return helm(["list", "-n", namespace, "-o", "json"], env);
}
export async function getRelease(release, namespace, env) {
    return helm(["status", release, "-n", namespace, "-o", "json"], env);
}
export async function uninstallRelease(release, namespace, env) {
    return helm(["uninstall", release, "-n", namespace], env);
}
