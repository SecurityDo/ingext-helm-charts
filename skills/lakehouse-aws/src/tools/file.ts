import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

export async function writeEnvFile(path: string, envLines: string[], overwrite: boolean) {
  if (existsSync(path) && !overwrite) {
    return { ok: false as const, error: `Env file already exists: ${path}. Use --overwrite-env to replace.` };
  }
  await writeFile(path, envLines.join("\n") + "\n", "utf8");
  return { ok: true as const };
}