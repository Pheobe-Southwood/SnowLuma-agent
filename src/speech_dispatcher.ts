import { constants, existsSync } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import dotenv from "dotenv";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AgentController } from "./agent.js";
import { createSilentAgentController } from "./agent.js";
import { envPath, groupPolicy, validateConfig } from "./config.js";
import type { ConversationContext } from "./conversations.js";
import { conversationEnvPath } from "./conversations.js";
import { isAtSelf } from "./filter.js";
import { readConversationPrompt } from "./system_prompt.js";
import { accumulateUsage, blankUsage } from "./status.js";
import type {
  Config,
  InboundMessage,
  SessionMessage,
  SessionUsage,
  SpeechDispatcherConfig,
  SpeechDispatcherReset,
  SpeechDispatcherToolsConfig,
} from "./types.js";

export const SPEECH_DISPATCHER_TOOL = "dispatch_to_character";
export const SPEECH_DISPATCHER_SELECT_TOOL = "dispatch_selected_to_character";

export const DEFAULT_SPEECH_DISPATCHER_PROMPT = `你是“发言调度 Agent”，负责角色扮演对话中的发言时机。你不直接扮演角色，也不回答聊天参与者。

你的职责：
- 结合角色 Agent 的人设、最近聊天内容和当前对话氛围，判断角色现在是否适合发言。
- 如果现在发言自然、有价值并符合角色表现，调用“触发角色回复”工具。
- 如果继续沉默更自然，不要调用任何工具。

原则：
- 不要因为每收到一条消息就机械地触发角色回复。
- 避免打断正在进行的话题、抢话、重复表达或制造无意义回复。
- 当有人明确等待角色回应、话题与角色高度相关、角色有自然切入点，或沉默会显得不合情境时，可以触发回复。
- 只负责判断是否触发；回复内容由角色 Agent 决定。
- 普通文本输出仅用于内部记录，不能代替工具调用。需要角色发言时必须调用工具。

工作方式：
- 每轮会收到一批新的聊天消息，每条消息前都有本次调度会话内唯一且稳定的短编号。
- “触发角色回复”会提交自上次成功派发后，截至工具调用瞬间的全部未派发消息。
- 如果启用了“选择消息触发角色回复”，可传入已经展示过的消息编号，只提交选中的消息；未选消息保留且不会重新展示或重新编号。
- 若不需要角色发言，结束本轮且不要调用工具。
`;

interface DispatchRecord {
  seq: number;
  time: number;
  userId: number;
  messageId: number;
  text: string;
}

interface DispatcherState {
  schemaVersion: 1;
  updatedAt: number;
  sessionCreatedAt: number;
  messages: SessionMessage[];
  usage: SessionUsage;
  nextSeq: number;
  lastPresentedSeq: number;
  pending: DispatchRecord[];
  messagesSinceReset: number;
  dispatchesSinceReset: number;
}

interface DispatcherContext {
  dir: string;
  config: SpeechDispatcherConfig;
  agentConfig: Config;
  tools: SpeechDispatcherToolsConfig;
}

interface RoleQueue {
  submit(inbound: InboundMessage): Promise<{ queued: boolean; position: number }>;
  isBusy(key: string): boolean;
  waitForIdle(key: string): Promise<void>;
}

interface Worker {
  key: string;
  conv: ConversationContext;
  ctx: DispatcherContext;
  state: DispatcherState;
  ready: Promise<AgentController>;
  controller?: AgentController;
  lastInbound: InboundMessage;
  processing: boolean;
  activeRound: boolean;
  pausedAfterError: boolean;
  closed: boolean;
  generation: number;
  resetAfterRound: boolean;
  activePresentedSeq?: number;
  lock: Promise<void>;
  logLock: Promise<void>;
  timer?: NodeJS.Timeout;
}

export interface SpeechDispatcherManagerOptions {
  appDir: string;
  role: RoleQueue;
  createController?: typeof createSilentAgentController;
}

const dispatcherConfigPath = (dir: string): string => join(dir, "config.json");
const dispatcherToolsPath = (dir: string): string => join(dir, "tools.json");
const dispatcherPromptPath = (dir: string): string => join(dir, "prompt.md");
const dispatcherSessionPath = (dir: string): string => join(dir, "session.json");
const dispatcherTranscriptPath = (dir: string): string => join(dir, "transcript.md");

export const globalSpeechDispatcherDir = (dir: string): string => join(dir, "speech-dispatcher");
export const conversationSpeechDispatcherDir = (convDir: string): string => join(convDir, "speech-dispatcher");

export function defaultSpeechDispatcherConfig(maxMessages = 60): SpeechDispatcherConfig {
  return {
    llm: {},
    session: { maxMessages },
    reset: { mode: "afterDispatches", count: 1 },
    templates: {
      inputMessage: "[时间：{time}] [QQ：{qq}] {message}",
      inputSuffix: "请根据规则判断是否该让角色 Agent 发消息了？",
      dispatchMessage: "[QQ：{qq}] [时间：{time}] {message}",
      dispatchSuffix: "以上为新的聊天记录",
    },
    log: { maxBytes: 10 * 1024 * 1024, backupCount: 3 },
  };
}

export function defaultSpeechDispatcherTools(): SpeechDispatcherToolsConfig {
  return { enabled: [SPEECH_DISPATCHER_TOOL] };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${label} 必须为正整数`);
  return Number(value);
}

function parseReset(value: unknown, fallback: SpeechDispatcherReset): SpeechDispatcherReset {
  if (!isObject(value)) return fallback;
  if (value.mode === "afterDispatches") return { mode: value.mode, count: positiveInteger(value.count, 1, "reset.count") };
  if (value.mode === "afterMessages") return { mode: value.mode, count: positiveInteger(value.count, 1, "reset.count") };
  if (value.mode === "interval") return { mode: value.mode, intervalMinutes: positiveInteger(value.intervalMinutes, 1, "reset.intervalMinutes") };
  throw new Error("reset.mode 必须是 afterDispatches、afterMessages 或 interval");
}

export function parseSpeechDispatcherConfig(value: unknown, maxMessages = 60): SpeechDispatcherConfig {
  if (!isObject(value)) throw new Error("发言调度 config.json 根节点必须是对象");
  const defaults = defaultSpeechDispatcherConfig(maxMessages);
  const session = isObject(value.session) ? value.session : {};
  const templates = isObject(value.templates) ? value.templates : {};
  const log = isObject(value.log) ? value.log : {};
  const llm = isObject(value.llm) ? value.llm : {};
  const allowedLlm = ["provider", "model", "thinkingLevel", "baseUrl", "apiKeyEnv"] as const;
  const llmOverride: Record<string, unknown> = {};
  for (const key of allowedLlm) if (key in llm) llmOverride[key] = llm[key];
  for (const key of ["provider", "model", "thinkingLevel", "apiKeyEnv"] as const) {
    if (key in llmOverride && typeof llmOverride[key] !== "string") throw new Error(`llm.${key} 必须是字符串`);
  }
  if ("baseUrl" in llmOverride && llmOverride.baseUrl !== null && typeof llmOverride.baseUrl !== "string") throw new Error("llm.baseUrl 必须是字符串或 null");
  const text = (entry: unknown, fallback: string, label: string): string => {
    if (entry === undefined) return fallback;
    if (typeof entry !== "string" || !entry.trim()) throw new Error(`${label} 必须是非空字符串`);
    return entry;
  };
  const sessionMaxMessages = positiveInteger(session.maxMessages, defaults.session.maxMessages, "session.maxMessages");
  if (sessionMaxMessages < 2) throw new Error("session.maxMessages 必须至少为 2");
  return {
    llm: llmOverride as SpeechDispatcherConfig["llm"],
    session: { maxMessages: sessionMaxMessages },
    reset: parseReset(value.reset, defaults.reset),
    templates: {
      inputMessage: text(templates.inputMessage, defaults.templates.inputMessage, "templates.inputMessage"),
      inputSuffix: text(templates.inputSuffix, defaults.templates.inputSuffix, "templates.inputSuffix"),
      dispatchMessage: text(templates.dispatchMessage, defaults.templates.dispatchMessage, "templates.dispatchMessage"),
      dispatchSuffix: text(templates.dispatchSuffix, defaults.templates.dispatchSuffix, "templates.dispatchSuffix"),
    },
    log: {
      maxBytes: positiveInteger(log.maxBytes, defaults.log.maxBytes, "log.maxBytes"),
      backupCount: positiveInteger(log.backupCount, defaults.log.backupCount, "log.backupCount"),
    },
  };
}

function parseTools(value: unknown): SpeechDispatcherToolsConfig {
  if (!isObject(value)) throw new Error("发言调度 tools.json 根节点必须是对象");
  if (value.enabled === undefined) return defaultSpeechDispatcherTools();
  if (!Array.isArray(value.enabled) || !value.enabled.every((item) => typeof item === "string")) throw new Error("tools.enabled 必须是字符串数组");
  const known = new Set([SPEECH_DISPATCHER_TOOL, SPEECH_DISPATCHER_SELECT_TOOL]);
  const unknown = value.enabled.filter((name) => !known.has(name));
  if (unknown.length) throw new Error(`未知的发言调度工具：${unknown.join(", ")}`);
  return { enabled: [...new Set(value.enabled)] };
}

async function secureMkdir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  if (existsSync(path)) return;
  const temp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temp, content, { mode: 0o600 });
  try {
    await copyFile(temp, path, constants.COPYFILE_EXCL);
    await chmod(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function copyIfMissing(source: string, target: string): Promise<void> {
  if (existsSync(target)) return;
  const temp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await copyFile(source, temp);
  await chmod(temp, 0o600);
  try {
    await copyFile(temp, target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

async function ensureStaticWorkspace(appDir: string, convDir: string): Promise<string> {
  const globalDir = globalSpeechDispatcherDir(appDir);
  await secureMkdir(globalDir);
  await Promise.all([
    writeIfMissing(dispatcherPromptPath(globalDir), DEFAULT_SPEECH_DISPATCHER_PROMPT),
    writeIfMissing(dispatcherConfigPath(globalDir), `${JSON.stringify(defaultSpeechDispatcherConfig(), null, 2)}\n`),
    writeIfMissing(dispatcherToolsPath(globalDir), `${JSON.stringify(defaultSpeechDispatcherTools(), null, 2)}\n`),
  ]);
  const targetDir = conversationSpeechDispatcherDir(convDir);
  await secureMkdir(targetDir);
  await Promise.all([
    copyIfMissing(dispatcherPromptPath(globalDir), dispatcherPromptPath(targetDir)),
    copyIfMissing(dispatcherConfigPath(globalDir), dispatcherConfigPath(targetDir)),
    copyIfMissing(dispatcherToolsPath(globalDir), dispatcherToolsPath(targetDir)),
  ]);
  return targetDir;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(temp, content, { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
}

function serializeEnv(env: Record<string, string>): string {
  return `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

async function readEnvOrEmpty(path: string): Promise<Record<string, string>> {
  try {
    return dotenv.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return {};
  }
}

async function ensureDispatcherEnv(appDir: string, conv: ConversationContext, key: string): Promise<void> {
  if (conv.env[key]) return;
  const global = await readEnvOrEmpty(envPath(appDir));
  const current = await readEnvOrEmpty(conversationEnvPath(conv.dir));
  if (!current[key] && global[key]) current[key] = global[key];
  else if (!(key in current)) current[key] = "";
  await atomicWrite(conversationEnvPath(conv.dir), serializeEnv(current));
  Object.assign(conv.env, current);
}

async function loadDispatcherContext(appDir: string, conv: ConversationContext): Promise<DispatcherContext> {
  const dir = await ensureStaticWorkspace(appDir, conv.dir);
  const config = parseSpeechDispatcherConfig(JSON.parse(await readFile(dispatcherConfigPath(dir), "utf8")));
  const tools = parseTools(JSON.parse(await readFile(dispatcherToolsPath(dir), "utf8")));
  const agentConfig = structuredClone(conv.config);
  agentConfig.llm = { ...agentConfig.llm, ...config.llm };
  const errors = validateConfig(agentConfig);
  if (errors.length) throw new Error(`发言调度 Agent 配置无效：\n- ${errors.join("\n- ")}`);
  await ensureDispatcherEnv(appDir, conv, agentConfig.llm.apiKeyEnv);
  return { dir, config, agentConfig, tools };
}

function initialState(now = Date.now()): DispatcherState {
  return {
    schemaVersion: 1,
    updatedAt: now,
    sessionCreatedAt: now,
    messages: [],
    usage: blankUsage(),
    nextSeq: 1,
    lastPresentedSeq: 0,
    pending: [],
    messagesSinceReset: 0,
    dispatchesSinceReset: 0,
  };
}

function validRecord(value: unknown): value is DispatchRecord {
  if (!isObject(value)) return false;
  return Number.isInteger(value.seq) && Number.isFinite(value.time) && Number.isInteger(value.userId)
    && Number.isInteger(value.messageId) && typeof value.text === "string";
}

async function loadState(dir: string): Promise<DispatcherState> {
  const path = dispatcherSessionPath(dir);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<DispatcherState>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.messages) || !Array.isArray(parsed.pending)
      || !parsed.pending.every(validRecord) || !Number.isInteger(parsed.nextSeq) || !Number.isInteger(parsed.lastPresentedSeq)) throw new Error("schema");
    return {
      ...initialState(),
      ...parsed,
      usage: { ...blankUsage(), ...(isObject(parsed.usage) ? parsed.usage : {}) } as SessionUsage,
      messagesSinceReset: Number.isInteger(parsed.messagesSinceReset) ? parsed.messagesSinceReset! : 0,
      dispatchesSinceReset: Number.isInteger(parsed.dispatchesSinceReset) ? parsed.dispatchesSinceReset! : 0,
    } as DispatcherState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState();
    await rename(path, `${path}.corrupt.${Date.now()}`).catch(() => undefined);
    return initialState();
  }
}

function pruneMessages(messages: SessionMessage[], maxMessages: number): SessionMessage[] {
  if (messages.length <= maxMessages) return messages;
  let start = messages.length - maxMessages;
  while (start < messages.length && messages[start]?.role !== "user") start += 1;
  if (start >= messages.length) start = messages.length - maxMessages;
  return messages.slice(start);
}

async function saveState(worker: Worker): Promise<void> {
  worker.state.updatedAt = Date.now();
  const output = { ...worker.state, messages: pruneMessages(worker.state.messages, worker.ctx.config.session.maxMessages) };
  worker.state.messages = output.messages;
  await atomicWrite(dispatcherSessionPath(worker.ctx.dir), `${JSON.stringify(output, null, 2)}\n`);
}

async function rotateLog(path: string, maxBytes: number, backupCount: number, incomingBytes: number): Promise<void> {
  const size = (await stat(path).catch(() => undefined))?.size ?? 0;
  if (size + incomingBytes <= maxBytes) return;
  await unlink(`${path}.${backupCount}`).catch(() => undefined);
  for (let index = backupCount - 1; index >= 1; index -= 1) {
    await rename(`${path}.${index}`, `${path}.${index + 1}`).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  await rename(path, `${path}.1`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function appendTranscript(worker: Worker, heading: string, body: string): Promise<void> {
  const previous = worker.logLock;
  let release!: () => void;
  worker.logLock = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  const path = dispatcherTranscriptPath(worker.ctx.dir);
  const entry = `\n## ${new Date().toISOString()} — ${heading}\n\n${body.trim() || "（空）"}\n`;
  try {
    await rotateLog(path, worker.ctx.config.log.maxBytes, worker.ctx.config.log.backupCount, Buffer.byteLength(entry));
    await appendFile(path, entry, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600).catch(() => undefined);
  } catch (error) {
    console.error(`[speech-dispatcher ${worker.key}] 写入日志失败`, error);
  } finally {
    release();
  }
}

function localTimestamp(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function renderRecord(template: string, record: DispatchRecord): string {
  return template
    .replaceAll("{time}", localTimestamp(record.time))
    .replaceAll("{qq}", String(record.userId))
    .replaceAll("{message}", record.text);
}

function renderBatch(records: DispatchRecord[], template: string, suffix: string): string {
  return [...records.map((record) => renderRecord(template, record)), suffix].join("\n");
}

function messageNumber(record: DispatchRecord): string {
  return record.seq.toString(36);
}

function renderDispatcherBatch(records: DispatchRecord[], template: string, suffix: string): string {
  return [...records.map((record) => `[编号：${messageNumber(record)}] ${renderRecord(template, record)}`), suffix].join("\n");
}

function textFromAgentMessage(message: AgentMessage): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("").trim();
}

function toolResult(text: string): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  return { content: [{ type: "text", text }], details: {} };
}

export function speechDispatcherSupported(inbound: InboundMessage, config: Config): boolean {
  if (!config.speechDispatcher.enabled || inbound.event.user_id === inbound.event.self_id) return false;
  if (inbound.target.kind === "private") return true;
  const policy = groupPolicy(config);
  return policy.mode === "all" && policy.session !== "per-user";
}

export function speechDispatcherEligible(inbound: InboundMessage, config: Config): boolean {
  return speechDispatcherSupported(inbound, config)
    && !(inbound.target.kind === "group" && isAtSelf(inbound.event, inbound.segments));
}

export class SpeechDispatcherManager {
  private readonly workers = new Map<string, Promise<Worker>>();
  private readonly createController: typeof createSilentAgentController;

  constructor(private readonly options: SpeechDispatcherManagerOptions) {
    this.createController = options.createController ?? createSilentAgentController;
  }

  private async withLock<T>(worker: Worker, operation: () => Promise<T>): Promise<T> {
    const previous = worker.lock;
    let release!: () => void;
    worker.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  private async systemPrompt(worker: Worker): Promise<string> {
    const [dispatcherPrompt, characterPrompt] = await Promise.all([
      readFile(dispatcherPromptPath(worker.ctx.dir), "utf8"),
      readConversationPrompt(worker.conv.dir, worker.conv.config.promptsDir),
    ]);
    return `${dispatcherPrompt.trim()}\n\n---\n以下是供你参考的角色 Agent 人设。该内容仅用于判断发言时机，不要直接扮演角色或回答：\n\n<character_prompt>\n${characterPrompt.trim()}\n</character_prompt>`;
  }

  private buildDispatchAllTool(worker: Worker): AgentTool {
    return {
      name: SPEECH_DISPATCHER_TOOL,
      label: "触发角色回复",
      description: "把自上次成功派发后、截至本次工具调用瞬间的全部未派发消息提交给角色 Agent。",
      parameters: Type.Object({}),
      execute: async () => this.dispatch(worker),
    };
  }

  private buildDispatchSelectedTool(worker: Worker): AgentTool {
    return {
      name: SPEECH_DISPATCHER_SELECT_TOOL,
      label: "选择消息触发角色回复",
      description: "按短编号选择已经展示且仍未派发的消息，并按原始顺序提交给角色 Agent。未选消息会保留且不重新展示。",
      parameters: Type.Object({
        messageIds: Type.Array(Type.String(), { minItems: 1, description: "要派发的消息短编号，例如 1、a、10。" }),
      }),
      execute: async (_toolCallId, parameters) => this.dispatchSelected(worker, isObject(parameters) ? parameters.messageIds : undefined),
    };
  }

  private async createWorker(inbound: InboundMessage, conv: ConversationContext): Promise<Worker> {
    const ctx = await loadDispatcherContext(this.options.appDir, conv);
    const state = await loadState(ctx.dir);
    const worker: Worker = {
      key: inbound.sessionKey,
      conv,
      ctx,
      state,
      ready: Promise.resolve(undefined as never),
      lastInbound: inbound,
      processing: false,
      activeRound: false,
      pausedAfterError: false,
      closed: false,
      generation: 0,
      resetAfterRound: false,
      lock: Promise.resolve(),
      logLock: Promise.resolve(),
    };
    const tools: AgentTool[] = [];
    if (ctx.tools.enabled.includes(SPEECH_DISPATCHER_TOOL)) tools.push(this.buildDispatchAllTool(worker));
    if (ctx.tools.enabled.includes(SPEECH_DISPATCHER_SELECT_TOOL)) tools.push(this.buildDispatchSelectedTool(worker));
    worker.ready = (async () => {
      const generation = worker.generation;
      const controller = await this.createController({
        config: ctx.agentConfig,
        env: conv.env,
        systemPrompt: await this.systemPrompt(worker),
        messages: state.messages,
        sessionKey: `speech-dispatcher:${inbound.sessionKey}`,
        tools,
      });
      if (generation !== worker.generation) controller.reset();
      worker.controller = controller;
      return controller;
    })();
    worker.ready.catch(() => undefined);
    this.scheduleInterval(worker);
    return worker;
  }

  private getWorker(inbound: InboundMessage, conv: ConversationContext): Promise<Worker> {
    let worker = this.workers.get(inbound.sessionKey);
    if (!worker) {
      worker = this.createWorker(inbound, conv);
      this.workers.set(inbound.sessionKey, worker);
      worker.catch(() => this.workers.delete(inbound.sessionKey));
    }
    return worker;
  }

  private scheduleInterval(worker: Worker): void {
    if (worker.timer) clearTimeout(worker.timer);
    if (worker.ctx.config.reset.mode !== "interval" || worker.closed) return;
    const intervalMs = worker.ctx.config.reset.intervalMinutes * 60_000;
    const remaining = Math.max(0, worker.state.sessionCreatedAt + intervalMs - Date.now());
    worker.timer = setTimeout(() => {
      if (worker.activeRound) worker.resetAfterRound = true;
      else void this.resetMemory(worker, "固定时间到期").catch((error) => console.error(`[speech-dispatcher ${worker.key}] 重置失败`, error));
    }, remaining);
    worker.timer.unref?.();
  }

  private shouldReset(worker: Worker): boolean {
    const reset = worker.ctx.config.reset;
    if (reset.mode === "afterDispatches") return worker.state.dispatchesSinceReset >= reset.count;
    if (reset.mode === "afterMessages") return worker.state.messagesSinceReset >= reset.count;
    return Date.now() - worker.state.sessionCreatedAt >= reset.intervalMinutes * 60_000;
  }

  private async resetMemory(worker: Worker, reason: string): Promise<void> {
    await this.withLock(worker, async () => {
      worker.controller?.reset();
      worker.state = initialState();
      worker.resetAfterRound = false;
      worker.activePresentedSeq = undefined;
      await saveState(worker);
    });
    await appendTranscript(worker, "自动重置", reason);
    this.scheduleInterval(worker);
  }

  private async dispatch(worker: Worker): Promise<ReturnType<typeof toolResult>> {
    const generation = worker.generation;
    let records: DispatchRecord[] = [];
    await this.withLock(worker, async () => { records = worker.state.pending.map((record) => ({ ...record })); });
    if (!records.length) return toolResult("没有未派发消息，本次未触发角色回复。");
    if (generation !== worker.generation) return toolResult("会话已重置，本次派发已取消。");
    const maxSeq = records.at(-1)!.seq;
    const promptText = renderBatch(records, worker.ctx.config.templates.dispatchMessage, worker.ctx.config.templates.dispatchSuffix);
    const base = worker.lastInbound;
    const result = await this.options.role.submit({
      ...base,
      segments: [{ type: "text", data: { text: promptText } }],
      promptText,
    });
    if (result.position === -1) {
      await appendTranscript(worker, "派发失败", `角色 Agent 队列已满；保留 ${records.length} 条消息。`);
      return toolResult("角色 Agent 队列已满，消息已保留，请稍后重试。");
    }
    let applied = false;
    await this.withLock(worker, async () => {
      if (generation !== worker.generation) return;
      worker.state.pending = worker.state.pending.filter((record) => record.seq > maxSeq);
      worker.state.dispatchesSinceReset += 1;
      await saveState(worker);
      applied = true;
    });
    if (!applied) return toolResult("会话已重置；角色队列已接收本批消息，但调度状态未继续更新。");
    await appendTranscript(worker, "触发角色回复", `${promptText}\n\n派发消息数：${records.length}`);
    if (this.shouldReset(worker)) worker.resetAfterRound = true;
    return toolResult(`已向角色 Agent 派发 ${records.length} 条消息。`);
  }

  private async dispatchSelected(worker: Worker, messageIds: unknown): Promise<ReturnType<typeof toolResult>> {
    if (!Array.isArray(messageIds) || !messageIds.length || !messageIds.every((id) => typeof id === "string" && id.length > 0)) {
      return toolResult("messageIds 必须是非空的消息编号数组，本次未派发任何消息。");
    }
    if (new Set(messageIds).size !== messageIds.length) return toolResult("消息编号不能重复，本次未派发任何消息。");

    const generation = worker.generation;
    let records: DispatchRecord[] = [];
    let invalidIds: string[] = [];
    await this.withLock(worker, async () => {
      const presentedThrough = Math.max(worker.state.lastPresentedSeq, worker.activePresentedSeq ?? 0);
      const pendingById = new Map(worker.state.pending.map((record) => [messageNumber(record), record]));
      invalidIds = messageIds.filter((id) => {
        const record = pendingById.get(id);
        return !record || record.seq > presentedThrough;
      });
      if (!invalidIds.length) {
        const selected = new Set(messageIds);
        records = worker.state.pending.filter((record) => selected.has(messageNumber(record))).map((record) => ({ ...record }));
      }
    });
    if (invalidIds.length) return toolResult(`以下消息编号无效、尚未展示或已派发：${invalidIds.join("、")}。本次未派发任何消息。`);
    if (generation !== worker.generation) return toolResult("会话已重置，本次派发已取消。");

    const selectedSeqs = new Set(records.map((record) => record.seq));
    const promptText = renderBatch(records, worker.ctx.config.templates.dispatchMessage, worker.ctx.config.templates.dispatchSuffix);
    const base = worker.lastInbound;
    const result = await this.options.role.submit({
      ...base,
      segments: [{ type: "text", data: { text: promptText } }],
      promptText,
    });
    if (result.position === -1) {
      await appendTranscript(worker, "选择派发失败", `角色 Agent 队列已满；保留所选的 ${records.length} 条消息。`);
      return toolResult("角色 Agent 队列已满，消息已保留，请稍后重试。");
    }
    let applied = false;
    await this.withLock(worker, async () => {
      if (generation !== worker.generation) return;
      worker.state.pending = worker.state.pending.filter((record) => !selectedSeqs.has(record.seq));
      worker.state.dispatchesSinceReset += 1;
      await saveState(worker);
      applied = true;
    });
    if (!applied) return toolResult("会话已重置；角色队列已接收本批消息，但调度状态未继续更新。");
    await appendTranscript(worker, "选择消息触发角色回复", `${promptText}\n\n派发消息数：${records.length}；编号：${messageIds.join("、")}`);
    if (this.shouldReset(worker)) worker.resetAfterRound = true;
    return toolResult(`已向角色 Agent 派发 ${records.length} 条选中消息。`);
  }

  async submit(inbound: InboundMessage, conv: ConversationContext, text: string): Promise<void> {
    const worker = await this.getWorker(inbound, conv);
    worker.lastInbound = inbound;
    const record = await this.withLock(worker, async () => {
      const next: DispatchRecord = {
        seq: worker.state.nextSeq,
        time: inbound.event.time,
        userId: inbound.event.user_id,
        messageId: inbound.event.message_id,
        text,
      };
      worker.state.nextSeq += 1;
      worker.state.pending.push(next);
      worker.state.messagesSinceReset += 1;
      if (worker.ctx.config.reset.mode === "afterMessages" && this.shouldReset(worker)) worker.resetAfterRound = true;
      await saveState(worker);
      return next;
    });
    await appendTranscript(worker, "收到消息", renderRecord(worker.ctx.config.templates.inputMessage, record));
    worker.pausedAfterError = false;
    if (!worker.processing) void this.process(worker);
  }

  private async process(worker: Worker): Promise<void> {
    if (worker.processing || worker.closed) return;
    worker.processing = true;
    try {
      let controller: AgentController;
      try {
        controller = await worker.ready;
      } catch (error) {
        worker.pausedAfterError = true;
        await appendTranscript(worker, "初始化错误", error instanceof Error ? error.stack ?? error.message : String(error));
        console.error(`[speech-dispatcher ${worker.key}] 初始化失败`, error);
        return;
      }
      while (!worker.closed) {
        await this.options.role.waitForIdle(worker.key);
        const generation = worker.generation;
        let records: DispatchRecord[] = [];
        await this.withLock(worker, async () => {
          records = worker.state.pending.filter((record) => record.seq > worker.state.lastPresentedSeq).map((record) => ({ ...record }));
        });
        if (!records.length || generation !== worker.generation) break;
        const watermark = records.at(-1)!.seq;
        const input = renderDispatcherBatch(records, worker.ctx.config.templates.inputMessage, worker.ctx.config.templates.inputSuffix);
        await appendTranscript(worker, "调度输入", input);
        const beforeCount = controller.messages().length;
        try {
          worker.activeRound = true;
          worker.activePresentedSeq = watermark;
          controller.setSystemPrompt(await this.systemPrompt(worker));
          await controller.prompt(input);
          if (generation !== worker.generation) continue;
          const allMessages = controller.messages() as unknown as SessionMessage[];
          const assistantOutput = (allMessages.slice(beforeCount) as unknown as AgentMessage[])
            .map(textFromAgentMessage).filter(Boolean).join("\n\n");
          await this.withLock(worker, async () => {
            worker.state.usage = accumulateUsage(worker.state.usage, allMessages, beforeCount);
            worker.state.messages = allMessages;
            worker.state.lastPresentedSeq = Math.max(worker.state.lastPresentedSeq, watermark);
            await saveState(worker);
          });
          if (assistantOutput) await appendTranscript(worker, "调度输出", assistantOutput);
        } catch (error) {
          if (generation === worker.generation) {
            await appendTranscript(worker, "调度错误", error instanceof Error ? error.stack ?? error.message : String(error));
            console.error(`[speech-dispatcher ${worker.key}]`, error);
          }
          if (generation === worker.generation) worker.pausedAfterError = true;
          break;
        } finally {
          worker.activeRound = false;
          worker.activePresentedSeq = undefined;
        }
        if (generation === worker.generation && (worker.resetAfterRound || this.shouldReset(worker))) await this.resetMemory(worker, `达到 ${worker.ctx.config.reset.mode} 重置条件`);
      }
    } finally {
      worker.processing = false;
      if (!worker.closed && !worker.pausedAfterError && worker.state.pending.some((record) => record.seq > worker.state.lastPresentedSeq)) void this.process(worker);
    }
  }

  async newSession(inbound: InboundMessage, conv: ConversationContext): Promise<void> {
    const worker = await this.getWorker(inbound, conv).catch((error) => {
      console.error(`[speech-dispatcher ${inbound.sessionKey}] /new 初始化失败`, error);
      return undefined;
    });
    if (!worker) return;
    worker.generation += 1;
    worker.controller?.abort();
    await this.withLock(worker, async () => {
      worker.controller?.reset();
      worker.state = initialState();
      worker.resetAfterRound = false;
      worker.activePresentedSeq = undefined;
      await saveState(worker);
    });
    await appendTranscript(worker, "/new", "已清空调度 Pi 会话、输入队列和全部未派发消息。" );
    this.scheduleInterval(worker);
  }

  async close(): Promise<void> {
    const workers = await Promise.allSettled(this.workers.values());
    for (const result of workers) {
      if (result.status !== "fulfilled") continue;
      result.value.closed = true;
      if (result.value.timer) clearTimeout(result.value.timer);
      result.value.controller?.abort();
      const controller = await result.value.ready.catch(() => undefined);
      await controller?.close();
    }
  }
}
