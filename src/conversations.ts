import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import dotenv from "dotenv";
import { envPath, groupPolicy, mergeConfig, validateConfig } from "./config.js";
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
    const policy = groupPolicy(config);
    out.group = {
      mode: policy.mode ?? "at",
      session: policy.session ?? "shared",
      ...(policy.commandAllowlist ? { commandAllowlist: policy.commandAllowlist } : {}),
    };
  }
  return out;
}

async function writeSecure(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => undefined);
}

async function globalEnvMap(appDir: string): Promise<Record<string, string>> {
  try { return dotenv.parse(await readFile(envPath(appDir), "utf8")); } catch { return {}; }
}

async function readConversationConfig(convDir: string, config: Config, target: SessionTarget): Promise<Record<string, unknown>> {
  const path = conversationConfigPath(convDir);
  const defaults = () => conversationDefaults(config, target);
  if (!existsSync(path)) {
    const raw = defaults();
    await writeSecure(path, `${JSON.stringify(raw, null, 2)}\n`);
    return raw;
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    await rename(path, `${path}.corrupt.${Date.now()}`).catch(() => undefined);
    const raw = defaults();
    await writeSecure(path, `${JSON.stringify(raw, null, 2)}\n`);
    return raw;
  }
}

function serializeEnv(env: Record<string, string>): string {
  return `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n")}\n`;
}

async function ensureConversationEnv(convDir: string, config: Config, appDir: string): Promise<void> {
  const path = conversationEnvPath(convDir);
  const key = config.llm.apiKeyEnv;
  const global = await globalEnvMap(appDir);
  let parsed: Record<string, string> = {};
  try { parsed = dotenv.parse(await readFile(path, "utf8")); } catch { /* missing ok */ }
  const current = parsed[key];
  if (current !== undefined && current !== "") return;
  const next = global[key] ?? "";
  if (current === next) return;
  parsed[key] = next;
  await writeSecure(path, serializeEnv(parsed));
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
    const raw = await readConversationConfig(convDir, config, target);
    const merged = mergeConfig(config, raw);
    const errors = validateConfig(merged);
    if (errors.length) throw new Error(`会话 ${id} 配置无效：\n- ${errors.join("\n- ")}`);
    await ensureConversationEnv(convDir, merged, dir);
    const env = dotenv.parse(await readFile(conversationEnvPath(convDir), "utf8").catch(() => ""));
    const promptPath = await ensureConversationPrompt(convDir, config.promptsDir);
    return { id, dir: convDir, config: merged, env, promptPath };
  }
}
