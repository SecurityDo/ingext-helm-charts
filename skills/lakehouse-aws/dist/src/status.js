import { describeCluster } from "./tools/aws.js";
import { headBucket } from "./tools/aws.js";
import { kubectl } from "./tools/kubectl.js";
import { helm } from "./tools/helm.js";
import { findCertificatesForDomain, describeCertificate } from "./tools/acm.js";
import { findHostedZoneForDomain } from "./tools/route53.js";
import { getExecMode } from "./tools/shell.js";
// Helper function to check pod status by label (similar to bash script)
// Checks ALL pods for the component and returns the worst status
async function checkPodStatusByLabel(appName, displayName, namespace, profile, region) {
    const labels = [
        `ingext.io/app=${appName}`,
        `app=${appName}`,
        `app.kubernetes.io/name=${appName}`,
    ];
    for (const label of labels) {
        const podCheck = await kubectl(["get", "pods", "-n", namespace, "-l", label, "-o", "json"], { AWS_PROFILE: profile, AWS_REGION: region });
        if (podCheck.ok) {
            try {
                const data = JSON.parse(podCheck.stdout);
                const pods = data.items || [];
                if (pods.length > 0) {
                    // Check ALL pods, not just the first one
                    // Priority order: Failed/CrashLoopBackOff > Pending/Starting > Running > Succeeded
                    let worstStatus = null;
                    let allReady = true;
                    for (const pod of pods) {
                        const phase = pod.status?.phase || "Unknown";
                        const containerStatuses = pod.status?.containerStatuses || [];
                        const ready = containerStatuses.length > 0 && containerStatuses.every((c) => c.ready);
                        if (!ready)
                            allReady = false;
                        let podStatus;
                        if (phase === "Running") {
                            if (!ready) {
                                podStatus = {
                                    name: appName,
                                    displayName,
                                    status: "Starting",
                                    ready: false,
                                };
                            }
                            else {
                                podStatus = {
                                    name: appName,
                                    displayName,
                                    status: "Running",
                                    ready: true,
                                };
                            }
                        }
                        else if (phase === "Pending") {
                            podStatus = {
                                name: appName,
                                displayName,
                                status: "Pending",
                                ready: false,
                            };
                        }
                        else if (phase === "CrashLoopBackOff") {
                            podStatus = {
                                name: appName,
                                displayName,
                                status: "CrashLoopBackOff",
                                ready: false,
                            };
                        }
                        else if (phase === "Failed") {
                            podStatus = {
                                name: appName,
                                displayName,
                                status: "Failed",
                                ready: false,
                            };
                        }
                        else if (phase === "Succeeded") {
                            podStatus = {
                                name: appName,
                                displayName,
                                status: "Succeeded",
                                ready: true,
                            };
                        }
                        else if (phase === "Terminating") {
                            podStatus = {
                                name: appName,
                                displayName,
                                status: "Terminating",
                                ready: false,
                            };
                        }
                        else {
                            // Handle other phases (Unknown, ImagePullBackOff, etc.)
                            const waitingReason = containerStatuses[0]?.state?.waiting?.reason;
                            const terminatedReason = containerStatuses[0]?.state?.terminated?.reason;
                            const statusReason = waitingReason || terminatedReason || phase;
                            podStatus = {
                                name: appName,
                                displayName,
                                status: statusReason || "Unknown",
                                ready: false,
                            };
                        }
                        // Determine worst status (error > warning > success)
                        if (!worstStatus) {
                            worstStatus = podStatus;
                        }
                        else {
                            const currentPriority = getStatusPriority(worstStatus.status);
                            const newPriority = getStatusPriority(podStatus.status);
                            if (newPriority > currentPriority) {
                                worstStatus = podStatus;
                            }
                        }
                    }
                    // If we found pods, return the worst status
                    if (worstStatus) {
                        return worstStatus;
                    }
                }
            }
            catch (e) {
                // Ignore parse errors
            }
        }
    }
    // No pods found - return NOT DEPLOYED (matches bash script)
    return {
        name: appName,
        displayName,
        status: "NOT DEPLOYED",
        ready: false,
    };
}
// Helper to prioritize statuses (higher number = worse/more important to show)
function getStatusPriority(status) {
    // Error states (highest priority)
    if (status === "CrashLoopBackOff" || status === "Failed" || status === "ImagePullBackOff" ||
        status === "ErrImagePull" || status === "CreateContainerConfigError") {
        return 10;
    }
    // Warning states
    if (status === "Pending" || status === "Starting" || status === "Terminating") {
        return 5;
    }
    // Success states (lowest priority)
    if (status === "Running" || status === "Succeeded") {
        return 1;
    }
    // Unknown/other
    return 3;
}
export async function runStatus(input) {
    const timestamp = new Date().toISOString();
    const nextSteps = [];
    // Initialize result structure
    const result = {
        timestamp,
        cluster: {
            name: input.clusterName,
            status: "unknown",
        },
        infrastructure: {
            s3: { status: "unknown" },
            route53: { status: "unknown" },
            certificate: { status: "unknown" },
        },
        components: {
            coreServices: [],
            stream: [],
            datalake: [],
        },
        networking: {},
        podSummary: {
            running: 0,
            total: 0,
        },
        kubernetes: {
            addons: { status: "unknown", items: [] },
            storageClass: { status: "unknown" },
            namespaces: [],
        },
        helm: {
            releases: [],
        },
        readiness: {
            phase1Foundation: false,
            phase2Storage: false,
            phase3Compute: false,
            phase4CoreServices: false,
            phase5Stream: false,
            phase6Datalake: false,
            phase7Ingress: false,
        },
        nextSteps,
    };
    // 1. Check EKS Cluster
    const clusterCheck = await describeCluster(input.clusterName, input.awsProfile, input.awsRegion);
    if (clusterCheck.found && clusterCheck.status === "ACTIVE") {
        result.cluster.status = "deployed";
        result.cluster.details = {
            eksStatus: clusterCheck.status,
        };
        // Try to get node information
        const nodesResult = await kubectl(["get", "nodes", "-o", "json"], {
            AWS_PROFILE: input.awsProfile,
            AWS_REGION: input.awsRegion,
        });
        if (nodesResult.ok) {
            try {
                const nodesData = JSON.parse(nodesResult.stdout);
                const nodes = nodesData.items || [];
                result.cluster.details.nodeCount = nodes.length;
                result.cluster.details.nodes = nodes.map((node) => ({
                    name: node.metadata.name,
                    status: node.status.conditions.find((c) => c.type === "Ready")?.status || "Unknown",
                }));
                if (nodes.length > 0) {
                    result.cluster.details.kubernetesVersion = nodes[0].status.nodeInfo.kubeletVersion;
                }
            }
            catch (e) {
                // Ignore parse errors
            }
        }
    }
    else if (clusterCheck.found && (clusterCheck.status === "CREATING" || clusterCheck.status === "UPDATING" || clusterCheck.status === "DELETING")) {
        result.cluster.status = clusterCheck.status === "DELETING" ? "missing" : "degraded";
        result.cluster.details = { eksStatus: clusterCheck.status };
        if (clusterCheck.status === "DELETING") {
            nextSteps.push("Wait for cluster deletion to complete");
        }
    }
    else {
        // Cluster not found or error checking
        result.cluster.status = "missing";
        if (clusterCheck.status !== "NOT_FOUND" && clusterCheck.status !== "ERROR") {
            // Unknown status
            result.cluster.details = { eksStatus: clusterCheck.status };
        }
        nextSteps.push("Run Phase 1: Foundation to create EKS cluster");
    }
    // 2. Check S3 Bucket
    if (input.s3Bucket) {
        const s3Check = await headBucket(input.s3Bucket, input.awsProfile, input.awsRegion);
        result.infrastructure.s3.bucketName = input.s3Bucket;
        result.infrastructure.s3.exists = s3Check.exists;
        result.infrastructure.s3.status = s3Check.exists ? "deployed" : "missing";
        if (!s3Check.exists) {
            nextSteps.push(`Run Phase 2: Storage to create S3 bucket: ${input.s3Bucket}`);
        }
    }
    // 3. Check Route53
    if (input.rootDomain) {
        const route53Check = await findHostedZoneForDomain(input.rootDomain);
        if (route53Check.ok && route53Check.zoneId) {
            result.infrastructure.route53.status = "deployed";
            result.infrastructure.route53.zoneId = route53Check.zoneId;
            result.infrastructure.route53.zoneName = route53Check.zoneName;
        }
        else {
            result.infrastructure.route53.status = "missing";
            nextSteps.push(`Create Route53 hosted zone for: ${input.rootDomain}`);
        }
    }
    // 4. Check ACM Certificate
    // If certArn is provided, use it directly (matches bash script behavior)
    if (input.certArn && input.awsRegion) {
        const certDetails = await describeCertificate(input.certArn, input.awsRegion);
        if (certDetails.ok && certDetails.data?.Certificate) {
            result.infrastructure.certificate.status = "deployed";
            result.infrastructure.certificate.arn = input.certArn;
            result.infrastructure.certificate.domain = certDetails.data.Certificate.DomainName;
            result.infrastructure.certificate.acmStatus = certDetails.data.Certificate.Status;
            result.infrastructure.certificate.validFor = certDetails.data.Certificate.SubjectAlternativeNames || [];
        }
        else {
            result.infrastructure.certificate.status = "missing";
        }
    }
    else if (input.siteDomain && input.awsRegion) {
        // Fallback to searching by domain
        const certCheck = await findCertificatesForDomain(input.siteDomain, input.awsRegion);
        if (certCheck.ok && certCheck.matches && certCheck.matches.length > 0) {
            const cert = certCheck.matches[0];
            result.infrastructure.certificate.status = "deployed";
            result.infrastructure.certificate.arn = cert.arn;
            result.infrastructure.certificate.domain = cert.domain;
            result.infrastructure.certificate.validFor = certCheck.matches.map(c => c.domain);
            result.infrastructure.certificate.acmStatus = cert.status;
            // Get detailed certificate status
            if (cert.arn) {
                const certDetails = await describeCertificate(cert.arn, input.awsRegion);
                if (certDetails.ok && certDetails.data?.Certificate) {
                    result.infrastructure.certificate.acmStatus = certDetails.data.Certificate.Status;
                }
            }
        }
        else {
            result.infrastructure.certificate.status = "missing";
            nextSteps.push(`Request ACM certificate for: ${input.siteDomain}`);
        }
    }
    // Store site domain for networking section
    if (input.siteDomain) {
        result.networking.siteDomain = input.siteDomain;
    }
    // Always try to check component pods (matches bash script behavior - always checks pods)
    const ns = input.namespace || "ingext";
    // Check Component Pods (Core Services, Stream, Datalake) - ALWAYS run, regardless of cluster status
    result.components.coreServices = [
        await checkPodStatusByLabel("redis", "Redis (Cache)", ns, input.awsProfile, input.awsRegion),
        await checkPodStatusByLabel("opensearch", "OpenSearch (Search Index)", ns, input.awsProfile, input.awsRegion),
        await checkPodStatusByLabel("victoria-metrics-single", "VictoriaMetrics (TSDB)", ns, input.awsProfile, input.awsRegion),
        await checkPodStatusByLabel("etcd", "etcd (Key-Value Store)", ns, input.awsProfile, input.awsRegion),
    ];
    result.components.stream = [
        await checkPodStatusByLabel("api", "API Service", ns, input.awsProfile, input.awsRegion),
        await checkPodStatusByLabel("platform", "Platform Service", ns, input.awsProfile, input.awsRegion),
        await checkPodStatusByLabel("fluency8", "Fluency Service", ns, input.awsProfile, input.awsRegion),
    ];
    result.components.datalake = [
        await checkPodStatusByLabel("lake-mgr", "Lake Manager", ns, input.awsProfile, input.awsRegion),
        await checkPodStatusByLabel("search-service", "Lake Search", ns, input.awsProfile, input.awsRegion),
        await checkPodStatusByLabel("lake-worker", "Lake Worker", ns, input.awsProfile, input.awsRegion),
    ];
    // Check Ingress / Load Balancer (always try)
    const ingressCheck = await kubectl(["get", "ingress", "-n", ns, "-o", "json"], { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion });
    if (ingressCheck.ok) {
        try {
            const ingressData = JSON.parse(ingressCheck.stdout);
            const ingresses = ingressData.items || [];
            if (ingresses.length > 0) {
                const ingress = ingresses[0];
                const lbIngress = ingress.status?.loadBalancer?.ingress?.[0];
                const hostname = lbIngress?.hostname;
                const ip = lbIngress?.ip;
                result.networking.loadBalancer = {
                    hostname: hostname || undefined,
                    ip: ip || undefined,
                    status: (hostname || ip) ? "deployed" : "degraded",
                };
                // If ingress exists but no hostname/IP, it's provisioning
                if (!hostname && !ip) {
                    result.networking.loadBalancer.status = "degraded"; // Will show as PROVISIONING in display
                }
            }
            else {
                result.networking.loadBalancer = {
                    status: "missing",
                };
            }
        }
        catch (e) {
            result.networking.loadBalancer = {
                status: "unknown",
            };
        }
    }
    else {
        // Check if error is due to cluster being unreachable (DELETING)
        const isClusterUnreachable = ingressCheck.stderr.includes("Unable to connect") ||
            ingressCheck.stderr.includes("no such host") ||
            ingressCheck.stderr.includes("connection refused");
        if (isClusterUnreachable) {
            // Cluster might be DELETING - check cluster status
            const clusterStatus = await describeCluster(input.clusterName, input.awsProfile, input.awsRegion);
            if (clusterStatus.found && clusterStatus.status === "DELETING") {
                result.networking.loadBalancer = {
                    status: "unknown", // Can't check - cluster is deleting
                };
            }
            else {
                result.networking.loadBalancer = {
                    status: "missing",
                };
            }
        }
        else {
            result.networking.loadBalancer = {
                status: "missing",
            };
        }
    }
    // Calculate Pod Summary (always try)
    const podsSummaryCheck = await kubectl(["get", "pods", "-n", ns, "--no-headers", "-o", "json"], { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion });
    if (podsSummaryCheck.ok) {
        try {
            const podsData = JSON.parse(podsSummaryCheck.stdout);
            const pods = podsData.items || [];
            result.podSummary.total = pods.length;
            result.podSummary.running = pods.filter((p) => {
                const phase = p.status?.phase;
                const containerStatuses = p.status?.containerStatuses || [];
                const ready = containerStatuses.length > 0 && containerStatuses.every((c) => c.ready);
                return phase === "Running" && ready;
            }).length;
        }
        catch (e) {
            // Ignore parse errors
        }
    }
    // Only check detailed Kubernetes resources if cluster is active (but we already checked components above)
    if (result.cluster.status === "deployed") {
        // 5. Check EKS Addons
        const addonsToCheck = [
            "eks-pod-identity-agent",
            "aws-ebs-csi-driver",
            "aws-mountpoint-s3-csi-driver",
        ];
        for (const addonName of addonsToCheck) {
            const addonCheck = await kubectl(["get", "daemonset,deployment", "-n", "kube-system", "-l", `app.kubernetes.io/name=${addonName}`, "-o", "json"], { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion });
            let addonStatus = "missing";
            if (addonCheck.ok) {
                try {
                    const data = JSON.parse(addonCheck.stdout);
                    if (data.items && data.items.length > 0) {
                        addonStatus = "deployed";
                    }
                }
                catch (e) {
                    addonStatus = "unknown";
                }
            }
            result.kubernetes.addons.items.push({
                name: addonName,
                status: addonStatus,
            });
        }
        const allAddonsDeployed = result.kubernetes.addons.items.every(a => a.status === "deployed");
        result.kubernetes.addons.status = allAddonsDeployed ? "deployed" : "degraded";
        // 6. Check StorageClass
        // The Helm chart "ingext-aws-gp3" creates a StorageClass
        // New installations use "ingext-aws-gp3", older ones may use "gp3"
        let scCheck = await kubectl(["get", "storageclass", "ingext-aws-gp3", "-o", "json"], { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion });
        let storageClassName = "ingext-aws-gp3";
        if (!scCheck.ok) {
            // Fallback to legacy name for backward compatibility
            scCheck = await kubectl(["get", "storageclass", "gp3", "-o", "json"], { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion });
            if (scCheck.ok) {
                storageClassName = "gp3";
            }
        }
        if (scCheck.ok) {
            result.kubernetes.storageClass.status = "deployed";
            result.kubernetes.storageClass.name = storageClassName;
        }
        else {
            result.kubernetes.storageClass.status = "missing";
        }
        // 7. Check Namespaces
        const namespacesToCheck = [input.namespace || "ingext", "kube-system"];
        for (const ns of namespacesToCheck) {
            const nsCheck = await kubectl(["get", "namespace", ns, "-o", "json"], { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion });
            result.kubernetes.namespaces.push({
                name: ns,
                status: nsCheck.ok ? "deployed" : "missing",
            });
        }
        // 8. Check Deployments and StatefulSets in target namespace
        const ns = input.namespace || "ingext";
        const deploymentsCheck = await kubectl(["get", "deployments", "-n", ns, "-o", "json"], { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion });
        if (deploymentsCheck.ok) {
            try {
                const data = JSON.parse(deploymentsCheck.stdout);
                result.kubernetes.workloads = {
                    deployments: [],
                    statefulSets: [],
                    pods: [],
                };
                if (data.items) {
                    result.kubernetes.workloads.deployments = data.items.map((dep) => {
                        const ready = dep.status.readyReplicas || 0;
                        const desired = dep.spec.replicas || 0;
                        return {
                            name: dep.metadata.name,
                            namespace: dep.metadata.namespace,
                            ready,
                            desired,
                            status: (ready === desired && ready > 0) ? "deployed" : "degraded",
                        };
                    });
                }
            }
            catch (e) {
                // Ignore parse errors
            }
        }
        const statefulSetsCheck = await kubectl(["get", "statefulsets", "-n", ns, "-o", "json"], { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion });
        if (statefulSetsCheck.ok && result.kubernetes.workloads) {
            try {
                const data = JSON.parse(statefulSetsCheck.stdout);
                if (data.items) {
                    result.kubernetes.workloads.statefulSets = data.items.map((sts) => {
                        const ready = sts.status.readyReplicas || 0;
                        const desired = sts.spec.replicas || 0;
                        return {
                            name: sts.metadata.name,
                            namespace: sts.metadata.namespace,
                            ready,
                            desired,
                            status: (ready === desired && ready > 0) ? "deployed" : "degraded",
                        };
                    });
                }
            }
            catch (e) {
                // Ignore parse errors
            }
        }
        // 9. Check Pods
        const podsCheck = await kubectl(["get", "pods", "-n", ns, "-o", "json"], { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion });
        if (podsCheck.ok && result.kubernetes.workloads) {
            try {
                const data = JSON.parse(podsCheck.stdout);
                if (data.items) {
                    result.kubernetes.workloads.pods = data.items.map((pod) => {
                        const containerStatuses = pod.status.containerStatuses || [];
                        const ready = containerStatuses.every((c) => c.ready);
                        return {
                            name: pod.metadata.name,
                            namespace: pod.metadata.namespace,
                            status: pod.status.phase,
                            ready,
                        };
                    });
                }
            }
            catch (e) {
                // Ignore parse errors
            }
        }
        // 10. Check Helm Releases
        const helmListCheck = await helm(["list", "-a", "-A", "-o", "json"], { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion });
        if (helmListCheck.ok) {
            try {
                const releases = JSON.parse(helmListCheck.stdout);
                result.helm.releases = releases.map((rel) => ({
                    name: rel.name,
                    namespace: rel.namespace,
                    chart: rel.chart,
                    status: rel.status,
                    revision: rel.revision,
                }));
            }
            catch (e) {
                // Ignore parse errors
            }
        }
        else if (helmListCheck.exitCode === 127 || helmListCheck.stderr.includes("Command not found")) {
            // Helm not installed - provide helpful message based on exec mode
            const execMode = getExecMode();
            if (execMode === "docker") {
                // In docker mode, helm should be available, so this is unexpected
                result.helm.error = "Helm not found in Docker container. This may indicate a Docker configuration issue.";
            }
            else {
                // In local mode, suggest installing helm or using docker
                result.helm.error = "Helm not found. Install helm or use --exec docker to run in Docker container.";
            }
            result.helm.releases = [];
        }
    }
    // Determine phase readiness
    // Phase 1 is complete if cluster is deployed, addons are deployed, and StorageClass is deployed
    // Check both kubectl storageclass and helm release for StorageClass
    const hasStorageClass = result.kubernetes.storageClass.status === "deployed" ||
        result.helm.releases.some(r => r.name === "ingext-aws-gp3" && r.status === "deployed");
    result.readiness.phase1Foundation =
        result.cluster.status === "deployed" &&
            result.kubernetes.addons.status === "deployed" &&
            hasStorageClass;
    result.readiness.phase2Storage =
        result.readiness.phase1Foundation &&
            result.infrastructure.s3.status === "deployed";
    // Check for Karpenter and capture details
    const karpenterRelease = result.helm.releases.find(r => r.name === "karpenter");
    const hasKarpenter = !!karpenterRelease;
    if (karpenterRelease) {
        // Add Karpenter-specific details to result
        result.kubernetes.karpenter = {
            status: "deployed",
            version: karpenterRelease.chart.split("-").pop() || "unknown",
            namespace: karpenterRelease.namespace,
            controllerReady: false,
        };
        // Check controller deployment
        const karpenterDeployCheck = await kubectl(["get", "deployment", "karpenter", "-n", "kube-system", "-o", "json"], { AWS_PROFILE: input.awsProfile, AWS_REGION: input.awsRegion });
        if (karpenterDeployCheck.ok) {
            try {
                const deploy = JSON.parse(karpenterDeployCheck.stdout);
                const ready = deploy.status.readyReplicas || 0;
                const desired = deploy.spec.replicas || 0;
                result.kubernetes.karpenter.controllerReady = (ready === desired && ready > 0);
            }
            catch (e) {
                result.kubernetes.karpenter.controllerReady = false;
            }
        }
    }
    result.readiness.phase3Compute = result.readiness.phase2Storage && hasKarpenter;
    // Phase 4: Core Services - check for required Helm releases and pod readiness
    const requiredCoreReleases = ["ingext-stack", "etcd-single", "etcd-single-cronjob"];
    const hasAllCoreReleases = requiredCoreReleases.every(releaseName => result.helm.releases.some(r => r.name === releaseName && r.status === "deployed"));
    // Check if pods from core services are ready
    const corePodsReady = result.kubernetes.workloads?.pods?.every(p => p.ready) || false;
    const hasCorePods = (result.kubernetes.workloads?.pods?.length || 0) > 0;
    // Phase 4 is complete if all releases are deployed and pods are ready
    result.readiness.phase4CoreServices =
        result.readiness.phase3Compute &&
            hasAllCoreReleases &&
            (corePodsReady || !hasCorePods); // Allow if no pods yet (charts may not create pods immediately)
    const hasStream = result.helm.releases.some(r => r.name.includes("ingext-community"));
    result.readiness.phase5Stream = result.readiness.phase4CoreServices && hasStream;
    const hasLake = result.helm.releases.some(r => r.name.includes("ingext-lake"));
    result.readiness.phase6Datalake = result.readiness.phase5Stream && hasLake;
    const hasIngress = result.helm.releases.some(r => r.name.includes("ingress") || r.name.includes("alb"));
    result.readiness.phase7Ingress = result.readiness.phase6Datalake && hasIngress;
    // Generate next steps based on readiness
    if (!result.readiness.phase1Foundation) {
        if (result.cluster.status === "missing") {
            nextSteps.unshift("Run: npm run dev -- --approve true (Phase 1: Foundation)");
        }
    }
    else if (!result.readiness.phase2Storage) {
        nextSteps.push("Ready for Phase 2: Storage (S3 bucket and IAM)");
    }
    else if (!result.readiness.phase3Compute) {
        nextSteps.push("Ready for Phase 3: Compute (Karpenter)");
    }
    else if (!result.readiness.phase4CoreServices) {
        nextSteps.push("Ready for Phase 4: Core Services");
    }
    else if (!result.readiness.phase5Stream) {
        nextSteps.push("Ready for Phase 5: Application Stream");
    }
    else if (!result.readiness.phase6Datalake) {
        nextSteps.push("Ready for Phase 6: Application Datalake");
    }
    else if (!result.readiness.phase7Ingress) {
        nextSteps.push("Ready for Phase 7: Ingress");
    }
    else {
        nextSteps.push("✅ All phases complete! Lakehouse is fully deployed.");
    }
    return result;
}
