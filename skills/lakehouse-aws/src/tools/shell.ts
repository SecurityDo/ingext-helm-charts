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

export function run(cmd: string, args: string[], env?: Record<string, string>): Promise<ShellResult> {
  return execCmd(EXEC_MODE, cmd, args, { env }).then((r) => ({
    ok: r.code === 0,
    exitCode: r.code,
    stdout: r.stdout,
    stderr: r.stderr,
  }));
}