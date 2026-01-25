import { runPhase1Foundation } from "./steps/install/phase1-foundation.js";
import { runPhase2Storage } from "./steps/install/phase2-storage.js";
import { runPhase3Compute } from "./steps/install/phase3-compute.js";
import { runPhase4CoreServices } from "./steps/install/phase4-core-services.js";
import { runPhase5Stream } from "./steps/install/phase5-stream.js";
import { runPhase6Datalake } from "./steps/install/phase6-datalake.js";
import { runPhase7Ingress } from "./steps/install/phase7-ingress.js";
import { readEnvFile } from "./tools/file.js";
function renderInstallPlan(env) {
    return `
═══════════════════════════════════════════════════════════════
Installation Plan
═══════════════════════════════════════════════════════════════

Phase 1: Foundation (EKS)
  • EKS Cluster: ${env.CLUSTER_NAME}
  • Region: ${env.AWS_REGION}
  • Node Type: ${env.NODE_TYPE}
  • Node Count: ${env.NODE_COUNT}
  • Kubernetes Version: 1.34

  Components to install:
  • EKS Pod Identity Agent
  • EBS CSI Driver
  • S3 CSI Driver (Mountpoint)
  • GP3 StorageClass

Phase 2: Storage (S3 & IAM)
  • S3 Bucket: ${env.S3_BUCKET}
  • Region: ${env.AWS_REGION}
  • IAM Policy: S3 access for lakehouse
  • Namespace: ${env.NAMESPACE || "ingext"}
  • Pod Identity: Link ServiceAccount to IAM role

Phase 3: Compute (Karpenter)
  • Cluster: ${env.CLUSTER_NAME}
  • Version: 1.8.3 (compatible with EKS 1.34+)
  • Autoscaling: Karpenter controller + node pools
  • IAM: Node role + Controller role with Pod Identity

Phase 4: Core Services
  • Namespace: ${env.NAMESPACE || "ingext"}
  • Charts to install:
    - ingext-stack (Redis, OpenSearch, VictoriaMetrics)
    - etcd-single
    - etcd-single-cronjob
  • App Secret: Token for CLI access
  • Pod Readiness: Wait for all pods to be Ready

Phase 5: Application Stream
  • Namespace: ${env.NAMESPACE || "ingext"}
  • Site Domain: ${env.SITE_DOMAIN || "N/A"}
  • Charts to install:
    - ingext-community-config (with siteDomain)
    - ingext-community-init
    - ingext-community
  • Pod Readiness: Wait for all pods to be Ready (15 min timeout)

Phase 6: Application Datalake
  • S3 Bucket: ${env.S3_BUCKET}
  • Region: ${env.AWS_REGION}
  • Charts to install:
    - ingext-lake-config (storageType=s3)
    - ingext-merge-pool (Karpenter node pool)
    - ingext-search-pool (Karpenter node pool, 128 CPU / 512Gi memory)
    - ingext-s3-lake (bucket wiring)
    - ingext-lake (lake services)
  • Pod Readiness: Wait for all pods to be Ready (15 min timeout)

═══════════════════════════════════════════════════════════════

To proceed, run with --approve true
`.trim();
}
export async function runInstall(input, preflightResult) {
    const verbose = input.verbose !== false; // Default to true for user feedback
    // If preflightResult is provided, use it (normal flow)
    // Otherwise, require namespace and load env file (standalone install flow)
    let env = input.env;
    let namespace = input.namespace || env.NAMESPACE;
    if (!preflightResult) {
        // Standalone install: require namespace and env file
        if (!namespace) {
            return {
                status: "error",
                blockers: [
                    {
                        code: "NAMESPACE_REQUIRED",
                        message: "Namespace is required for install. Provide --namespace or ensure NAMESPACE is in the env file.",
                    },
                ],
            };
        }
        // Load namespace-scoped env file
        const envFilePath = input.envFile || `./lakehouse_${namespace}.env`;
        const envFileResult = await readEnvFile(envFilePath);
        if (!envFileResult.ok || !envFileResult.env) {
            return {
                status: "error",
                blockers: [
                    {
                        code: "ENV_FILE_MISSING",
                        message: `No environment file found for namespace '${namespace}'. Expected: ${envFilePath}`,
                    },
                    {
                        code: "ENV_FILE_MISSING_REMEDIATION",
                        message: `Run preflight first to generate ${envFilePath}`,
                    },
                ],
            };
        }
        // Merge env file values with provided env (provided env takes precedence)
        env = { ...envFileResult.env, ...env };
        namespace = env.NAMESPACE || namespace;
    }
    else {
        // Normal flow: use preflight result
        env = preflightResult.env;
        namespace = env.NAMESPACE;
    }
    // Approval gate
    if (!input.approve) {
        return {
            status: "needs_input",
            required: ["approve"],
            plan: renderInstallPlan(env),
        };
    }
    // Check preflight passed (if preflight was run)
    if (preflightResult && !preflightResult.okToInstall) {
        return {
            status: "error",
            blockers: preflightResult.blockers,
        };
    }
    // Run Phase 1: Foundation
    if (verbose) {
        console.error("\n" + "=".repeat(60));
        console.error("🚀 Phase 1: Foundation (EKS Cluster)");
        console.error("=".repeat(60));
    }
    const phase1Result = await runPhase1Foundation(env, { verbose });
    if (!phase1Result.ok) {
        return {
            status: "error",
            phase: "foundation",
            evidence: phase1Result.evidence,
            blockers: phase1Result.blockers,
        };
    }
    // Run Phase 2: Storage
    if (verbose) {
        console.error("\n" + "=".repeat(60));
        console.error("💾 Phase 2: Storage (S3 & IAM)");
        console.error("=".repeat(60));
    }
    const phase2Result = await runPhase2Storage(env, { verbose });
    if (!phase2Result.ok) {
        return {
            status: "error",
            phase: "storage",
            evidence: {
                phase1: phase1Result.evidence,
                phase2: phase2Result.evidence,
            },
            blockers: phase2Result.blockers,
        };
    }
    // Run Phase 3: Compute
    if (verbose) {
        console.error("\n" + "=".repeat(60));
        console.error("⚙️  Phase 3: Compute (Karpenter)");
        console.error("=".repeat(60));
    }
    const phase3Result = await runPhase3Compute(env, { force: input.force, verbose });
    if (!phase3Result.ok) {
        // Determine if this is a blocker (dependencies not met) or error (fatal)
        const isDependencyIssue = phase3Result.blockers.some(b => b.code === "NO_NODES_AVAILABLE" ||
            b.code === "NO_READY_NODES" ||
            b.code === "PHASE1_INCOMPLETE");
        return {
            status: isDependencyIssue ? "blocked_phase" : "error",
            phase: "compute",
            evidence: {
                phase1: phase1Result.evidence,
                phase2: phase2Result.evidence,
                phase3: phase3Result.evidence,
            },
            blockers: phase3Result.blockers,
            next: {
                action: isDependencyIssue ? "fix" : "stop",
                phase: isDependencyIssue ? "foundation" : undefined,
            },
        };
    }
    // Run Phase 4: Core Services
    if (verbose) {
        console.error("\n" + "=".repeat(60));
        console.error("🔧 Phase 4: Core Services");
        console.error("=".repeat(60));
    }
    const phase4Result = await runPhase4CoreServices(env, { force: input.force, verbose });
    if (!phase4Result.ok) {
        // Determine if this is a blocker (platform health) or error (fatal)
        const isDependencyIssue = phase4Result.blockers.some(b => b.code === "NO_NODES_AVAILABLE" ||
            b.code === "NO_READY_NODES" ||
            b.code === "KARPENTER_NOT_READY" ||
            b.code === "PLATFORM_EVENTS" ||
            b.code.startsWith("POD_"));
        return {
            status: isDependencyIssue ? "blocked_phase" : "error",
            phase: "core",
            evidence: {
                phase1: phase1Result.evidence,
                phase2: phase2Result.evidence,
                phase3: phase3Result.evidence,
                phase4: phase4Result.evidence,
            },
            blockers: phase4Result.blockers,
            next: {
                action: isDependencyIssue ? "fix" : "stop",
                phase: isDependencyIssue ? "compute" : undefined,
            },
        };
    }
    // Run Phase 5: Stream
    if (verbose) {
        console.error("\n" + "=".repeat(60));
        console.error("🌊 Phase 5: Application Stream");
        console.error("=".repeat(60));
    }
    const phase5Result = await runPhase5Stream(env, { force: input.force, verbose });
    if (!phase5Result.ok) {
        // Determine if this is a blocker (platform health) or error (fatal)
        const isDependencyIssue = phase5Result.blockers.some(b => b.code === "PLATFORM_UNHEALTHY" ||
            b.code === "PHASE4_PODS_NOT_READY" ||
            b.code === "PODS_NOT_READY");
        return {
            status: isDependencyIssue ? "blocked_phase" : "error",
            phase: "stream",
            evidence: {
                phase1: phase1Result.evidence,
                phase2: phase2Result.evidence,
                phase3: phase3Result.evidence,
                phase4: phase4Result.evidence,
                phase5: phase5Result.evidence,
            },
            blockers: phase5Result.blockers,
            next: {
                action: isDependencyIssue ? "fix" : "stop",
                phase: isDependencyIssue ? "core" : undefined,
            },
        };
    }
    // Run Phase 6: Datalake
    if (verbose) {
        console.error("\n" + "=".repeat(60));
        console.error("🏗️  Phase 6: Application Datalake");
        console.error("=".repeat(60));
    }
    const phase6Result = await runPhase6Datalake(env, { force: input.force, verbose });
    if (!phase6Result.ok) {
        // Determine if this is a blocker (dependencies not met) or error (fatal)
        const isDependencyIssue = phase6Result.blockers.some(b => b.code === "STREAM_PODS_NOT_READY" ||
            b.code === "STREAM_PODS_CHECK_FAILED" ||
            b.code === "S3_BUCKET_NOT_FOUND" ||
            b.code === "POD_IDENTITY_NOT_FOUND" ||
            b.code === "POD_IDENTITY_CHECK_FAILED" ||
            b.code === "KARPENTER_NOT_READY" ||
            b.code === "KARPENTER_NOT_INSTALLED" ||
            b.code === "PODS_NOT_READY");
        return {
            status: isDependencyIssue ? "blocked_phase" : "error",
            phase: "datalake",
            evidence: {
                phase1: phase1Result.evidence,
                phase2: phase2Result.evidence,
                phase3: phase3Result.evidence,
                phase4: phase4Result.evidence,
                phase5: phase5Result.evidence,
                phase6: phase6Result.evidence,
            },
            blockers: phase6Result.blockers,
            next: {
                action: isDependencyIssue ? "fix" : "stop",
                phase: isDependencyIssue ? "stream" : undefined,
            },
        };
    }
    // Run Phase 7: Ingress
    if (verbose) {
        console.error("\n" + "=".repeat(60));
        console.error("🌐 Phase 7: Ingress (External Access)");
        console.error("=".repeat(60));
    }
    const phase7Result = await runPhase7Ingress(env, { force: input.force, verbose });
    if (!phase7Result.ok) {
        return {
            status: "error",
            phase: "ingress",
            evidence: {
                phase1: phase1Result.evidence,
                phase2: phase2Result.evidence,
                phase3: phase3Result.evidence,
                phase4: phase4Result.evidence,
                phase5: phase5Result.evidence,
                phase6: phase6Result.evidence,
                phase7: phase7Result.evidence,
            },
            blockers: phase7Result.blockers,
            next: {
                action: "stop",
            },
        };
    }
    // ============================================================
    // Installation Complete!
    // ============================================================
    if (verbose) {
        const siteDomain = env.SITE_DOMAIN || "N/A";
        const albStatus = phase7Result.evidence.ingress.albStatus || "PROVISIONING";
        const albDnsName = phase7Result.evidence.ingress.albDnsName;
        console.error("\n" + "=".repeat(60));
        console.error("🎉 Installation Complete (Phases 1-7)");
        console.error("=".repeat(60));
        console.error("");
        console.error("Core Platform:  ✓ Ready");
        console.error("Applications:   ✓ Ready");
        console.error("Data Lake:      ✓ Ready");
        console.error(`Ingress:        ${albStatus === "ACTIVE" ? "✓" : "⏳"} ${albStatus}`);
        console.error("");
        console.error("Next Steps:");
        if (albStatus === "PROVISIONING" || !albDnsName) {
            console.error("  • Wait 5-10 minutes for AWS Load Balancer provisioning");
        }
        if (phase7Result.evidence.dns.instruction) {
            console.error("  • DNS Setup:");
            const instructions = phase7Result.evidence.dns.instruction.split("\n");
            instructions.forEach(line => {
                if (line.trim()) {
                    console.error(`    ${line}`);
                }
            });
        }
        console.error(`  • Visit: https://${siteDomain}`);
        console.error("");
        console.error("Run 'npm run dev -- --action status' to check ALB status");
        console.error("=".repeat(60));
    }
    return {
        status: "completed",
        phase: "ingress",
        evidence: {
            phase1: phase1Result.evidence,
            phase2: phase2Result.evidence,
            phase3: phase3Result.evidence,
            phase4: phase4Result.evidence,
            phase5: phase5Result.evidence,
            phase6: phase6Result.evidence,
            phase7: phase7Result.evidence,
        },
    };
}
