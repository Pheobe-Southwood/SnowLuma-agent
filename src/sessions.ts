import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SnowLumaWebSocketClient } from "@snowluma/sdk";
import { readConversationPrompt } from "./system_prompt.js";
import { sendText } from "./reply.js";
import type { AgentController } from "./agent.js";
import type { ConversationContext, ConversationStore } from "./conversations.js";
import { conversationDirFromKey } from "./conversations.js";
import {
  accumulateUsage,
  blankUsage,
  formatDuration,
  formatTokens,
  normalizeUsage,
  processStartedAt,
  type StatusSnapshot,
} from "./status.js";
import type { Config, InboundMessage, ReplyTarget, SessionEnvelope, SessionMessage, SessionTarget, SessionUsage } from "./types.js";

const schemaVersion = 1 as const;
export const sessionFileName = (key: string): string => Buffer.from(key).toString("base64url") + ".json";
export const sessionPath = (dir: string, key: string): string => join(dir, sessionFileName(key));

function validMessage(value: unknown): value is SessionMessage {
  return !!value && typeof value === "object" && ["user", "assistant", "toolResult"].includes((value as { role?: unknown }).role as string);
}

function pruneMessages(messages: SessionMessage[], maxMessages: number): SessionMessage[] {
  if (messages.length <= maxMessages) return messages;
  let start = 0;
  while (messages.length - start > maxMessages) {
    const role = messages[start]?.role;
    if (role === "user") {
      start += 1;
      while (start < messages.length && messages[start].role !== "user") start += 1;
    } else start += 1;
  }
  return messages.slice(start);
}

function blankEnvelope(key: string, now = Date.now()): SessionEnvelope {
  return { schemaVersion, key, updatedAt: now, createdAt: now, messages: [], usage: blankUsage() };
}

export async function loadSession(dir: string, key: string, ttlMs: number, now = Date.now()): Promise<SessionEnvelope> {
  const blank = blankEnvelope(key, now);
  try {
    const parsed = JSON.parse(await readFile(sessionPath(dir, key), "utf8")) as Partial<SessionEnvelope>;
    if (parsed.schemaVersion !== schemaVersion || parsed.key !== key || !Number.isFinite(parsed.updatedAt) || !Array.isArray(parsed.messages) || !parsed.messages.every(validMessage)) throw new Error("schema");
    // TTL 过期：清空记忆并开启新会话时钟，但保留上次真实活跃时间供 /status 展示
    if (now - parsed.updatedAt! > ttlMs) {
      return { ...blank, updatedAt: parsed.updatedAt! };
    }
    const createdAt = typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt) ? parsed.createdAt : parsed.updatedAt!;
    const usage = normalizeUsage(parsed.usage) ?? blankUsage();
    return { schemaVersion, key, updatedAt: parsed.updatedAt!, createdAt, messages: parsed.messages as SessionMessage[], usage };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return blank;
    const path = sessionPath(dir, key);
    await rename(path, `${path}.corrupt.${now}`).catch(() => undefined);
    return blank;
  }
}

export async function saveSession(dir: string, envelope: SessionEnvelope, maxMessages: number): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  const createdAt = envelope.createdAt ?? envelope.updatedAt;
  const usage = envelope.usage ?? blankUsage();
  const output: SessionEnvelope = {
    ...envelope,
    createdAt,
    usage,
    messages: pruneMessages(envelope.messages, maxMessages),
  };
  const path = sessionPath(dir, envelope.key);
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
}

export interface SessionManagerOptions {
  config: Config;
  store: ConversationStore;
  qq: SnowLumaWebSocketClient;
  createController: (target: ReplyTarget, sessionKey: string, messages: SessionMessage[], systemPrompt: string, conv: ConversationContext) => Promise<AgentController>;
}

function removeAbortedAssistantMessages(controller: AgentController): void {
  const messages = controller.messages();
  for (;;) {
    const last = messages.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "aborted") break;
    messages.pop();
  }
}

interface Worker {
  key: string;
  target: ReplyTarget;
  sessionTarget: SessionTarget;
  conv?: ConversationContext;
  queue: InboundMessage[];
  busy: boolean;
  pendingReset: boolean;
  updatedAt: number;
  sessionCreatedAt: number;
  usage: SessionUsage;
  processingStartedAt?: number;
  ready: Promise<AgentController>;
  controller?: AgentController;
  activePrompt?: Promise<void>;
  processing: boolean;
  current: boolean;
  stopRequested: boolean;
}

function chatTypeLabel(target: SessionTarget): string {
  return target.kind === "private" ? "私聊" : "群聊";
}

function sessionModeLabel(target: SessionTarget): string {
  if (target.kind === "private") return "—";
  return target.userId !== undefined ? "每人单独会话" : "共享会话";
}

export class SessionManager {
  private readonly workers = new Map<string, Worker>();
  constructor(private readonly options: SessionManagerOptions) {}

  private targetFor(inbound: InboundMessage): ReplyTarget {
    return inbound.target.kind === "private" ? { kind: "private", userId: inbound.target.userId } : { kind: "group", groupId: inbound.target.groupId };
  }

  private controllerRunning(worker: Worker): boolean {
    return worker.controller?.isRunning() ?? false;
  }

  private resetSessionState(worker: Worker, now = Date.now()): void {
    worker.sessionCreatedAt = now;
    worker.usage = blankUsage();
    worker.updatedAt = now;
  }

  private async reconcileExternalRun(worker: Worker, controller: AgentController): Promise<void> {
    try {
      await controller.waitForIdle();
    } catch (error) {
      console.error(`[session ${worker.key}] 等待 Agent idle 失败`, error);
    }
    if (!worker.processing || worker.controller !== controller) return;
    if (worker.stopRequested) removeAbortedAssistantMessages(controller);
    worker.activePrompt = undefined;
    worker.processingStartedAt = undefined;
    worker.current = false;
    worker.busy = false;
    worker.processing = false;
    worker.stopRequested = false;
    if (worker.queue.length) { worker.busy = true; void this.process(worker); }
  }

  private trackExternalRun(worker: Worker, controller: AgentController): void {
    worker.busy = true;
    worker.processing = true;
    if (!worker.processingStartedAt) worker.processingStartedAt = Date.now();
    void this.reconcileExternalRun(worker, controller);
  }

  private createWorker(inbound: InboundMessage): Worker {
    const { config } = this.options;
    const target = this.targetFor(inbound);
    const now = Date.now();
    const worker: Worker = {
      key: inbound.sessionKey,
      target,
      sessionTarget: inbound.target,
      queue: [],
      busy: true,
      pendingReset: false,
      updatedAt: now,
      sessionCreatedAt: now,
      usage: blankUsage(),
      ready: Promise.resolve(undefined as never),
      processing: false,
      current: false,
      stopRequested: false,
    };
    this.workers.set(inbound.sessionKey, worker);
    worker.ready = (async () => {
      const conv = await this.options.store.get(inbound.target);
      worker.conv = conv;
      const envelope = await loadSession(conv.dir, inbound.sessionKey, config.session.inactivityTtlHours * 3600_000);
      worker.sessionCreatedAt = envelope.createdAt ?? envelope.updatedAt;
      worker.usage = envelope.usage ?? blankUsage();
      worker.updatedAt = envelope.updatedAt;
      const prompt = await readConversationPrompt(conv.dir, config.promptsDir);
      return this.options.createController(target, inbound.sessionKey, envelope.messages, prompt, conv);
    })();
    worker.ready.then((controller) => {
      worker.controller = controller;
      if (worker.stopRequested) controller.abort();
    }).catch(() => undefined);
    return worker;
  }

  async submit(inbound: InboundMessage): Promise<{ queued: boolean; position: number }> {
    const { config } = this.options;
    let worker = this.workers.get(inbound.sessionKey);
    if (!worker) worker = this.createWorker(inbound);
    if (worker.queue.length >= config.queue.maxLength) return { queued: false, position: -1 };
    const position = worker.queue.length + (worker.current ? 2 : 1);
    worker.queue.push(inbound);
    worker.updatedAt = Date.now();
    if (!worker.processing) {
      if (worker.controller && this.controllerRunning(worker)) this.trackExternalRun(worker, worker.controller);
      else void this.process(worker);
    }
    return { queued: position > 1, position };
  }

  private async process(worker: Worker): Promise<void> {
    if (worker.processing || worker.queue.length === 0) return;
    worker.processing = true;
    const { config } = this.options;
    let controller: AgentController | undefined;
    try {
      controller = await worker.ready;
      if (worker.stopRequested) return;
      while (worker.queue.length && !worker.stopRequested) {
        const inbound = worker.queue.shift()!;
        worker.current = true;
        try {
          controller.setSystemPrompt(await readConversationPrompt(worker.conv!.dir, config.promptsDir));
          if (worker.stopRequested) break;
          const beforeCount = controller.messages().length;
          worker.processingStartedAt = Date.now();
          worker.activePrompt = controller.prompt(inbound.promptText);
          await worker.activePrompt;
          if (!worker.stopRequested) {
            const messages = controller.messages() as unknown as SessionMessage[];
            worker.usage = accumulateUsage(worker.usage, messages, beforeCount);
            worker.updatedAt = Date.now();
            const envelope: SessionEnvelope = {
              schemaVersion,
              key: worker.key,
              updatedAt: worker.updatedAt,
              createdAt: worker.sessionCreatedAt,
              messages,
              usage: worker.usage,
            };
            await saveSession(worker.conv!.dir, envelope, config.session.maxMessages);
          }
        } catch (error) {
          if (!worker.stopRequested) {
            await sendText(this.options.qq, worker.target, "处理消息时发生错误，请稍后重试。", config);
            console.error(`[session ${worker.key}]`, error);
          }
        } finally {
          if (worker.stopRequested) removeAbortedAssistantMessages(controller);
          worker.activePrompt = undefined;
          worker.processingStartedAt = undefined;
          worker.current = false;
        }
        if (worker.pendingReset) {
          controller.reset();
          worker.pendingReset = false;
          this.resetSessionState(worker);
          await saveSession(worker.conv!.dir, blankEnvelope(worker.key, worker.updatedAt), config.session.maxMessages);
        }
      }
    } catch (error) {
      worker.queue.length = 0;
      if (!worker.stopRequested) {
        await sendText(this.options.qq, worker.target, "会话初始化失败，请检查配置。", config);
        console.error(`[session ${worker.key}]`, error);
      }
    } finally {
      if (controller) {
        try { await controller.waitForIdle(); } catch (error) { console.error(`[session ${worker.key}] 等待 Agent idle 失败`, error); }
        if (worker.stopRequested) removeAbortedAssistantMessages(controller);
      }
      worker.busy = false;
      worker.processing = false;
      worker.activePrompt = undefined;
      worker.processingStartedAt = undefined;
      worker.stopRequested = false;
      if (worker.queue.length) { worker.busy = true; void this.process(worker); }
    }
  }

  async stop(key: string): Promise<boolean> {
    const worker = this.workers.get(key);
    const agentRunning = worker ? this.controllerRunning(worker) : false;
    const running = !!worker && (worker.busy || worker.processing || !!worker.activePrompt || agentRunning);
    console.log(`[session ${key}] /stop busy=${worker?.busy ?? false} processing=${worker?.processing ?? false} activePrompt=${!!worker?.activePrompt} agentStreaming=${agentRunning}`);
    if (!running) return false;
    worker.queue.length = 0;
    worker.stopRequested = true;
    worker.controller?.abort();
    if (worker.controller && !worker.processing) this.trackExternalRun(worker, worker.controller);
    else if (worker.controller) removeAbortedAssistantMessages(worker.controller);
    return true;
  }

  async newSession(key: string): Promise<"pending" | "done" | "missing"> {
    const worker = this.workers.get(key);
    const dir = conversationDirFromKey(this.options.config, key);
    const now = Date.now();
    if (!worker) {
      await saveSession(dir, blankEnvelope(key, now), this.options.config.session.maxMessages);
      return "done";
    }
    worker.queue.length = 0;
    if (this.isBusy(key)) { worker.pendingReset = true; return "pending"; }
    worker.controller?.reset();
    this.resetSessionState(worker, now);
    await saveSession(dir, blankEnvelope(key, now), this.options.config.session.maxMessages);
    return "done";
  }

  isBusy(key: string): boolean {
    const worker = this.workers.get(key);
    return !!worker && (worker.busy || worker.processing || !!worker.activePrompt || this.controllerRunning(worker));
  }

  async getStatus(inbound: InboundMessage): Promise<StatusSnapshot> {
    const now = Date.now();
    const worker = this.workers.get(inbound.sessionKey);
    let config = this.options.config;
    let messageCount = 0;
    let sessionCreatedAt = now;
    let updatedAt = 0;
    let usage = blankUsage();
    let queueLength = 0;
    let pendingReset = false;
    let busy = false;
    let processing = false;
    let processingStartedAt: number | undefined;

    if (worker) {
      if (worker.conv) config = worker.conv.config;
      busy = this.isBusy(inbound.sessionKey);
      processing = worker.current || !!worker.activePrompt || this.controllerRunning(worker);
      processingStartedAt = worker.processingStartedAt;
      queueLength = worker.queue.length;
      pendingReset = worker.pendingReset;
      sessionCreatedAt = worker.sessionCreatedAt;
      updatedAt = worker.updatedAt;
      usage = worker.usage;
      messageCount = worker.controller?.messages().length ?? 0;
      if (!worker.controller && worker.conv) {
        const envelope = await loadSession(worker.conv.dir, inbound.sessionKey, config.session.inactivityTtlHours * 3600_000, now);
        messageCount = envelope.messages.length;
        sessionCreatedAt = envelope.createdAt ?? envelope.updatedAt;
        updatedAt = envelope.updatedAt;
        usage = envelope.usage ?? blankUsage();
      }
    } else {
      try {
        const conv = await this.options.store.get(inbound.target);
        config = conv.config;
        const envelope = await loadSession(conv.dir, inbound.sessionKey, config.session.inactivityTtlHours * 3600_000, now);
        messageCount = envelope.messages.length;
        sessionCreatedAt = envelope.createdAt ?? envelope.updatedAt;
        updatedAt = envelope.updatedAt;
        usage = envelope.usage ?? blankUsage();
      } catch {
        // keep defaults
      }
    }

    const processingDuration = processing && processingStartedAt
      ? formatDuration(now - processingStartedAt)
      : "空闲";

    return {
      chatType: chatTypeLabel(inbound.target),
      sessionMode: sessionModeLabel(inbound.target),
      sessionKey: inbound.sessionKey,
      busy,
      processing,
      busyText: busy ? (processing ? "处理中" : "忙碌") : "空闲",
      processingDuration,
      sessionDuration: formatDuration(now - sessionCreatedAt),
      queueLength,
      queueMax: config.queue.maxLength,
      messageCount,
      pendingReset: pendingReset ? "是" : "否",
      model: `${config.llm.provider}/${config.llm.model}`,
      replyMode: config.reply.mode,
      sessionTokens: formatTokens(usage.input, usage.output, usage.total),
      lastTokens: formatTokens(usage.lastInput, usage.lastOutput, usage.lastTotal),
      lastActive: updatedAt ? formatDuration(now - updatedAt) : "—",
      uptime: formatDuration(now - processStartedAt),
    };
  }

  async close(): Promise<void> { for (const worker of this.workers.values()) await worker.controller?.close(); }
}
