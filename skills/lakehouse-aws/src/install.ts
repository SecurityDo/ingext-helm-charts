import { PreflightResult } from "./skill.js";
import { runPhase1Foundation, Phase1Evidence } from "./steps/install/phase1-foundation.js";

export type InstallInput = {
  approve: boolean;
  env: Record<string, string>; // from preflight result
};

export type InstallResult = {
  status: "needs_input" | "completed_phase" | "error";
  phase?: "foundation";
  required?: string[];
  plan?: string;
  evidence?: Phase1Evidence;
  blockers?: Array<{ code: string; message: string }>;
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

  return {
    status: "completed_phase",
    phase: "foundation",
    evidence: phase1Result.evidence,
  };
}
