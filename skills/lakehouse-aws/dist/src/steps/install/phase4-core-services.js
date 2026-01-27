import { checkPlatformHealth } from "../../tools/platform.js";
import { checkKarpenterInstalled, checkKarpenterReady } from "../../tools/karpenter.js";
import { kubectl, getPodEvents } from "../../tools/kubectl.js";
import { helm, upgradeInstall, waitForHelmReady, isHelmLocked } from "../../tools/helm.js";
function generateRandomToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 15; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return `tok_${result}`;
}
export async function runPhase4CoreServices(env, options) {
    const verbose = options?.verbose !== false;
    const blockers = [];
    const region = env.AWS_REGION;
    const profile = env.AWS_PROFILE;
    const namespace = env.NAMESPACE || "ingext";
    const evidence = {
        platform: {
            healthy: false,
            karpenterInstalled: false,
            karpenterControllerReady: false,
        },
        namespace: {
            name: namespace,
            existed: false,
            created: false,
        },
        appSecret: {
            name: "app-secret",
            existed: false,
            created: false,
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
    // STEP 0: Platform Health Gate
    const platformHealth = await checkPlatformHealth(profile, region);
    evidence.platform.healthy = platformHealth.healthy;
    // Check StorageClass health - Core services depend on gp3
    if (verbose)
        console.error(`   Checking StorageClass health...`);
    const scCheck = await kubectl(["get", "sc", "gp3", "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
    if (!scCheck.ok) {
        if (verbose)
            console.error(`⚠️  StorageClass 'gp3' not found. Stateful services may fail to start.`);
        // Don't block yet, maybe it's being installed
    }
    else {
        // Verify provisioner health by checking EBS CSI pods
        const ebsPods = await kubectl(["get", "pods", "-n", "kube-system", "-l", "app.kubernetes.io/name=aws-ebs-csi-driver", "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
        if (ebsPods.ok) {
            try {
                const podsData = JSON.parse(ebsPods.stdout);
                const pods = podsData.items || [];
                const crashing = pods.filter((p) => p.status?.containerStatuses?.some((s) => s.state?.waiting?.reason === "CrashLoopBackOff"));
                if (crashing.length > 0 && !options?.force) {
                    const errorMsg = `EBS CSI driver is unhealthy (CrashLoopBackOff). Core services cannot mount storage.\n\n` +
                        `To fix: Check IAM role permissions and Pod Identity association for the EBS CSI driver.`;
                    if (verbose)
                        console.error(`❌ ${errorMsg}`);
                    blockers.push({
                        code: "STORAGE_PROVISIONER_UNHEALTHY",
                        message: errorMsg,
                    });
                    return { ok: false, evidence, blockers };
                }
            }
            catch (e) { /* ignore */ }
        }
    }
    // Check Karpenter status if installed
    const karpenterCheck = await checkKarpenterInstalled(profile, region);
    evidence.platform.karpenterInstalled = karpenterCheck.exists;
    if (karpenterCheck.exists) {
        const karpenterReady = await checkKarpenterReady(profile, region);
        evidence.platform.karpenterControllerReady = karpenterReady.ready;
    }
    // Block if platform unhealthy and Karpenter not ready (unless forced)
    if (!platformHealth.healthy) {
        blockers.push(...platformHealth.blockers);
        if (evidence.platform.karpenterInstalled && !evidence.platform.karpenterControllerReady && !options?.force) {
            blockers.push({
                code: "KARPENTER_NOT_READY",
                message: "Karpenter is installed but controller is not ready. Cluster may not be able to schedule pods. Use --force to proceed anyway.",
            });
        }
        // Capture kube-system events if available
        const eventsResult = await kubectl(["get", "events", "-n", "kube-system", "--sort-by=.lastTimestamp", "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
        if (eventsResult.ok) {
            try {
                const eventsData = JSON.parse(eventsResult.stdout);
                const events = eventsData.items || [];
                const recentEvents = events.slice(-25).map((e) => `${e.lastTimestamp || ""} ${e.type || ""} ${e.reason || ""} ${e.message || ""}`).join("\n");
                if (recentEvents) {
                    blockers.push({
                        code: "PLATFORM_EVENTS",
                        message: `Recent kube-system events:\n${recentEvents}`,
                    });
                }
            }
            catch (e) {
                // Ignore parse errors
            }
        }
        if (!options?.force) {
            return { ok: false, evidence, blockers };
        }
    }
    // STEP 1: Ensure Namespace Exists (Idempotent)
    const nsCheckResult = await kubectl(["get", "namespace", namespace, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
    evidence.namespace.existed = nsCheckResult.ok;
    if (!nsCheckResult.ok) {
        const nsCreateResult = await kubectl(["create", "namespace", namespace], { AWS_PROFILE: profile, AWS_REGION: region });
        if (!nsCreateResult.ok && !nsCreateResult.stderr.includes("already exists")) {
            blockers.push({
                code: "NAMESPACE_CREATE_FAILED",
                message: `Failed to create namespace: ${nsCreateResult.stderr}`,
            });
        }
        else {
            evidence.namespace.created = true;
        }
    }
    // STEP 2: Ensure app-secret Token Exists (Idempotent)
    const secretCheckResult = await kubectl(["get", "secret", "app-secret", "-n", namespace, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
    evidence.appSecret.existed = secretCheckResult.ok;
    if (!secretCheckResult.ok) {
        const token = generateRandomToken();
        const secretCreateResult = await kubectl(["create", "secret", "generic", "app-secret", "-n", namespace, "--from-literal", `token=${token}`], { AWS_PROFILE: profile, AWS_REGION: region });
        if (!secretCreateResult.ok && !secretCreateResult.stderr.includes("already exists")) {
            blockers.push({
                code: "APP_SECRET_CREATE_FAILED",
                message: `Failed to create app-secret: ${secretCreateResult.stderr}`,
            });
        }
        else {
            evidence.appSecret.created = true;
        }
    }
    // STEP 3: Install ingext-serviceaccount Chart (Optional, Non-blocking)
    const serviceAccountChartResult = await upgradeInstall("ingext-serviceaccount", "oci://public.ecr.aws/ingext/ingext-serviceaccount", namespace, undefined, { AWS_PROFILE: profile, AWS_REGION: region });
    // Track in evidence but don't fail if it doesn't exist
    if (serviceAccountChartResult.ok) {
        // Try to get release info
        const helmCheck = await helm(["list", "-a", "-n", namespace, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
        if (helmCheck.ok) {
            try {
                const releases = JSON.parse(helmCheck.stdout);
                const release = releases.find((r) => r.name === "ingext-serviceaccount");
                if (release) {
                    evidence.helm.releases.push({
                        name: "ingext-serviceaccount",
                        status: release.status || "unknown",
                        revision: release.revision || 0,
                        chart: release.chart || "ingext-serviceaccount",
                        version: release.app_version || undefined,
                    });
                }
            }
            catch (e) {
                // Ignore parse errors
            }
        }
    }
    // STEP 3.5: Install ingext-manager-role Chart (RBAC permissions for service account)
    // This must be installed before Phase 5 pods start, as they need to read secrets and configmaps
    const managerRoleStartTime = Date.now();
    // Check if locked
    const managerRoleLocked = await isHelmLocked("ingext-manager-role", namespace, { AWS_PROFILE: profile, AWS_REGION: region });
    if (managerRoleLocked) {
        await waitForHelmReady("ingext-manager-role", namespace, { AWS_PROFILE: profile, AWS_REGION: region });
    }
    const managerRoleResult = await helm([
        "upgrade", "--install", "ingext-manager-role",
        "oci://public.ecr.aws/ingext/ingext-manager-role",
        "--namespace", namespace,
        "--wait",
        "--timeout", "5m"
    ], { AWS_PROFILE: profile, AWS_REGION: region });
    const managerRoleElapsed = Math.floor((Date.now() - managerRoleStartTime) / 1000);
    evidence.helm.releases.push({
        name: "ingext-manager-role",
        status: managerRoleResult.ok ? "deployed" : "failed",
        revision: 1,
        chart: "oci://public.ecr.aws/ingext/ingext-manager-role",
        elapsedSeconds: managerRoleElapsed,
        error: managerRoleResult.ok ? undefined : managerRoleResult.stderr.substring(0, 500),
    });
    if (!managerRoleResult.ok) {
        blockers.push({
            code: "RBAC_INSTALL_FAILED",
            message: `Failed to install ingext-manager-role (required for Phase 5): ${managerRoleResult.stderr.substring(0, 500)}`,
        });
        return { ok: false, evidence, blockers };
    }
    // STEP 4: Install Core Helm Charts (Idempotent)
    const charts = [
        { release: 'ingext-stack', chart: 'oci://public.ecr.aws/ingext/ingext-stack' },
        { release: 'etcd-single', chart: 'oci://public.ecr.aws/ingext/etcd-single' },
        { release: 'etcd-single-cronjob', chart: 'oci://public.ecr.aws/ingext/etcd-single-cronjob' },
    ];
    // Get current Helm releases first to see if we can skip
    const currentHelmReleases = await helm(["list", "-a", "-n", namespace, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
    let deployedReleases = [];
    if (currentHelmReleases.ok) {
        try {
            deployedReleases = JSON.parse(currentHelmReleases.stdout);
        }
        catch (e) { /* ignore */ }
    }
    for (const { release, chart } of charts) {
        // Check if release is locked by another operation
        const isLocked = await isHelmLocked(release, namespace, { AWS_PROFILE: profile, AWS_REGION: region });
        if (isLocked) {
            if (verbose)
                console.error(`⚠️  Release "${release}" has another operation in progress. Waiting...`);
            const ready = await waitForHelmReady(release, namespace, { AWS_PROFILE: profile, AWS_REGION: region });
            if (!ready.ok) {
                blockers.push({
                    code: `HELM_LOCKED_${release.toUpperCase().replace(/-/g, '_')}`,
                    message: `Helm release "${release}" is locked by another operation and timed out waiting. Try: helm rollback ${release} -n ${namespace}`,
                });
                continue;
            }
            // Refresh currentHelmReleases after waiting
            const refreshedReleases = await helm(["list", "-a", "-n", namespace, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
            if (refreshedReleases.ok) {
                try {
                    deployedReleases = JSON.parse(refreshedReleases.stdout);
                }
                catch (e) { /* ignore */ }
            }
        }
        const isDeployed = deployedReleases.some((r) => r.name === release && r.status === "deployed");
        if (isDeployed) {
            if (verbose)
                console.error(`✓ Release "${release}" is already deployed. Skipping upgrade.`);
            // Add to evidence
            const found = deployedReleases.find((r) => r.name === release);
            evidence.helm.releases.push({
                name: release,
                status: "deployed",
                revision: found.revision || 0,
                chart: chart,
                version: found.app_version || undefined,
            });
            continue;
        }
        const startTime = Date.now();
        // Use helm directly to add --wait --timeout flags
        const installResult = await helm([
            "upgrade", "--install", release, chart,
            "--namespace", namespace,
            "--wait",
            "--timeout", "10m"
        ], { AWS_PROFILE: profile, AWS_REGION: region });
        const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
        // Get release info
        const helmCheck = await helm(["list", "-a", "-n", namespace, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
        let releaseInfo = {
            name: release,
            status: installResult.ok ? "deployed" : "failed",
            revision: 0,
            chart: chart,
            elapsedSeconds,
        };
        if (helmCheck.ok) {
            try {
                const releases = JSON.parse(helmCheck.stdout);
                const found = releases.find((r) => r.name === release);
                if (found) {
                    releaseInfo.status = found.status || releaseInfo.status;
                    releaseInfo.revision = found.revision || 0;
                    releaseInfo.version = found.app_version || undefined;
                }
            }
            catch (e) {
                // Ignore parse errors
            }
        }
        if (!installResult.ok) {
            releaseInfo.error = installResult.stderr.split("\n").slice(-10).join("\n");
            blockers.push({
                code: `HELM_INSTALL_FAILED_${release.toUpperCase().replace(/-/g, '_')}`,
                message: `Failed to install ${release}: ${releaseInfo.error}`,
            });
            evidence.helm.releases.push(releaseInfo);
            break; // Stop installing subsequent charts if one fails
        }
        evidence.helm.releases.push(releaseInfo);
    }
    // STEP 5: Active pod readiness polling (NO SILENT 10-MINUTE WAITS!)
    if (verbose)
        console.error(`\n⏳ Waiting for all pods to be Ready (checking every 30s, max 10 minutes)...`);
    const maxWaitSeconds = 600;
    const pollIntervalSeconds = 30;
    const startTime = Date.now();
    let allPodsReady = false;
    let lastPodStatus = "";
    while (!allPodsReady && (Date.now() - startTime) < maxWaitSeconds * 1000) {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        if (verbose) {
            process.stderr.write(`   [${minutes}m ${seconds}s] Checking pod status...\n`);
        }
        // Get all pods in namespace
        const podsResult = await kubectl(["get", "pods", "-n", namespace, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
        if (podsResult.ok) {
            try {
                const podsData = JSON.parse(podsResult.stdout);
                const pods = podsData.items || [];
                evidence.pods.total = pods.length;
                evidence.pods.readyCount = 0;
                evidence.pods.notReady = [];
                // Filter out completed/succeeded/failed pods and cronjob pods
                const activePods = pods.filter((p) => {
                    const phase = p.status?.phase;
                    if (phase === "Succeeded" || phase === "Failed")
                        return false;
                    // Exclude pods created by CronJobs (they are meant to complete/fail)
                    const ownerRefs = p.metadata?.ownerReferences || [];
                    const isCronJobPod = ownerRefs.some((ref) => ref.kind === "Job" && p.metadata.name.includes("cronjob"));
                    if (isCronJobPod)
                        return false;
                    return true;
                });
                for (const pod of activePods) {
                    const containerStatuses = pod.status.containerStatuses || [];
                    const readyCondition = pod.status?.conditions?.find((c) => c.type === "Ready");
                    const ready = readyCondition && readyCondition.status === "True";
                    if (ready) {
                        evidence.pods.readyCount++;
                    }
                    else {
                        const phase = pod.status.phase || "Unknown";
                        let reason = pod.status.containerStatuses?.[0]?.state?.waiting?.reason ||
                            pod.status.containerStatuses?.[0]?.state?.terminated?.reason ||
                            pod.status.reason ||
                            undefined;
                        // Check for PVC binding issues if pod is Pending
                        if (phase === "Pending") {
                            const podName = pod.metadata.name;
                            const eventsRes = await kubectl(["get", "events", "-n", namespace, "--field-selector", `involvedObject.name=${podName}`, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
                            if (eventsRes.ok) {
                                try {
                                    const eventsData = JSON.parse(eventsRes.stdout);
                                    const events = eventsData.items || [];
                                    const pvcEvent = events.find((e) => e.message?.includes("unbound immediate PersistentVolumeClaims"));
                                    if (pvcEvent) {
                                        reason = "StorageWait";
                                    }
                                }
                                catch (e) { /* ignore */ }
                            }
                        }
                        evidence.pods.notReady.push({
                            name: pod.metadata.name,
                            status: phase,
                            reason,
                        });
                    }
                }
                evidence.pods.ready = evidence.pods.notReady.length === 0 && activePods.length > 0;
                if (evidence.pods.ready) {
                    allPodsReady = true;
                    if (verbose) {
                        console.error(`✓ All pods are Ready! (${activePods.length} pods)`);
                    }
                    break;
                }
                // Show what we're waiting for
                const statusSummary = evidence.pods.notReady.map((p) => `${p.name}: ${p.status}${p.reason ? `(${p.reason})` : ""}`).slice(0, 5).join(", ");
                if (verbose && statusSummary !== lastPodStatus) {
                    console.error(`   Waiting for ${evidence.pods.notReady.length} pod(s): ${statusSummary}`);
                    lastPodStatus = statusSummary;
                }
            }
            catch (e) {
                if (verbose)
                    console.error(`   Warning: Failed to parse pod status`);
            }
        }
        // Wait before next check
        if (!allPodsReady) {
            if (verbose) {
                process.stderr.write(`   Next check in ${pollIntervalSeconds}s...\n`);
            }
            await new Promise(resolve => setTimeout(resolve, pollIntervalSeconds * 1000));
        }
    }
    const waitResult = { ok: allPodsReady, stdout: "", stderr: "" };
    // If wait failed, capture diagnostics
    if (!waitResult.ok || !evidence.pods.ready) {
        // Get pods wide output
        const podsWideResult = await kubectl(["get", "pods", "-n", namespace, "-o", "wide"], { AWS_PROFILE: profile, AWS_REGION: region });
        // Get events
        const eventsResult = await kubectl(["get", "events", "-n", namespace, "--sort-by=.lastTimestamp"], { AWS_PROFILE: profile, AWS_REGION: region });
        if (eventsResult.ok) {
            const eventsLines = eventsResult.stdout.split("\n").slice(-25);
            evidence.pods.eventsTail = eventsLines.join("\n");
        }
        // Get describe for worst offenders (first 3 not ready pods)
        for (const pod of evidence.pods.notReady.slice(0, 3)) {
            const describeResult = await getPodEvents(pod.name, namespace, profile, region);
            if (describeResult.ok && describeResult.events) {
                // Add events to blocker message
                const eventsExcerpt = describeResult.events.split("\n").slice(0, 15).join("\n");
                blockers.push({
                    code: `POD_NOT_READY_${pod.name.toUpperCase().replace(/-/g, '_')}`,
                    message: `Pod ${pod.name} is not ready (${pod.status}${pod.reason ? `: ${pod.reason}` : ""})\n\nEvents:\n${eventsExcerpt}`,
                });
            }
        }
        if (podsWideResult.ok) {
            blockers.push({
                code: "PODS_NOT_READY",
                message: `Not all pods are ready in namespace ${namespace}.\n\nPod status:\n${podsWideResult.stdout}\n\nRecent events:\n${evidence.pods.eventsTail || "No events found"}`,
            });
        }
        else {
            blockers.push({
                code: "POD_READINESS_TIMEOUT",
                message: `Timeout waiting for pods to be ready in namespace ${namespace}. Check pod status manually.`,
            });
        }
    }
    return {
        ok: blockers.length === 0 && evidence.pods.ready,
        evidence,
        blockers,
    };
}
