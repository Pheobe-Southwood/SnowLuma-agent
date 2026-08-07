import { access, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SnowLumaWebSocketClient } from "@snowluma/sdk";
import { readConversationPrompt } from "./system_prompt.js";
import { sendText, noticeText } from "./reply.js";
import type { AgentController } from "./agent.js";
import type { ConversationContext, ConversationStore } from "./conversations.js";
import { conversationDirFromKey } from "./conversations.js";
import type { Config, InboundMessage, ReplyTarget, SessionEnvelope, SessionMessage, SessionTarget } from "./types.js";

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

export async function loadSession(dir: string, key: string, ttlMs: number, now = Date.now()): Promise<SessionEnvelope> {
  const blank: SessionEnvelope = { schemaVersion, key, updatedAt: now, messages: [] };
  try {
    const parsed = JSON.parse(await readFile(sessionPath(dir, key), "utf8")) as Partial<SessionEnvelope>;
    if (parsed.schemaVersion !== schemaVersion || parsed.key !== key || !Number.isFinite(parsed.updatedAt) || !Array.isArray(parsed.messages) || !parsed.messages.every(validMessage)) throw new Error("schema");
    if (now - parsed.updatedAt! > ttlMs) return blank;
    return { schemaVersion, key, updatedAt: parsed.updatedAt!, messages: parsed.messages as SessionMessage[] };
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
  const output: SessionEnvelope = { ...envelope, messages: pruneMessages(envelope.messages, maxMessages) };
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
  ready: Promise<AgentController>;
  controller?: AgentController;
  activePrompt?: Promise<void>;
  processing: boolean;
  current: boolean;
  stopRequested: boolean;
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

  private async reconcileExternalRun(worker: Worker, controller: AgentController): Promise<void> {
    try {
      await controller.waitForIdle();
    } catch (error) {
      console.error(`[session ${worker.key}] 等待 Agent idle 失败`, error);
    }
    if (!worker.processing || worker.controller !== controller) return;
    if (worker.stopRequested) removeAbortedAssistantMessages(controller);
    worker.activePrompt = undefined;
    worker.current = false;
    worker.busy = false;
    worker.processing = false;
    worker.stopRequested = false;
    if (worker.queue.length) { worker.busy = true; void this.process(worker); }
  }

  private trackExternalRun(worker: Worker, controller: AgentController): void {
    worker.busy = true;
    worker.processing = true;
    void this.reconcileExternalRun(worker, controller);
  }

  private createWorker(inbound: InboundMessage): Worker {
    const { config } = this.options;
    const target = this.targetFor(inbound);
    const worker: Worker = {
      key: inbound.sessionKey,
      target,
      sessionTarget: inbound.target,
      queue: [],
      busy: true,
      pendingReset: false,
      updatedAt: Date.now(),
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
          worker.activePrompt = controller.prompt(inbound.promptText);
          await worker.activePrompt;
          if (!worker.stopRequested) {
            const envelope: SessionEnvelope = { schemaVersion, key: worker.key, updatedAt: worker.updatedAt, messages: controller.messages() as unknown as SessionMessage[] };
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
          worker.current = false;
        }
        if (worker.pendingReset) {
          controller.reset();
          worker.pendingReset = false;
          await saveSession(worker.conv!.dir, { schemaVersion, key: worker.key, updatedAt: Date.now(), messages: [] }, config.session.maxMessages);
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
    if (!worker) {
      await saveSession(dir, { schemaVersion, key, updatedAt: Date.now(), messages: [] }, this.options.config.session.maxMessages);
      return "done";
    }
    worker.queue.length = 0;
    if (this.isBusy(key)) { worker.pendingReset = true; return "pending"; }
    worker.controller?.reset();
    await saveSession(dir, { schemaVersion, key, updatedAt: Date.now(), messages: [] }, this.options.config.session.maxMessages);
    return "done";
  }

  isBusy(key: string): boolean {
    const worker = this.workers.get(key);
    return !!worker && (worker.busy || worker.processing || !!worker.activePrompt || this.controllerRunning(worker));
  }
  async close(): Promise<void> { for (const worker of this.workers.values()) await worker.controller?.close(); }
}
