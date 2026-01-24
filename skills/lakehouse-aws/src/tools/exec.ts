import { spawn } from "node:child_process";
import { resolve } from "node:path";

export type ExecMode = "docker" | "local";

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export function execCmd(
  mode: ExecMode,
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string>; cwd?: string }
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    // Determine the actual command and args based on execution mode
    let fullCmd: string;
    let fullArgs: string[];
    let execOpts: { env: NodeJS.ProcessEnv; cwd?: string; stdio: any };

    if (mode === "docker") {
      // Find repo root by going up from skills/lakehouse-aws to repo root
      // The script is at ./bin/run-in-docker.sh relative to skills/lakehouse-aws
      fullCmd = "./bin/run-in-docker.sh";
      fullArgs = [cmd, ...args];
      // Merge process.env with opts.env to ensure AWS credentials are passed through
      const mergedEnv = { ...process.env, ...(opts?.env ?? {}) };
      execOpts = {
        env: mergedEnv,
        cwd: opts?.cwd ?? process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      };
      console.error(`[DEBUG] Docker exec: ${fullCmd} ${fullArgs.join(" ")}`);
    } else {
      // Local execution
      fullCmd = cmd;
      fullArgs = args;
      execOpts = {
        env: { ...process.env, ...(opts?.env ?? {}) },
        cwd: opts?.cwd,
        stdio: ["ignore", "pipe", "pipe"],
      };
    }

    const child = spawn(fullCmd, fullArgs, execOpts);
    console.error(`[DEBUG] Spawned PID: ${child.pid}`);

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}
