import { PreflightResult } from "./skill.js";
import { runPhase1Foundation, Phase1Evidence } from "./steps/install/phase1-foundation.js";
import { runPhase2Storage, Phase2Evidence } from "./steps/install/phase2-storage.js";
import { runPhase3Compute, Phase3Evidence } from "./steps/install/phase3-compute.js";

export type InstallInput = {
  approve: boolean;
  env: Record<string, string>; // from preflight result
};

export type InstallResult = {
  status: "needs_input" | "completed_phase" | "blocked_phase" | "error";
  phase?: "foundation" | "storage" | "compute" | "core" | "stream" | "datalake" | "ingress";
  required?: string[];
  plan?: string;
  evidence?: 
    | Phase1Evidence 
    | Phase2Evidence 
    | Phase3Evidence
    | { phase1: Phase1Evidence; phase2: Phase2Evidence }
    | { phase1: Phase1Evidence; phase2: Phase2Evidence; phase3: Phase3Evidence };
  blockers?: Array<{ code: string; message: string }>;
  next?: { action: "install" | "fix" | "stop"; phase?: string };
};

function renderInstallPlan(env: Record<string, string>): string {
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

═══════════════════════════════════════════════════════════════

To proceed, run with --approve true
`.trim();
}

export async function runInstall(input: InstallInput, preflightResult: PreflightResult): Promise<InstallResult> {
  // Approval gate
  if (!input.approve) {
    return {
      status: "needs_input",
      required: ["approve"],
      plan: renderInstallPlan(input.env),
    };
  }

  // Check preflight passed
  if (!preflightResult.okToInstall) {
    return {
      status: "error",
      blockers: preflightResult.blockers,
    };
  }

  // Run Phase 1: Foundation
  const phase1Result = await runPhase1Foundation(input.env);

  if (!phase1Result.ok) {
    return {
      status: "error",
      phase: "foundation",
      evidence: phase1Result.evidence,
      blockers: phase1Result.blockers,
    };
  }

  // Run Phase 2: Storage
  const phase2Result = await runPhase2Storage(input.env);

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
  const phase3Result = await runPhase3Compute(input.env);

  if (!phase3Result.ok) {
    // Determine if this is a blocker (dependencies not met) or error (fatal)
    const isDependencyIssue = phase3Result.blockers.some(
      b => b.code === "NO_NODES_AVAILABLE" || 
           b.code === "NO_READY_NODES" || 
           b.code === "PHASE1_INCOMPLETE"
    );

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

  return {
    status: "completed_phase",
    phase: "compute",
    evidence: {
      phase1: phase1Result.evidence,
      phase2: phase2Result.evidence,
      phase3: phase3Result.evidence,
    },
    next: {
      action: "install",
      phase: "core_services",
    },
  };
}
