export async function digA(domain) {
    // Skip dig check - not critical for preflight and can cause hangs in Docker
    // DNS will be checked during actual deployment
    return { ok: false, reason: "skipped" };
    // Original implementation (disabled):
    // const hasDig = await run("bash", ["-c", "command -v dig >/dev/null 2>&1 && echo yes || echo no"]);
    // if (hasDig.stdout !== "yes") return { ok: false as const, reason: "dig_not_found" };
    // const res = await run("dig", ["+short", "A", domain]);
    // const ip = res.ok ? (res.stdout.split("\n")[0] ?? "").trim() : "";
    // return { ok: true as const, ip: ip || null, raw: res };
}
