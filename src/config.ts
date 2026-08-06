import { copyFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import dotenv from "dotenv";
import type { Config, ProviderName, ThinkingLevel } from "./types.js";

export const appDir = (dir?: string): string =>
  resolve(dir ?? process.env.SNOWLUMA_AGENT_DIR ?? join(homedir(), ".snowluma-agent"));

export const configPath = (dir: string): string => join(dir, "config.json");
export const envPath = (dir: string): string => join(dir, ".env");

export function defaultConfig(dir: string): Config {
  return {
    snowluma: { wsUrl: "ws://127.0.0.1:3001/", accessToken: null },
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      thinkingLevel: "medium",
      baseUrl: null,
      apiKeyEnv: "ANTHROPIC_API_KEY",
    },
    whitelist: { private: [], groups: {}, defaultGroupMode: "at", defaultGroupSession: "shared" },
    session: { inactivityTtlHours: 12, maxMessages: 60, storageDir: join(dir, "data/sessions") },
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
    skillsDir: join(dir, "skills"),
    mcp: { servers: [] },
    blockedToolNames: ["bash", "terminal", "shell", "edit", "write", "read", "execute", "exec", "filesystem", "run"],
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeConfig(base: Config, input: Record<string, unknown>): Config {
  const result = structuredClone(base) as Config;
  for (const [key, value] of Object.entries(input)) {
    if (isObject(value) && isObject((result as unknown as Record<string, unknown>)[key])) {
      Object.assign((result as unknown as Record<string, unknown>)[key] as object, value);
    } else if (key in result) {
      (result as unknown as Record<string, unknown>)[key] = value;
    }
  }
  return result;
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
  return errors;
}

export async function loadConfig(dir = appDir()): Promise<Config> {
  const file = configPath(dir);
  const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  const config = mergeConfig(defaultConfig(dir), raw);
  if (process.env.SNOWLUMA_ACCESS_TOKEN) config.snowluma.accessToken = process.env.SNOWLUMA_ACCESS_TOKEN;
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`配置无效：\n- ${errors.join("\n- ")}`);
  dotenv.config({ path: envPath(dir), override: false, quiet: true });
  return config;
}

export function llmApiKey(config: Config): string | undefined {
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

export async function initWorkspace(dir = appDir(), systemd = false): Promise<void> {
  const config = defaultConfig(dir);
  await secureMkdir(dir);
  for (const path of [config.session.storageDir, config.media.downloadsDir, config.reply.failedSendDir, config.promptsDir, config.skillsDir]) await secureMkdir(path);
  if (!existsSync(configPath(dir))) await atomicWrite(configPath(dir), `${JSON.stringify(config, null, 2)}\n`, 0o600);
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
