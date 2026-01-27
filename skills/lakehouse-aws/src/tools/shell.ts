import { execCmd, ExecMode } from "./exec.js";

export type ShellResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

let EXEC_MODE: ExecMode = "local"; // default

export function setExecMode(mode: ExecMode) {
  EXEC_MODE = mode;
}

export function getExecMode(): ExecMode {
  return EXEC_MODE;
}

export async function run(cmd: string, args: string[], env?: Record<string, string>): Promise<ShellResult> {
  const result = await execCmd(EXEC_MODE, cmd, args, { env });
  
  // Auto-refresh kubeconfig if unauthorized (EKS token expired)
  const isK8sCommand = cmd === "kubectl" || cmd === "helm";
  const isUnauthorized = result.stderr.includes("Unauthorized") || 
                         result.stderr.includes("asked for the client to provide credentials") ||
                         result.stderr.includes("Kubernetes cluster unreachable");
  
  if (isK8sCommand && isUnauthorized && env?.CLUSTER_NAME && env?.AWS_REGION) {
    process.stderr.write(`\n⚠️  Kubernetes credentials expired. Attempting to refresh kubeconfig for ${env.CLUSTER_NAME}...\n`);
    
    // Attempt to refresh kubeconfig
    const refreshResult = await execCmd(EXEC_MODE, "aws", [
      "eks", "update-kubeconfig", 
      "--name", env.CLUSTER_NAME, 
      "--region", env.AWS_REGION,
      "--alias", env.CLUSTER_NAME
    ], { env });
    
    if (refreshResult.code === 0) {
      process.stderr.write(`✓ Kubeconfig refreshed. Retrying command...\n`);
      // Retry the original command once
      const retryResult = await execCmd(EXEC_MODE, cmd, args, { env });
      return {
        ok: retryResult.code === 0,
        exitCode: retryResult.code,
        stdout: retryResult.stdout,
        stderr: retryResult.stderr,
      };
    } else {
      process.stderr.write(`❌ Failed to refresh kubeconfig: ${refreshResult.stderr.substring(0, 200)}\n`);
    }
  }

  return {
    ok: result.code === 0,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}