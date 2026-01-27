import { spawn } from "node:child_process";
import { startSpinner, stopSpinner } from "./spinner.js";
export function execCmd(mode, cmd, args, opts) {
    return new Promise((resolve, reject) => {
        // Determine the actual command and args based on execution mode
        let fullCmd;
        let fullArgs;
        let execOpts;
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
        }
        else {
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
        // Start spinner for short-running commands (not verbose mode)
        const showSpinner = !isLongRunningCommand && !opts?.verbose;
        if (showSpinner) {
            const commandDesc = `${cmd} ${args.slice(0, 2).join(" ")}${args.length > 2 ? "..." : ""}`;
            startSpinner(`Running ${commandDesc}`);
        }
        if (isLongRunningCommand) {
            // Stream both stdout and stderr to console so user sees progress in real-time
            child.stdout?.on("data", (d) => {
                const output = d.toString();
                stdout += output;
                // Forward to stderr so user sees it (eksctl outputs progress to stdout)
                process.stderr.write(output);
            });
            child.stderr?.on("data", (d) => {
                const output = d.toString();
                stderr += output;
                // Forward eksctl progress messages to stderr
                process.stderr.write(output);
            });
        }
        else {
            // For regular commands, just collect output
            child.stdout?.on("data", (d) => (stdout += d.toString()));
            child.stderr?.on("data", (d) => (stderr += d.toString()));
        }
        child.on("error", (err) => {
            if (showSpinner)
                stopSpinner();
            // Handle ENOENT (command not found) gracefully
            if (err.code === "ENOENT") {
                resolve({
                    code: 127, // Standard "command not found" exit code
                    stdout: "",
                    stderr: `Command not found: ${cmd}. ${mode === "local" ? "Install it or use --exec docker to run in Docker container." : "This should not happen in Docker mode."}`,
                });
            }
            else {
                reject(err);
            }
        });
        child.on("close", (code) => {
            if (showSpinner)
                stopSpinner();
            resolve({
                code: code ?? 1,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
            });
        });
    });
}
