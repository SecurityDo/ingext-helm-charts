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
  
  // Also retry on generic Helm/K8s connection timeouts
  const isTimeout = result.stderr.includes("context deadline exceeded") ||
                    result.stderr.includes("connection timed out") ||
                    result.stderr.includes("request canceled");

  if (isK8sCommand && (isUnauthorized || isTimeout) && env?.CLUSTER_NAME && env?.AWS_REGION) {
    if (isUnauthorized) {
      process.stderr.write(`\n⚠️  Kubernetes credentials expired. Attempting to refresh kubeconfig for ${env.CLUSTER_NAME}...\n`);
      
      // Attempt to refresh kubeconfig
      await execCmd(EXEC_MODE, "aws", [
        "eks", "update-kubeconfig", 
        "--name", env.CLUSTER_NAME, 
        "--region", env.AWS_REGION,
        "--alias", env.CLUSTER_NAME
      ], { env });
      
      process.stderr.write(`✓ Kubeconfig refreshed. Retrying command...\n`);
    } else {
      process.stderr.write(`\n⚠️  Kubernetes command timed out. Retrying in 5s...\n`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    // Retry the original command once
    const retryResult = await execCmd(EXEC_MODE, cmd, args, { env });
    return {
      ok: retryResult.code === 0,
      exitCode: retryResult.code,
      stdout: retryResult.stdout,
      stderr: retryResult.stderr,
    };
  }

  return {
    ok: result.code === 0,
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}