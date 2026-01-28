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

    const isEksctlCreate = cmd === "eksctl" && args[0] === "create" && args[1] === "cluster";
    const isEksctlDelete = cmd === "eksctl" && args[0] === "delete" && args[1] === "cluster";

    // For long-running commands (like eksctl create cluster), stream output to show progress
    // This allows users to see eksctl's progress messages in real-time
    const isLongRunningCommand = isEksctlCreate || isEksctlDelete || (cmd === "helm" && args.includes("--wait"));

    // Set a timeout for the command to prevent permanent hangs
    // Default to 2 minutes for most commands, 20 minutes for long-running ones
    const timeoutMs = isLongRunningCommand ? 20 * 60 * 1000 : 2 * 60 * 1000;
    const killTimeout = setTimeout(() => {
      if (child.kill()) {
        console.error(`\n❌ Command timed out after ${timeoutMs / 1000}s and was killed: ${cmd} ${args.join(" ")}`);
      }
    }, timeoutMs);

    let stdout = "";
    let stderr = "";

    // Show feedback for ANY command that takes more than 5 seconds
    const feedbackTimeout = setTimeout(() => {
      if (opts?.verbose || isLongRunningCommand) {
        process.stderr.write(`\n⏳ Still running: ${cmd} ${args.slice(0, 3).join(" ")}${args.length > 3 ? "..." : ""} (taking longer than expected)\n`);
      }
    }, 5000);

    // Start spinner only for short-running commands, when not verbose, and when stderr is a TTY.
    const showSpinner = !isLongRunningCommand && !opts?.verbose && typeof process.stderr.isTTY === "boolean" && process.stderr.isTTY;
    if (showSpinner) {
      const commandDesc = `${cmd} ${args.slice(0, 2).join(" ")}${args.length > 2 ? "..." : ""}`;
      startSpinner(`Running ${commandDesc}`);
    }

    let timer: NodeJS.Timeout | undefined;
    let lastElapsedStr = "";
    
    if (isLongRunningCommand && typeof process.stderr.isTTY === "boolean" && process.stderr.isTTY) {
      const startTime = Date.now();
      const actionDesc = isEksctlCreate ? "Creating cluster" : isEksctlDelete ? "Deleting cluster" : "Waiting for helm";
      
      timer = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const minutes = Math.floor(elapsed / 60);
        const seconds = elapsed % 60;
        lastElapsedStr = `   ⏳ ${actionDesc}... [${minutes}m ${seconds}s elapsed]`;
        process.stderr.write(`\r${lastElapsedStr}${" ".repeat(10)}\r`);
      }, 1000);
    }
    
    if (isLongRunningCommand) {
      // For eksctl create cluster, stream milestones and errors
      const shouldForwardLine = (line: string): boolean => {
        if (!isEksctlCreate && !isEksctlDelete) return true;
        const t = line.trim();
        if (!t) return false;
        // Show milestones [ℹ], errors [✖], and warnings [!]
        if (/\[ℹ\]|\[\s*✖\s*\]|\[!\]|Error:|failed to|AlreadyExistsException|already exists/i.test(t)) return true;
        return false;
      };
      
      const clearTimerLine = () => {
        if (timer && lastElapsedStr) {
          process.stderr.write(`\r${" ".repeat(lastElapsedStr.length + 15)}\r`);
        }
      };

      const stdoutLineBuf = { buf: "" };
      const stderrLineBuf = { buf: "" };
      
      const flushAndMaybeForward = (chunk: string, buf: { buf: string }) => {
        buf.buf += chunk;
        const lines = buf.buf.split("\n");
        buf.buf = lines.pop() ?? "";
        for (const line of lines) {
          if (shouldForwardLine(line)) {
            clearTimerLine();
            process.stderr.write(line + "\n");
          }
        }
      };

      child.stdout?.on("data", (d) => {
        const out = d.toString();
        stdout += out;
        if (isEksctlCreate || isEksctlDelete) {
          flushAndMaybeForward(out, stdoutLineBuf);
        } else {
          process.stderr.write(out);
        }
      });
      child.stderr?.on("data", (d) => {
        const out = d.toString();
        stderr += out;
        if (isEksctlCreate || isEksctlDelete) {
          flushAndMaybeForward(out, stderrLineBuf);
        } else {
          process.stderr.write(out);
        }
      });
    } else {
      // For regular commands, just collect output
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
    }

    child.on("error", (err: any) => {
      clearTimeout(killTimeout);
      clearTimeout(feedbackTimeout);
      if (showSpinner) stopSpinner();
      if (timer) clearInterval(timer);
      
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
      clearTimeout(killTimeout);
      clearTimeout(feedbackTimeout);
      if (showSpinner) stopSpinner();
      if (timer) {
        clearInterval(timer);
        // Final clear of the timer line
        if (lastElapsedStr) {
          process.stderr.write(`\r${" ".repeat(lastElapsedStr.length + 15)}\r`);
        }
      }
      
      resolve({
        code: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}
