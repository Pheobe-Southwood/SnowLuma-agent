import { access, copyFile, chmod, mkdir, rename, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function ensureConversationPrompt(convDir: string, promptsDir: string): Promise<string> {
  await mkdir(convDir, { recursive: true, mode: 0o700 });
  const defaultPath = join(promptsDir, "SYSTEM_DEFAULT.md");
  const targetPath = join(convDir, "prompt.md");
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

export async function readConversationPrompt(convDir: string, promptsDir: string): Promise<string> {
  return readFile(await ensureConversationPrompt(convDir, promptsDir), "utf8");
}
