import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnowLumaWebSocketClient } from "@snowluma/sdk";
import type { AgentController } from "../src/agent.js";
import { defaultConfig } from "../src/config.js";
import { ConversationStore } from "../src/conversations.js";
import { loadSession, SessionManager } from "../src/sessions.js";
import type { InboundMessage, OneBotMessageEvent } from "../src/types.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待会话状态超时");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function inbound(promptText: string): InboundMessage {
  const event: OneBotMessageEvent = {
    time: 1,
    self_id: 999,
    post_type: "message",
    message_type: "private",
    message_id: Math.floor(Math.random() * 100_000),
    user_id: 10001,
    message: promptText,
    raw_message: promptText,
  };
  return {
    event,
    segments: [{ type: "text", data: { text: promptText } }],
    sessionKey: "private:10001",
    promptText,
    target: { kind: "private", userId: 10001 },
  };
}

function fakeController(options: {
  calls: string[];
  promptStarted?: () => void;
  promptRelease?: Promise<void>;
  abortCalls: { count: number };
  messages?: unknown[];
  promptError?: Error;
  idlePromise?: Promise<void>;
}): AgentController {
  const messages = options.messages ?? [];
  const running = { value: false };
  let promptError = options.promptError;
  return {
    agent: undefined as never,
    mcp: undefined as never,
    prompt: async (text) => {
      options.calls.push(text);
      options.promptStarted?.();
      running.value = true;
      try {
        await options.promptRelease;
        if (promptError) {
          const error = promptError;
          promptError = undefined;
          throw error;
        }
      } finally {
        running.value = false;
      }
    },
    abort: () => { options.abortCalls.count += 1; },
    isRunning: () => running.value,
    waitForIdle: async () => { await options.idlePromise; },
    reset: () => undefined,
    setSystemPrompt: () => undefined,
    messages: () => messages as never,
    close: async () => undefined,
  };
}

async function testContext(): Promise<{ config: ReturnType<typeof defaultConfig>; qq: SnowLumaWebSocketClient; replies: string[]; store: ConversationStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "snowluma-stop-"));
  const config = defaultConfig(dir);
  config.conversationsDir = join(dir, "conversations");
  config.promptsDir = join(dir, "prompts");
  await mkdir(config.promptsDir, { recursive: true });
  await writeFile(join(config.promptsDir, "SYSTEM_DEFAULT.md"), "system prompt\n");
  const replies: string[] = [];
  const qq = { sendPrivateMessage: async (_userId: number, text: string) => { replies.push(text); } } as SnowLumaWebSocketClient;
  const store = new ConversationStore({ config, dir });
  return { config, qq, replies, store, dir };
}

describe("SessionManager /stop", () => {
  it("stops a session while its controller is still initializing", async () => {
    const { config, qq, store } = await testContext();
    const controllerRelease = deferred();
    const controllerStarted = deferred();
    const calls: string[] = [];
    const abortCalls = { count: 0 };
    const controller = fakeController({ calls, abortCalls });
    const manager = new SessionManager({
      config,
      store,
      qq,
      createController: async () => {
        controllerStarted.resolve();
        await controllerRelease.promise;
        return controller;
      },
    });

    const firstSubmit = manager.submit(inbound("first"));
    await controllerStarted.promise;
    expect(await manager.stop("private:10001")).toBe(true);
    controllerRelease.resolve();
    await firstSubmit;
    await waitUntil(() => !manager.isBusy("private:10001"));
    expect(calls).toEqual([]);
    expect(abortCalls.count).toBe(1);
    expect(await manager.stop("private:10001")).toBe(false);

    await manager.submit(inbound("after stop"));
    await waitUntil(() => calls.length === 1);
    expect(calls).toEqual(["after stop"]);
  });

  it("aborts the current prompt, clears queued messages, and accepts a later message", async () => {
    const { config, qq, replies, store } = await testContext();
    const promptStarted = deferred();
    const promptRelease = deferred();
    const calls: string[] = [];
    const abortCalls = { count: 0 };
    const controller = fakeController({
      calls,
      abortCalls,
      promptStarted: promptStarted.resolve,
      promptRelease: promptRelease.promise,
      promptError: new Error("aborted"),
      messages: [{ role: "assistant", stopReason: "aborted" }],
    });
    const manager = new SessionManager({
      config,
      store,
      qq,
      createController: async () => controller,
    });

    await manager.submit(inbound("current"));
    await promptStarted.promise;
    const queued = await manager.submit(inbound("queued"));
    expect(queued.queued).toBe(true);
    expect(await manager.stop("private:10001")).toBe(true);
    expect(abortCalls.count).toBe(1);
    promptRelease.resolve();
    await waitUntil(() => !manager.isBusy("private:10001"));
    expect(calls).toEqual(["current"]);
    expect(replies).toEqual([]);

    await manager.submit(inbound("after stop"));
    await waitUntil(() => calls.length === 2);
    expect(calls).toEqual(["current", "after stop"]);
  });

  it("uses the real Agent running state when worker bookkeeping says idle", async () => {
    const { config, qq, store } = await testContext();
    const promptStarted = deferred();
    const promptRelease = deferred();
    const calls: string[] = [];
    const abortCalls = { count: 0 };
    const controller = fakeController({ calls, abortCalls, promptStarted: promptStarted.resolve, promptRelease: promptRelease.promise, idlePromise: promptRelease.promise });
    const manager = new SessionManager({ config, store, qq, createController: async () => controller });

    await manager.submit(inbound("long MCP task"));
    await promptStarted.promise;
    const workers = (manager as unknown as { workers: Map<string, { busy: boolean; processing: boolean; activePrompt?: Promise<void> }> }).workers;
    const worker = workers.get("private:10001")!;
    worker.busy = false;
    worker.processing = false;
    worker.activePrompt = undefined;

    expect(manager.isBusy("private:10001")).toBe(true);
    expect(await manager.stop("private:10001")).toBe(true);
    expect(abortCalls.count).toBe(1);
    promptRelease.resolve();
    await waitUntil(() => !manager.isBusy("private:10001"));
    expect(calls).toEqual(["long MCP task"]);
  });
});

describe("SessionManager /status", () => {
  it("reports idle status and accumulates usage after a prompt", async () => {
    const { config, qq, store } = await testContext();
    const messages: Array<Record<string, unknown>> = [];
    const controller = fakeController({
      calls: [],
      abortCalls: { count: 0 },
      messages,
      promptStarted: () => {
        messages.push({ role: "user", content: "hi" });
        messages.push({ role: "assistant", usage: { input: 11, output: 4, totalTokens: 15 } });
      },
    });
    const manager = new SessionManager({ config, store, qq, createController: async () => controller });
    const msg = inbound("hello");
    const idle = await manager.getStatus(msg);
    expect(idle.busy).toBe(false);
    expect(idle.chatType).toBe("私聊");
    expect(idle.sessionMode).toBe("—");
    expect(idle.processingDuration).toBe("空闲");
    expect(idle.sessionTokens).toBe("0/0/0");

    await manager.submit(msg);
    await waitUntil(() => !manager.isBusy(msg.sessionKey));
    const after = await manager.getStatus(msg);
    expect(after.messageCount).toBe(2);
    expect(after.sessionTokens).toBe("11/4/15");
    expect(after.lastTokens).toBe("11/4/15");
    expect(after.model).toContain(config.llm.provider);

    const envelope = await loadSession(join(config.conversationsDir, "10001"), msg.sessionKey, 3600_000);
    expect(envelope.createdAt).toBeTypeOf("number");
    expect(envelope.usage?.total).toBe(15);
  });

  it("shows processing duration while busy and resets createdAt on /new", async () => {
    const { config, qq, store } = await testContext();
    const promptStarted = deferred();
    const promptRelease = deferred();
    const controller = fakeController({
      calls: [],
      abortCalls: { count: 0 },
      promptStarted: promptStarted.resolve,
      promptRelease: promptRelease.promise,
    });
    const manager = new SessionManager({ config, store, qq, createController: async () => controller });
    const msg = inbound("busy");
    await manager.submit(msg);
    await promptStarted.promise;
    const busy = await manager.getStatus(msg);
    expect(busy.busy).toBe(true);
    expect(busy.processing).toBe(true);
    expect(busy.busyText).toBe("处理中");
    expect(busy.processingDuration).not.toBe("空闲");

    promptRelease.resolve();
    await waitUntil(() => !manager.isBusy(msg.sessionKey));
    const beforeNew = await manager.getStatus(msg);
    await new Promise((r) => setTimeout(r, 20));
    expect(await manager.newSession(msg.sessionKey)).toBe("done");
    const afterNew = await manager.getStatus(msg);
    expect(afterNew.sessionTokens).toBe("0/0/0");
    expect(afterNew.messageCount).toBe(0);
    expect(afterNew.sessionDuration === "不到1秒" || afterNew.sessionDuration.endsWith("秒")).toBe(true);
    expect(beforeNew.sessionKey).toBe(afterNew.sessionKey);
  });
});
