import { run } from "./shell.js";

export type Env = Record<string, string>;

export async function kubectl(args: string[], env?: Env) {
  return run("kubectl", args, env);
}

export async function getNodes(env?: Env) {
  return kubectl(["get", "nodes", "--output", "json"], env);
}

export async function apply(manifest: string, env?: Env) {
  return kubectl(["apply", "-f", "-"], env);
}
