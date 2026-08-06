import { access, copyFile, mkdir, open, readFile, rename, chmod } from "node:fs/promises";
import { join } from "node:path";
import type { SessionTarget } from "./types.js";

function promptId(target: SessionTarget): string {
  return target.kind === "private" ? String(target.userId) : String(target.groupId);
}

export async function ensurePromptFile(promptsDir: string, target: SessionTarget): Promise<string> {
  await mkdir(promptsDir, { recursive: true, mode: 0o700 });
  const defaultPath = join(promptsDir, "SYSTEM_DEFAULT.md");
  const targetPath = join(promptsDir, `SYSTEM_${promptId(target)}.md`);
  await access(defaultPath).catch(() => { throw new Error(`缺少 ${defaultPath}，请先运行 init`); });
  try {
    await access(targetPath);
  } catch {
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    await copyFile(defaultPath, tempPath);
    await chmod(tempPath, 0o600);
    try { await rename(tempPath, targetPath); } catch (error: unknown) {
      await access(targetPath).catch(() => { throw error; });
    }
  }
  return targetPath;
}

export async function readSystemPrompt(promptsDir: string, target: SessionTarget): Promise<string> {
  return readFile(await ensurePromptFile(promptsDir, target), "utf8");
}
