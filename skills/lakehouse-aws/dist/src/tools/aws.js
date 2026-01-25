import { run } from "./shell.js";
export async function aws(args, awsProfile, awsRegion) {
    return run("aws", args, { AWS_PROFILE: awsProfile, AWS_DEFAULT_REGION: awsRegion });
}
export async function getCallerIdentity(awsProfile, awsRegion) {
    const res = await aws(["sts", "get-caller-identity", "--output", "json"], awsProfile, awsRegion);
    if (!res.ok)
        return { ok: false, error: res.stderr || res.stdout };
    try {
        const j = JSON.parse(res.stdout);
        return { ok: true, accountId: j.Account, arn: j.Arn, userId: j.UserId };
    }
    catch {
        return { ok: false, error: "Failed to parse sts get-caller-identity output" };
    }
}
export async function headBucket(bucket, awsProfile, awsRegion) {
    const res = await aws(["s3api", "head-bucket", "--bucket", bucket], awsProfile, awsRegion);
    return { exists: res.ok, raw: res };
}
export async function describeCluster(clusterName, awsProfile, awsRegion) {
    const res = await aws(["eks", "describe-cluster", "--name", clusterName, "--query", "cluster.status", "--output", "text"], awsProfile, awsRegion);
    return { found: res.ok, status: res.ok ? res.stdout.trim() : "NOT_FOUND", raw: res };
}
/**
 * Wait for EKS cluster to reach ACTIVE status
 * Polls every 30 seconds with a maximum timeout
 */
export async function waitForClusterActive(clusterName, awsProfile, awsRegion, options) {
    const maxWaitMinutes = options?.maxWaitMinutes || 20; // Default 20 minutes
    const maxWaitSeconds = maxWaitMinutes * 60;
    const pollIntervalSeconds = 30;
    const verbose = options?.verbose !== false;
    const startTime = Date.now();
    let lastStatus = "";
    let pollCount = 0;
    if (verbose) {
        console.error(`⏳ Waiting for cluster '${clusterName}' to become ACTIVE (max ${maxWaitMinutes} minutes)...`);
        console.error(`   Polling every ${pollIntervalSeconds} seconds...`);
    }
    while (true) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        pollCount++;
        if (elapsed > maxWaitSeconds) {
            if (verbose) {
                console.error(`❌ Timeout after ${maxWaitMinutes} minutes. Final status: ${lastStatus}`);
            }
            return {
                ok: false,
                status: lastStatus,
                waitedSeconds: elapsed,
                error: `Timeout after ${maxWaitMinutes} minutes. Cluster status: ${lastStatus}`,
            };
        }
        // Show progress every poll
        if (verbose) {
            const minutes = Math.floor(elapsed / 60);
            const seconds = elapsed % 60;
            console.error(`   [Poll #${pollCount}] [${minutes}m ${seconds}s] Checking cluster status...`);
        }
        const statusCheck = await describeCluster(clusterName, awsProfile, awsRegion);
        if (!statusCheck.found) {
            if (verbose)
                console.error(`❌ Cluster not found`);
            return {
                ok: false,
                status: "NOT_FOUND",
                waitedSeconds: elapsed,
                error: "Cluster not found",
            };
        }
        const status = statusCheck.status;
        const statusChanged = status !== lastStatus;
        lastStatus = status;
        if (verbose) {
            if (statusChanged || pollCount === 1) {
                const minutes = Math.floor(elapsed / 60);
                const seconds = elapsed % 60;
                process.stderr.write(`   Status: ${status} [${minutes}m ${seconds}s elapsed]\n`);
                process.stderr.flush?.();
            }
        }
        if (status === "ACTIVE") {
            const waitedSeconds = Math.floor((Date.now() - startTime) / 1000);
            if (verbose) {
                const minutes = Math.floor(waitedSeconds / 60);
                const seconds = waitedSeconds % 60;
                console.error(`✓ Cluster is ACTIVE! (waited ${minutes}m ${seconds}s, ${pollCount} polls)`);
            }
            return { ok: true, status, waitedSeconds };
        }
        if (status === "FAILED" || status === "DELETING") {
            if (verbose)
                console.error(`❌ Cluster is in ${status} state - cannot proceed`);
            return {
                ok: false,
                status,
                waitedSeconds: elapsed,
                error: `Cluster is in ${status} state`,
            };
        }
        // Wait before next poll - show countdown every 5 seconds
        if (verbose && status !== "ACTIVE") {
            for (let remaining = pollIntervalSeconds; remaining > 0; remaining -= 5) {
                process.stderr.write(`   Next check in ${remaining}s...\r`);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
            process.stderr.write(`   Next check in 0s...\n`);
        }
        else {
            await new Promise(resolve => setTimeout(resolve, pollIntervalSeconds * 1000));
        }
    }
}
