import { execCmd } from "./exec.js";
let EXEC_MODE = "local"; // default
export function setExecMode(mode) {
    EXEC_MODE = mode;
}
export function getExecMode() {
    return EXEC_MODE;
}
export function run(cmd, args, env) {
    return execCmd(EXEC_MODE, cmd, args, { env }).then((r) => ({
        ok: r.code === 0,
        exitCode: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
    }));
}
