import { spawn } from "node:child_process";
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
            console.error(`[DEBUG] Docker exec: ${fullCmd} ${fullArgs.join(" ")}`);
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
        console.error(`[DEBUG] Spawned PID: ${child.pid}`);
        let stdout = "";
        let stderr = "";
        // For long-running commands (like eksctl create cluster), stream output to show progress
        // This allows users to see eksctl's progress messages in real-time
        const isLongRunningCommand = (cmd === "eksctl" && args[0] === "create" && args[1] === "cluster") ||
            (cmd === "eksctl" && args[0] === "delete" && args[1] === "cluster") ||
            (cmd === "helm" && args.includes("--wait"));
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
