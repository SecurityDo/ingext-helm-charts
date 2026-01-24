import { run } from "./shell.js";

export async function digA(domain: string) {
  const hasDig = await run("bash", ["-lc", "command -v dig >/dev/null 2>&1 && echo yes || echo no"]);
  if (hasDig.stdout !== "yes") return { ok: false as const, reason: "dig_not_found" };

  const res = await run("dig", ["+short", "A", domain]);
  const ip = res.ok ? (res.stdout.split("\n")[0] ?? "").trim() : "";
  return { ok: true as const, ip: ip || null, raw: res };
}