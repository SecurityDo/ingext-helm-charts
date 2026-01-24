import { run } from "./shell.js";

export type Env = Record<string, string>;

export async function helm(args: string[], env?: Env) {
  return run("helm", args, env);
}

export async function upgradeInstall(
  release: string,
  chart: string,
  namespace: string,
  set?: Record<string, string>,
  env?: Env
) {
  const args = ["upgrade", "--install", release, chart, "--namespace", namespace];
  if (set) {
    for (const [key, value] of Object.entries(set)) {
      args.push("--set", `${key}=${value}`);
    }
  }
  return helm(args, env);
}
