import { execCmd } from "../tools/exec.js";

export async function checkDockerAvailable(): Promise<{
  ok: boolean;
  version?: string;
  error?: string;
}> {
  try {
    const res = await execCmd("local", "docker", ["version", "--format", "{{.Server.Version}}"]);
    if (res.code === 0) {
      return { ok: true, version: res.stdout.trim() };
    }
    return { ok: false, error: res.stderr || "Docker is not running or not accessible" };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
