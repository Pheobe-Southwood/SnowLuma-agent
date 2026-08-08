import { copyFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import dotenv from "dotenv";
import type { Config, GroupConfig, McpServerConfig, ProviderName, ThinkingLevel } from "./types.js";

export const appDir = (dir?: string): string =>
  resolve(dir ?? process.env.SNOWLUMA_AGENT_DIR ?? join(homedir(), ".snowluma-agent"));

export const configPath = (dir: string): string => join(dir, "config.json");
export const toolsPath = (dir: string): string => join(dir, "tools.json");
export const envPath = (dir: string): string => join(dir, ".env");
export const whitelistDir = (dir: string): string => join(dir, "whitelist");
export const whitelistPrivatePath = (dir: string): string => join(whitelistDir(dir), "private.txt");
export const whitelistGroupsPath = (dir: string): string => join(whitelistDir(dir), "groups.txt");

export function defaultGroupDefaults(): GroupConfig {
  return { mode: "at", session: "shared" };
}

export function defaultTools(dir: string): Pick<Config, "skills" | "mcp" | "blockedToolNames"> {
  return {
    skills: { dir: join(dir, "skills"), enabled: [] },
    mcp: { servers: [] },
    blockedToolNames: ["bash", "terminal", "shell", "edit", "write", "read", "execute", "exec", "filesystem", "run"],
  };
}

export function defaultConfig(dir: string): Config {
  const tools = defaultTools(dir);
  return {
    snowluma: { wsUrl: "ws://127.0.0.1:3001/", accessToken: null },
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      thinkingLevel: "medium",
      baseUrl: null,
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
    whitelist: { private: [], groups: [] },
    groupDefaults: defaultGroupDefaults(),
    group: {},
    session: { inactivityTtlHours: 12, maxMessages: 60 },
    conversationsDir: join(dir, "conversations"),
    media: {
      downloadsDir: join(dir, "data/downloads"),
      autoDownload: ["image", "file", "record"],
      downloadFailedNotice: "媒体下载失败，请稍后重试",
      containerFallback: { enabled: false, volumeName: null, hostDir: null },
      placeholder: {
        image: "用户发来了一张图片，已保存到 %s",
        file: "用户发来了一个文件，已保存到 %s",
        record: "用户发来了一条语音，已保存到 %s",
        video: "用户发来了一段视频，已保存到 %s",
      },
    },
    promptsDir: join(dir, "prompts"),
    reply: {
      mode: "realtime",
      retryCount: 3,
      retryDelayMs: 500,
      queueNotice: "消息已进入等待队列，我会在处理完当前消息后回复你{position}",
      queueFullNotice: "消息队列已满，请稍后再试",
      stopNotice: "已停止",
      stopIdleNotice: "当前没有正在运行的对话",
      newSessionNotice: "已开启新会话",
      unknownCommandNotice: "未知指令，可用：/new /stop",
      commandNotAllowedNotice: "当前群聊未启用该指令",
      failedSendDir: join(dir, "data/failed-sends"),
    },
    commandPrefix: "/",
    queue: { maxLength: 10, notifyFirstOnly: false },
    skills: tools.skills,
    mcp: tools.mcp,
    blockedToolNames: tools.blockedToolNames,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function mergeConfig(base: Config, input: Record<string, unknown>): Config {
  const result = structuredClone(base) as Config;
  // Top-level: only known keys (ignore legacy storageDir/skillsDir). Nested: allow new keys (e.g. group fields).
  const apply = (target: Record<string, unknown>, source: Record<string, unknown>, allowNewKeys: boolean): void => {
    for (const [key, value] of Object.entries(source)) {
      if (isObject(value) && isObject(target[key])) apply(target[key] as Record<string, unknown>, value, true);
      else if (allowNewKeys || key in target) target[key] = value;
    }
  };
  apply(result as unknown as Record<string, unknown>, input, false);
  return result;
}

export function groupPolicy(config: Config): GroupConfig {
  return {
    mode: config.group?.mode ?? config.groupDefaults.mode ?? "at",
    session: config.group?.session ?? config.groupDefaults.session ?? "shared",
    commandAllowlist: config.group?.commandAllowlist ?? config.groupDefaults.commandAllowlist,
  };
}

export function parseIdList(text: string): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const id = Number(trimmed);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return !!error && typeof error === "object" && "code" in error;
}

async function readOptionalText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

async function loadWhitelist(dir: string): Promise<Config["whitelist"]> {
  const [privateText, groupsText] = await Promise.all([
    readOptionalText(whitelistPrivatePath(dir)),
    readOptionalText(whitelistGroupsPath(dir)),
  ]);
  return {
    private: parseIdList(privateText),
    groups: parseIdList(groupsText),
  };
}

function parseStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") result[key] = entry;
  }
  return result;
}

function parseMcpServer(value: unknown): McpServerConfig | undefined {
  if (!isObject(value)) return undefined;
  if (typeof value.id !== "string" || !value.id) return undefined;
  if (value.transport !== "stdio" && value.transport !== "http") return undefined;
  const server: McpServerConfig = { id: value.id, transport: value.transport };
  if (typeof value.command === "string") server.command = value.command;
  if (Array.isArray(value.args)) server.args = value.args.filter((item): item is string => typeof item === "string");
  if (typeof value.url === "string") server.url = value.url;
  const headers = parseStringRecord(value.headers);
  if (headers) server.headers = headers;
  if (Array.isArray(value.allow)) server.allow = value.allow.filter((item): item is string => typeof item === "string");
  return server;
}

function parseMcpServers(value: unknown): McpServerConfig[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const server = parseMcpServer(item);
    return server ? [server] : [];
  });
}

async function loadTools(dir: string): Promise<Pick<Config, "skills" | "mcp" | "blockedToolNames">> {
  const defaults = defaultTools(dir);
  const file = toolsPath(dir);
  if (!existsSync(file)) return defaults;
  let raw: Record<string, unknown>;
  try {
    const text = await readFile(file, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed)) throw new Error("根节点必须是对象");
    raw = parsed;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`tools.json 解析失败（${file}）：${reason}`);
  }
  const skillsRaw = isObject(raw.skills) ? raw.skills : {};
  const mcpRaw = isObject(raw.mcp) ? raw.mcp : {};
  return {
    skills: {
      dir: typeof skillsRaw.dir === "string" ? skillsRaw.dir : defaults.skills.dir,
      enabled: Array.isArray(skillsRaw.enabled) ? skillsRaw.enabled.filter((item): item is string => typeof item === "string") : defaults.skills.enabled,
    },
    mcp: {
      servers: Array.isArray(mcpRaw.servers) ? parseMcpServers(mcpRaw.servers) : defaults.mcp.servers,
    },
    blockedToolNames: Array.isArray(raw.blockedToolNames)
      ? raw.blockedToolNames.filter((item): item is string => typeof item === "string")
      : defaults.blockedToolNames,
  };
}

function mainConfigDefaults(dir: string): Record<string, unknown> {
  const full = defaultConfig(dir);
  return {
    snowluma: full.snowluma,
    llm: full.llm,
    groupDefaults: full.groupDefaults,
    session: full.session,
    conversationsDir: full.conversationsDir,
    media: full.media,
    promptsDir: full.promptsDir,
    reply: full.reply,
    commandPrefix: full.commandPrefix,
    queue: full.queue,
  };
}

function toolsFileDefaults(dir: string): Record<string, unknown> {
  return defaultTools(dir);
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];
  const providers: ProviderName[] = ["anthropic", "openai", "openrouter", "deepseek", "custom"];
  const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (!providers.includes(config.llm.provider)) errors.push("llm.provider 无效");
  if (!levels.includes(config.llm.thinkingLevel)) errors.push("llm.thinkingLevel 无效");
  if (!config.llm.model) errors.push("llm.model 不能为空");
  if (!config.snowluma.wsUrl.startsWith("ws://") && !config.snowluma.wsUrl.startsWith("wss://")) errors.push("snowluma.wsUrl 必须是 ws/wss URL");
  if (!Number.isFinite(config.session.inactivityTtlHours) || config.session.inactivityTtlHours <= 0) errors.push("session.inactivityTtlHours 必须为正数");
  if (!Number.isInteger(config.session.maxMessages) || config.session.maxMessages < 2) errors.push("session.maxMessages 必须至少为 2");
  if (!Number.isInteger(config.queue.maxLength) || config.queue.maxLength < 1) errors.push("queue.maxLength 必须为正整数");
  if (config.media.containerFallback.enabled && !config.media.containerFallback.volumeName && !config.media.containerFallback.hostDir) errors.push("启用 media.containerFallback 时必须配置 volumeName 或 hostDir");
  const mode = config.groupDefaults.mode ?? config.group?.mode;
  if (mode && mode !== "at" && mode !== "all") errors.push("groupDefaults.mode 必须是 at 或 all");
  const session = config.groupDefaults.session ?? config.group?.session;
  if (session && session !== "shared" && session !== "per-user") errors.push("groupDefaults.session 必须是 shared 或 per-user");
  return errors;
}

export async function loadConfig(dir = appDir()): Promise<Config> {
  const file = configPath(dir);
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const config = mergeConfig(defaultConfig(dir), raw);
  const tools = await loadTools(dir);
  config.skills = tools.skills;
  config.mcp = tools.mcp;
  config.blockedToolNames = tools.blockedToolNames;
  config.whitelist = await loadWhitelist(dir);
  if (process.env.SNOWLUMA_ACCESS_TOKEN) config.snowluma.accessToken = process.env.SNOWLUMA_ACCESS_TOKEN;
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`配置无效：\n- ${errors.join("\n- ")}`);
  dotenv.config({ path: envPath(dir), override: false, quiet: true });
  return config;
}

export function llmApiKey(config: Config, env?: Record<string, string>): string | undefined {
  if (env) {
    const value = env[config.llm.apiKeyEnv];
    if (value) return value;
  }
  return process.env[config.llm.apiKeyEnv];
}

export function llmConfigurationStatus(config: Config): { configured: boolean; message: string } {
  if (llmApiKey(config)) return { configured: true, message: `已找到 ${config.llm.apiKeyEnv}（不会显示密钥）` };
  return { configured: false, message: `尚未配置 ${config.llm.apiKeyEnv}；需要用户配置 LLM 后才能启动或测试模型连接` };
}

async function secureMkdir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
  await secureMkdir(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, { mode });
  await chmod(temp, mode);
  await rename(temp, path);
  await chmod(path, mode);
}

const WHITELIST_PRIVATE_TEMPLATE = `# 私聊白名单：每行一个 QQ 号
# 以 # 开头的行为注释
`;

const WHITELIST_GROUPS_TEMPLATE = `# 群聊白名单：每行一个群号
# 以 # 开头的行为注释
`;

export async function initWorkspace(dir = appDir(), systemd = false): Promise<void> {
  const config = defaultConfig(dir);
  await secureMkdir(dir);
  for (const path of [config.conversationsDir, config.media.downloadsDir, config.reply.failedSendDir, config.promptsDir, config.skills.dir, whitelistDir(dir)]) await secureMkdir(path);
  if (!existsSync(configPath(dir))) await atomicWrite(configPath(dir), `${JSON.stringify(mainConfigDefaults(dir), null, 2)}\n`, 0o600);
  if (!existsSync(toolsPath(dir))) await atomicWrite(toolsPath(dir), `${JSON.stringify(toolsFileDefaults(dir), null, 2)}\n`, 0o600);
  if (!existsSync(whitelistPrivatePath(dir))) await atomicWrite(whitelistPrivatePath(dir), WHITELIST_PRIVATE_TEMPLATE, 0o600);
  if (!existsSync(whitelistGroupsPath(dir))) await atomicWrite(whitelistGroupsPath(dir), WHITELIST_GROUPS_TEMPLATE, 0o600);
  const defaultPrompt = join(config.promptsDir, "SYSTEM_DEFAULT.md");
  const assetPrompt = new URL("../assets/SYSTEM_DEFAULT.md", import.meta.url);
  if (!existsSync(defaultPrompt)) await copyFile(assetPrompt, defaultPrompt);
  await chmod(defaultPrompt, 0o600);
  const example = "# Copy this file to .env and set the provider key named by config.json\nANTHROPIC_API_KEY=\nOPENAI_API_KEY=\nOPENROUTER_API_KEY=\n";
  if (!existsSync(join(dir, ".env.example"))) await atomicWrite(join(dir, ".env.example"), example, 0o644);
  if (systemd) {
    const service = await readFile(new URL("../assets/systemd/snowluma-agent.service", import.meta.url), "utf8");
    await atomicWrite(join(dir, "snowluma-agent.service"), service.replaceAll("%h/.npm-global/bin", join(process.env.NPM_CONFIG_PREFIX ?? "/usr/local", "bin")), 0o644);
  }
}
