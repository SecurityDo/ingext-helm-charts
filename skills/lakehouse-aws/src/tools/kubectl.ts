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

export async function getPodEvents(
  podName: string,
  namespace: string,
  profile: string,
  region: string
): Promise<{ ok: boolean; events: string }> {
  const result = await kubectl(
    ["describe", "pod", podName, "-n", namespace],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (result.ok) {
    // Extract Events section
    const lines = result.stdout.split("\n");
    const eventsIndex = lines.findIndex(line => line.startsWith("Events:"));
    if (eventsIndex !== -1) {
      const events = lines.slice(eventsIndex, eventsIndex + 15).join("\n");
      return { ok: true, events };
    }
  }

  return { ok: false, events: "" };
}

export async function getPodsInNamespace(
  namespace: string,
  labelSelector: string,
  profile: string,
  region: string
): Promise<{ ok: boolean; pods: any[] }> {
  const result = await kubectl(
    ["get", "pods", "-n", namespace, "-l", labelSelector, "-o", "json"],
    { AWS_PROFILE: profile, AWS_REGION: region }
  );

  if (result.ok) {
    try {
      const data = JSON.parse(result.stdout);
      return { ok: true, pods: data.items || [] };
    } catch (e) {
      return { ok: false, pods: [] };
    }
  }

  return { ok: false, pods: [] };
}
