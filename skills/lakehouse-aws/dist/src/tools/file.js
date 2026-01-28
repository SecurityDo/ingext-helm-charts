import { existsSync, readdirSync } from "node:fs";
import { writeFile, readFile } from "node:fs/promises";
export async function writeEnvFile(path, envLines, overwrite) {
    if (existsSync(path) && !overwrite) {
        return { ok: false, error: `Env file already exists: ${path}. Use --overwrite-env to replace.` };
    }
    await writeFile(path, envLines.join("\n") + "\n", "utf8");
    return { ok: true };
}
/**
 * Reads environment variables from a shell-exported .env file.
 * Parses lines like: export KEY="value" or export KEY=value
 * Returns a Record<string, string> of key-value pairs.
 */
export async function readEnvFile(path) {
    if (!existsSync(path)) {
        return { ok: false, error: `Env file not found: ${path}` };
    }
    try {
        const content = await readFile(path, "utf8");
        const env = {};
        for (const line of content.split("\n")) {
            const trimmed = line.trim();
            // Skip comments and empty lines
            if (!trimmed || trimmed.startsWith("#"))
                continue;
            // Match: export KEY="value" or export KEY=value
            const match = trimmed.match(/^export\s+([A-Z_][A-Z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s#]*))/);
            if (match) {
                const key = match[1];
                const value = match[2] || match[3] || match[4] || "";
                env[key] = value;
            }
        }
        return { ok: true, env };
    }
    catch (err) {
        return { ok: false, error: `Failed to read env file: ${err instanceof Error ? err.message : String(err)}` };
    }
}
/**
 * Discovers namespace-scoped env files matching the pattern lakehouse_*.env
 * Returns an array of discovered namespaces (extracted from filenames).
 */
export function discoverEnvFiles(cwd = ".") {
    try {
        const files = readdirSync(cwd);
        const envFiles = files.filter(f => f.startsWith("lakehouse_") && f.endsWith(".env"));
        // Extract namespace from lakehouse_{namespace}.env
        return envFiles.map(f => {
            const match = f.match(/^lakehouse_(.+)\.env$/);
            return match ? match[1] : null;
        }).filter((ns) => ns !== null);
    }
    catch (err) {
        return [];
    }
}
