import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";
import { envPath, mergeConfig, validateConfig } from "./config.js";
import { ensureConversationPrompt } from "./system_prompt.js";
import type { Config, SessionTarget } from "./types.js";

export interface ConversationContext {
  id: string;
  dir: string;
  config: Config;
  env: Record<string, string>;
  promptPath: string;
}

export const conversationId = (target: SessionTarget): string =>
  target.kind === "private" ? String(target.userId) : String(target.groupId);

export function conversationIdFromSessionKey(sessionKey: string): string {
  if (sessionKey.startsWith("private:")) return sessionKey.slice("private:".length);
  if (sessionKey.startsWith("group:")) return sessionKey.slice("group:".length).split(":")[0] ?? sessionKey;
  return sessionKey;
}

export const conversationDir = (config: Config, target: SessionTarget): string => join(config.conversationsDir, conversationId(target));
export const conversationDirFromKey = (config: Config, sessionKey: string): string => join(config.conversationsDir, conversationIdFromSessionKey(sessionKey));
export const conversationConfigPath = (convDir: string): string => join(convDir, "config.json");
export const conversationEnvPath = (convDir: string): string => join(convDir, ".env");

function conversationDefaults(config: Config, target: SessionTarget): Record<string, unknown> {
  const out: Record<string, unknown> = {
    llm: { ...config.llm },
    session: { ...config.session },
    mcp: { servers: config.mcp.servers },
    skills: { dir: config.skills.dir, enabled: [] },
    reply: { mode: config.reply.mode },
    blockedToolNames: config.blockedToolNames,
  };
  if (target.kind === "group") {
    const id = String(target.groupId);
    const group = config.whitelist.groups[id] ?? {};
    out.whitelist = {
      groups: {
        [id]: {
          mode: group.mode ?? config.whitelist.defaultGroupMode,
          session: group.session ?? config.whitelist.defaultGroupSession,
          ...(group.commandAllowlist ? { commandAllowlist: group.commandAllowlist } : {}),
        },
      },
    };
  }
  return out;
}

async function globalEnvMap(appDir: string): Promise<Record<string, string>> {
  try { return dotenv.parse(await readFile(envPath(appDir), "utf8")); } catch { return {}; }
}

async function ensureConversationConfig(convDir: string, config: Config, target: SessionTarget): Promise<void> {
  const path = conversationConfigPath(convDir);
  if (existsSync(path)) return;
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(conversationDefaults(config, target), null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600);
}

async function ensureConversationEnv(convDir: string, config: Config, appDir: string): Promise<void> {
  const path = conversationEnvPath(convDir);
  const key = config.llm.apiKeyEnv;
  const global = await globalEnvMap(appDir);
  const line = `${key}=${global[key] ?? ""}\n`;
  if (existsSync(path)) {
    const parsed = dotenv.parse(await readFile(path, "utf8"));
    if (parsed[key] !== undefined) return;
    await writeFile(path, `${(await readFile(path, "utf8")).trimEnd()}\n${line}`, { mode: 0o600 });
  } else {
    await writeFile(path, line, { mode: 0o600 });
  }
  await chmod(path, 0o600).catch(() => undefined);
}

export class ConversationStore {
  private readonly cache = new Map<string, ConversationContext>();
  constructor(private readonly options: { config: Config; dir: string }) {}

  async get(target: SessionTarget): Promise<ConversationContext> {
    const id = conversationId(target);
    const cached = this.cache.get(id);
    if (cached) return cached;
    const ctx = await this.load(id, target);
    this.cache.set(id, ctx);
    return ctx;
  }

  private async load(id: string, target: SessionTarget): Promise<ConversationContext> {
    const { config, dir } = this.options;
    const convDir = conversationDir(config, target);
    await mkdir(convDir, { recursive: true, mode: 0o700 });
    await chmod(convDir, 0o700).catch(() => undefined);
    await ensureConversationConfig(convDir, config, target);
    const raw = existsSync(conversationConfigPath(convDir)) ? JSON.parse(await readFile(conversationConfigPath(convDir), "utf8")) as Record<string, unknown> : {};
    const merged = mergeConfig(config, raw);
    const errors = validateConfig(merged);
    if (errors.length) throw new Error(`会话 ${id} 配置无效：\n- ${errors.join("\n- ")}`);
    await ensureConversationEnv(convDir, merged, dir);
    const env = dotenv.parse(await readFile(conversationEnvPath(convDir), "utf8").catch(() => ""));
    const promptPath = await ensureConversationPrompt(convDir, config.promptsDir);
    return { id, dir: convDir, config: merged, env, promptPath };
  }
}
