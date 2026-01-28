import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { startSpinner, stopSpinner } from "./spinner.js";

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
  opts?: { env?: Record<string, string>; cwd?: string; verbose?: boolean }
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

    let stdout = "";
    let stderr = "";

    // For long-running commands (like eksctl create cluster), stream output to show progress
    // This allows users to see eksctl's progress messages in real-time
    const isLongRunningCommand = (cmd === "eksctl" && args[0] === "create" && args[1] === "cluster") ||
                                 (cmd === "eksctl" && args[0] === "delete" && args[1] === "cluster") ||
                                 (cmd === "helm" && args.includes("--wait"));
    
    // Start spinner only for short-running commands, when not verbose, and when stderr is a TTY.
    // When stderr is not a TTY (e.g. piped, CI, or some terminals), \r doesn't clear the line
    // and spinner output appends instead of updating in place.
    const showSpinner = !isLongRunningCommand && !opts?.verbose && typeof process.stderr.isTTY === "boolean" && process.stderr.isTTY;
    if (showSpinner) {
      const commandDesc = `${cmd} ${args.slice(0, 2).join(" ")}${args.length > 2 ? "..." : ""}`;
      startSpinner(`Running ${commandDesc}`);
    }
    
    if (isLongRunningCommand) {
      const isEksctlCreate = cmd === "eksctl" && args[0] === "create" && args[1] === "cluster";
      // For eksctl create cluster, only stream errors and important warnings to reduce noise
      const shouldForwardLine = (line: string): boolean => {
        if (!isEksctlCreate) return true;
        const t = line.trim();
        if (!t) return false;
        if (/\[\s*✖\s*\]|Error:|failed to|AlreadyExistsException|already exists/i.test(t)) return true;
        if (/\[!\].*error|\[!\].*fail/i.test(t)) return true;
        return false;
      };
      const stdoutLineBuf = { buf: "" };
      const stderrLineBuf = { buf: "" };
      const flushAndMaybeForward = (chunk: string, buf: { buf: string }) => {
        buf.buf += chunk;
        const lines = buf.buf.split("\n");
        buf.buf = lines.pop() ?? "";
        for (const line of lines) {
          if (shouldForwardLine(line)) process.stderr.write(line + "\n");
        }
      };
      if (isEksctlCreate) {
        child.stdout?.on("data", (d) => {
          const out = d.toString();
          stdout += out;
          flushAndMaybeForward(out, stdoutLineBuf);
        });
        child.stderr?.on("data", (d) => {
          const out = d.toString();
          stderr += out;
          flushAndMaybeForward(out, stderrLineBuf);
        });
      } else {
        child.stdout?.on("data", (d) => {
          const output = d.toString();
          stdout += output;
          process.stderr.write(output);
        });
        child.stderr?.on("data", (d) => {
          const output = d.toString();
          stderr += output;
          process.stderr.write(output);
        });
      }
    } else {
      // For regular commands, just collect output
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
    }

    child.on("error", (err: any) => {
      if (showSpinner) stopSpinner();
      
      // Handle ENOENT (command not found) gracefully
      if (err.code === "ENOENT") {
        resolve({
          code: 127, // Standard "command not found" exit code
          stdout: "",
          stderr: `Command not found: ${cmd}. ${mode === "local" ? "Install it or use --exec docker to run in Docker container." : "This should not happen in Docker mode."}`,
        });
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (showSpinner) stopSpinner();
      
      resolve({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}
