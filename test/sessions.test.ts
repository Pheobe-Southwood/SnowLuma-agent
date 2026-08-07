import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SnowLumaWebSocketClient } from "@snowluma/sdk";
import type { AgentController } from "../src/agent.js";
import { defaultConfig } from "../src/config.js";
import { ConversationStore } from "../src/conversations.js";
import { SessionManager } from "../src/sessions.js";
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
