import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentController } from "../src/agent.js";
import { defaultConfig } from "../src/config.js";
import { ConversationStore } from "../src/conversations.js";
import {
  defaultSpeechDispatcherConfig,
  defaultSpeechDispatcherTools,
  globalSpeechDispatcherDir,
  parseSpeechDispatcherConfig,
  SPEECH_DISPATCHER_SELECT_TOOL,
  SPEECH_DISPATCHER_TOOL,
  SpeechDispatcherManager,
  speechDispatcherEligible,
} from "../src/speech_dispatcher.js";
import type { Config, InboundMessage, OneBotMessageEvent, SessionMessage } from "../src/types.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForFileText(path: string, expected: string, timeoutMs = 2000): Promise<string> {
  const started = Date.now();
  for (;;) {
    const text = await readFile(path, "utf8").catch(() => "");
    if (text.includes(expected)) return text;
    if (Date.now() - started > timeoutMs) throw new Error(`waitForFileText timeout: ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForJson(path: string, predicate: (value: Record<string, unknown>) => boolean, timeoutMs = 2000): Promise<Record<string, unknown>> {
  const started = Date.now();
  for (;;) {
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (predicate(value)) return value;
    } catch { /* file may be between atomic versions */ }
    if (Date.now() - started > timeoutMs) throw new Error("waitForJson timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function inbound(text: string, messageId = 1, overrides: Partial<OneBotMessageEvent> = {}): InboundMessage {
  const event: OneBotMessageEvent = {
    time: 1_700_000_000 + messageId,
    self_id: 999,
    post_type: "message",
    message_type: "private",
    message_id: messageId,
    user_id: 10001,
    message: [{ type: "text", data: { text } }],
    raw_message: text,
    ...overrides,
  };
  return {
    event,
    segments: [{ type: "text", data: { text } }],
    sessionKey: event.message_type === "private" ? `private:${event.user_id}` : `group:${event.group_id}`,
    promptText: text,
    target: event.message_type === "private" ? { kind: "private", userId: event.user_id } : { kind: "group", groupId: event.group_id! },
  };
}

async function context(): Promise<{ dir: string; config: Config; conv: Awaited<ReturnType<ConversationStore["get"]>> }> {
  const dir = await mkdtemp(join(tmpdir(), "snowluma-dispatcher-"));
  const config = defaultConfig(dir);
  config.speechDispatcher.enabled = true;
  config.conversationsDir = join(dir, "conversations");
  config.promptsDir = join(dir, "prompts");
  await mkdir(config.promptsDir, { recursive: true });
  await writeFile(join(config.promptsDir, "SYSTEM_DEFAULT.md"), "你是一只安静的猫。\n");
  const conv = await new ConversationStore({ config, dir }).get({ kind: "private", userId: 10001 });
  return { dir, config, conv };
}

async function configureDispatcher(
  dir: string,
  config = defaultSpeechDispatcherConfig(),
  enabled: string[] = [],
): Promise<void> {
  const dispatcherDir = globalSpeechDispatcherDir(dir);
  await mkdir(dispatcherDir, { recursive: true });
  await writeFile(join(dispatcherDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(join(dispatcherDir, "tools.json"), `${JSON.stringify({ enabled }, null, 2)}\n`);
  await writeFile(join(dispatcherDir, "prompt.md"), "判断是否发言。\n");
}

async function executeTool(tool: AgentTool, parameters: Record<string, unknown>): Promise<string> {
  const result = await tool.execute("test-tool-call", parameters);
  return result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
}

function fakeControllerFactory(options: {
  prompts: string[];
  callTool?: boolean;
  promptStarted?: () => void;
  promptFinished?: () => void;
  promptGate?: Promise<void>;
  captureTools?: (tools: AgentTool[]) => void;
}) {
  return async (input: {
    systemPrompt: string;
    messages: SessionMessage[];
    tools: AgentTool[];
  }): Promise<AgentController> => {
    const messages = [...input.messages] as Array<Record<string, unknown>>;
    options.captureTools?.(input.tools);
    return {
      agent: undefined as never,
      mcp: { tools: [], close: async () => undefined },
      prompt: async (text) => {
        options.prompts.push(text);
        messages.push({ role: "user", content: text });
        options.promptStarted?.();
        await options.promptGate;
        if (options.callTool) await input.tools[0]?.execute("tool-1", {});
        messages.push({ role: "assistant", content: [{ type: "text", text: "内部判断" }] });
        options.promptFinished?.();
      },
      abort: () => undefined,
      isRunning: () => false,
      waitForIdle: async () => undefined,
      reset: () => { messages.length = 0; },
      setSystemPrompt: () => undefined,
      messages: () => messages as never,
      close: async () => undefined,
    };
  };
}

describe("speech dispatcher config and eligibility", () => {
  it("defaults to one dispatch per Pi session and validates reset modes", () => {
    expect(defaultSpeechDispatcherConfig().reset).toEqual({ mode: "afterDispatches", count: 1 });
    expect(defaultSpeechDispatcherTools()).toEqual({ enabled: ["dispatch_to_character"] });
    expect(parseSpeechDispatcherConfig({ reset: { mode: "afterMessages", count: 3 } }).reset).toEqual({ mode: "afterMessages", count: 3 });
    expect(parseSpeechDispatcherConfig({ reset: { mode: "interval", intervalMinutes: 5 } }).reset).toEqual({ mode: "interval", intervalMinutes: 5 });
    expect(() => parseSpeechDispatcherConfig({ reset: { mode: "interval", intervalMinutes: 0 } })).toThrow(/正整数/);
  });

  it("only enables private and shared all-message conversations", () => {
    const config = defaultConfig("/tmp/dispatcher-eligibility");
    config.speechDispatcher.enabled = true;
    expect(speechDispatcherEligible(inbound("private"), config)).toBe(true);
    const group = inbound("group", 2, { message_type: "group", group_id: 123 });
    config.groupDefaults = { mode: "all", session: "shared" };
    expect(speechDispatcherEligible(group, config)).toBe(true);
    group.segments = [{ type: "at", data: { qq: 999 } }, { type: "text", data: { text: "@消息" } }];
    group.event.message = group.segments;
    expect(speechDispatcherEligible(group, config)).toBe(false);
    group.segments = [{ type: "text", data: { text: "group" } }];
    group.event.message = group.segments;
    config.groupDefaults.session = "per-user";
    expect(speechDispatcherEligible(group, config)).toBe(false);
    config.groupDefaults = { mode: "at", session: "shared" };
    expect(speechDispatcherEligible(group, config)).toBe(false);
    config.speechDispatcher.enabled = false;
    expect(speechDispatcherEligible(inbound("private"), config)).toBe(false);
  });
});

describe("SpeechDispatcherManager", () => {
  it("lazily creates files, dispatches through the native tool, and keeps output off the role prompt", async () => {
    const { dir, conv } = await context();
    const prompts: string[] = [];
    const finished = deferred();
    const rolePrompts: string[] = [];
    const role = {
      submit: async (message: InboundMessage) => { rolePrompts.push(message.promptText); return { queued: false, position: 1 }; },
      isBusy: () => false,
      waitForIdle: async () => undefined,
    };
    const manager = new SpeechDispatcherManager({
      appDir: dir,
      role,
      createController: fakeControllerFactory({ prompts, callTool: true, promptFinished: finished.resolve }) as never,
    });
    await manager.submit(inbound("你好", 1), conv, "你好");
    await waitUntil(() => rolePrompts.length === 1);
    await finished.promise;
    expect(prompts[0]).toContain("请根据规则判断是否该让角色 Agent 发消息了？");
    expect(prompts[0]).toContain("[编号：1] [时间：");
    expect(rolePrompts[0]).toContain("[QQ：10001]");
    expect(rolePrompts[0]).toContain("以上为新的聊天记录");
    expect(rolePrompts[0]).not.toContain("内部判断");
    expect(rolePrompts[0]).not.toContain("[编号：");
    expect(existsSync(join(globalSpeechDispatcherDir(dir), "prompt.md"))).toBe(true);
    expect(existsSync(join(conv.dir, "speech-dispatcher", "config.json"))).toBe(true);
    expect(await waitForFileText(join(conv.dir, "speech-dispatcher", "transcript.md"), "内部判断")).toContain("内部判断");
    const state = await waitForJson(join(conv.dir, "speech-dispatcher", "session.json"), (value) => value.nextSeq === 1 && value.lastPresentedSeq === 0 && value.messagesSinceReset === 0);
    expect(state.pending).toEqual([]);
    expect(state.messages).toEqual([]);
    await manager.close();
  });

  it("coalesces messages while the role is busy", async () => {
    const { dir, conv } = await context();
    const gate = deferred();
    const prompts: string[] = [];
    let busy = true;
    const role = {
      submit: async () => ({ queued: false, position: 1 }),
      isBusy: () => busy,
      waitForIdle: async () => { if (busy) await gate.promise; },
    };
    const manager = new SpeechDispatcherManager({ appDir: dir, role, createController: fakeControllerFactory({ prompts }) as never });
    await manager.submit(inbound("第一条", 1), conv, "第一条");
    await manager.submit(inbound("第二条", 2), conv, "第二条");
    expect(prompts).toEqual([]);
    busy = false;
    gate.resolve();
    await waitUntil(() => prompts.length === 1);
    expect(prompts[0]).toContain("第一条");
    expect(prompts[0]).toContain("第二条");
    await manager.close();
  });

  it("injects stable Base36 numbers before the configured input template", async () => {
    const { dir, conv } = await context();
    const config = defaultSpeechDispatcherConfig();
    config.templates.inputMessage = "<{message}>";
    await configureDispatcher(dir, config);
    const gate = deferred();
    const prompts: string[] = [];
    let busy = true;
    const role = {
      submit: async () => ({ queued: false, position: 1 }),
      isBusy: () => busy,
      waitForIdle: async () => { if (busy) await gate.promise; },
    };
    const manager = new SpeechDispatcherManager({ appDir: dir, role, createController: fakeControllerFactory({ prompts }) as never });
    for (let index = 1; index <= 36; index += 1) await manager.submit(inbound(`消息${index}`, index), conv, `消息${index}`);
    busy = false;
    gate.resolve();
    await waitUntil(() => prompts.length === 1);
    expect(prompts[0]).toContain("[编号：1] <消息1>");
    expect(prompts[0]).toContain("[编号：z] <消息35>");
    expect(prompts[0]).toContain("[编号：10] <消息36>");
    await manager.close();
  });

  it("selectively dispatches presented messages in original order and keeps unselected numbers", async () => {
    const { dir, conv } = await context();
    const config = defaultSpeechDispatcherConfig();
    config.reset = { mode: "afterDispatches", count: 10 };
    await configureDispatcher(dir, config, [SPEECH_DISPATCHER_SELECT_TOOL]);
    const gate = deferred();
    const prompts: string[] = [];
    const tools: AgentTool[] = [];
    const rolePrompts: string[] = [];
    let busy = true;
    const role = {
      submit: async (message: InboundMessage) => { rolePrompts.push(message.promptText); return { queued: false, position: 1 }; },
      isBusy: () => busy,
      waitForIdle: async () => { if (busy) await gate.promise; },
    };
    const manager = new SpeechDispatcherManager({
      appDir: dir,
      role,
      createController: fakeControllerFactory({ prompts, captureTools: (captured) => tools.push(...captured) }) as never,
    });
    await manager.submit(inbound("第一条", 1), conv, "第一条");
    await manager.submit(inbound("第二条", 2), conv, "第二条");
    await manager.submit(inbound("第三条", 3), conv, "第三条");
    busy = false;
    gate.resolve();
    await waitForJson(join(conv.dir, "speech-dispatcher", "session.json"), (value) => value.lastPresentedSeq === 3);
    expect(tools.map((tool) => tool.name)).toEqual([SPEECH_DISPATCHER_SELECT_TOOL]);

    expect(await executeTool(tools[0]!, { messageIds: ["3", "1"] })).toContain("派发 2 条");
    expect(rolePrompts[0]!.indexOf("第一条")).toBeLessThan(rolePrompts[0]!.indexOf("第三条"));
    expect(rolePrompts[0]).not.toContain("第二条");
    expect(rolePrompts[0]).not.toContain("[编号：");
    let state = await waitForJson(join(conv.dir, "speech-dispatcher", "session.json"), (value) => Array.isArray(value.pending) && value.pending.length === 1);
    expect((state.pending as Array<{ seq: number }>)[0]?.seq).toBe(2);
    expect(await executeTool(tools[0]!, { messageIds: ["1"] })).toContain("无效");
    expect(rolePrompts).toHaveLength(1);

    await manager.submit(inbound("第四条", 4), conv, "第四条");
    await waitUntil(() => prompts.length === 2);
    expect(prompts[1]).toContain("[编号：4]");
    expect(prompts[1]).not.toContain("第二条");
    expect(await executeTool(tools[0]!, { messageIds: ["2"] })).toContain("派发 1 条");
    expect(rolePrompts[1]).toContain("第二条");
    expect(rolePrompts[1]).not.toContain("第四条");
    state = await waitForJson(join(conv.dir, "speech-dispatcher", "session.json"), (value) => Array.isArray(value.pending) && value.pending.length === 1);
    expect((state.pending as Array<{ seq: number }>)[0]?.seq).toBe(4);
    await manager.close();
  });

  it("registers and runs both dispatch tools when enabled together", async () => {
    const { dir, conv } = await context();
    const config = defaultSpeechDispatcherConfig();
    config.reset = { mode: "afterDispatches", count: 10 };
    await configureDispatcher(dir, config, [SPEECH_DISPATCHER_TOOL, SPEECH_DISPATCHER_SELECT_TOOL]);
    const gate = deferred();
    const prompts: string[] = [];
    const tools: AgentTool[] = [];
    const rolePrompts: string[] = [];
    let busy = true;
    const role = {
      submit: async (message: InboundMessage) => { rolePrompts.push(message.promptText); return { queued: false, position: 1 }; },
      isBusy: () => busy,
      waitForIdle: async () => { if (busy) await gate.promise; },
    };
    const manager = new SpeechDispatcherManager({
      appDir: dir,
      role,
      createController: fakeControllerFactory({ prompts, captureTools: (captured) => tools.push(...captured) }) as never,
    });
    await manager.submit(inbound("第一条", 1), conv, "第一条");
    await manager.submit(inbound("第二条", 2), conv, "第二条");
    busy = false;
    gate.resolve();
    await waitForJson(join(conv.dir, "speech-dispatcher", "session.json"), (value) => value.lastPresentedSeq === 2);
    expect(tools.map((tool) => tool.name)).toEqual([SPEECH_DISPATCHER_TOOL, SPEECH_DISPATCHER_SELECT_TOOL]);

    expect(await executeTool(tools[1]!, { messageIds: ["1"] })).toContain("派发 1 条选中消息");
    expect(rolePrompts[0]).toContain("第一条");
    expect(rolePrompts[0]).not.toContain("第二条");
    expect(await executeTool(tools[0]!, {})).toContain("派发 1 条");
    expect(rolePrompts[1]).toContain("第二条");
    expect(rolePrompts[1]).not.toContain("第一条");
    await manager.close();
  });

  it("rejects invalid, duplicate, and not-yet-presented selections atomically", async () => {
    const { dir, conv } = await context();
    const config = defaultSpeechDispatcherConfig();
    config.reset = { mode: "afterDispatches", count: 10 };
    await configureDispatcher(dir, config, [SPEECH_DISPATCHER_SELECT_TOOL]);
    const started = deferred();
    const reasoning = deferred();
    const prompts: string[] = [];
    const tools: AgentTool[] = [];
    const rolePrompts: string[] = [];
    const role = {
      submit: async (message: InboundMessage) => { rolePrompts.push(message.promptText); return { queued: false, position: -1 }; },
      isBusy: () => false,
      waitForIdle: async () => undefined,
    };
    const manager = new SpeechDispatcherManager({
      appDir: dir,
      role,
      createController: fakeControllerFactory({
        prompts,
        promptStarted: started.resolve,
        promptGate: reasoning.promise,
        captureTools: (captured) => tools.push(...captured),
      }) as never,
    });
    await manager.submit(inbound("已展示", 1), conv, "已展示");
    await started.promise;
    await manager.submit(inbound("推理期间到达", 2), conv, "推理期间到达");
    expect(await executeTool(tools[0]!, { messageIds: [] })).toContain("非空");
    expect(await executeTool(tools[0]!, { messageIds: ["1", "1"] })).toContain("不能重复");
    expect(await executeTool(tools[0]!, { messageIds: ["1", "missing"] })).toContain("无效");
    expect(await executeTool(tools[0]!, { messageIds: ["2"] })).toContain("尚未展示");
    expect(rolePrompts).toEqual([]);

    reasoning.resolve();
    await waitForJson(join(conv.dir, "speech-dispatcher", "session.json"), (value) => value.lastPresentedSeq === 2);
    expect(await executeTool(tools[0]!, { messageIds: ["1"] })).toContain("队列已满");
    const state = await waitForJson(join(conv.dir, "speech-dispatcher", "session.json"), (value) => Array.isArray(value.pending) && value.pending.length === 2);
    expect((state.pending as unknown[])).toHaveLength(2);
    await manager.close();
  });

  it("includes messages that arrive during reasoning in the tool-time snapshot", async () => {
    const { dir, conv } = await context();
    const started = deferred();
    const reasoning = deferred();
    const prompts: string[] = [];
    const rolePrompts: string[] = [];
    const role = {
      submit: async (message: InboundMessage) => { rolePrompts.push(message.promptText); return { queued: false, position: 1 }; },
      isBusy: () => false,
      waitForIdle: async () => undefined,
    };
    const manager = new SpeechDispatcherManager({
      appDir: dir,
      role,
      createController: fakeControllerFactory({ prompts, callTool: true, promptStarted: started.resolve, promptGate: reasoning.promise }) as never,
    });
    await manager.submit(inbound("模型看到了", 1), conv, "模型看到了");
    await started.promise;
    await manager.submit(inbound("模型还没看到", 2), conv, "模型还没看到");
    reasoning.resolve();
    await waitUntil(() => rolePrompts.length === 1);
    expect(rolePrompts[0]).toContain("模型看到了");
    expect(rolePrompts[0]).toContain("模型还没看到");
    await manager.close();
  });

  it("clears queued and pending records on /new and restarts numbering", async () => {
    const { dir, conv } = await context();
    const gate = deferred();
    const prompts: string[] = [];
    let busy = true;
    const role = {
      submit: async () => ({ queued: false, position: 1 }),
      isBusy: () => busy,
      waitForIdle: async () => { if (busy) await gate.promise; },
    };
    const manager = new SpeechDispatcherManager({ appDir: dir, role, createController: fakeControllerFactory({ prompts }) as never });
    await manager.submit(inbound("旧消息", 1), conv, "旧消息");
    await waitForJson(join(conv.dir, "speech-dispatcher", "session.json"), (value) => Array.isArray(value.pending) && value.pending.length === 1);
    await manager.newSession(inbound("/new", 2), conv);
    const state = JSON.parse(await readFile(join(conv.dir, "speech-dispatcher", "session.json"), "utf8"));
    expect(state.pending).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.nextSeq).toBe(1);
    busy = false;
    gate.resolve();
    await manager.submit(inbound("新消息", 3), conv, "新消息");
    await waitUntil(() => prompts.length === 1);
    expect(prompts[0]).toContain("[编号：1]");
    expect(prompts[0]).toContain("新消息");
    expect(prompts[0]).not.toContain("旧消息");
    await manager.close();
  });

  it("clears a persisted dispatcher session on /new after process restart", async () => {
    const { dir, conv } = await context();
    const role = {
      submit: async () => ({ queued: false, position: 1 }),
      isBusy: () => false,
      waitForIdle: async () => undefined,
    };
    const firstPrompts: string[] = [];
    const first = new SpeechDispatcherManager({ appDir: dir, role, createController: fakeControllerFactory({ prompts: firstPrompts }) as never });
    await first.submit(inbound("重启前未派发", 1), conv, "重启前未派发");
    await waitForJson(join(conv.dir, "speech-dispatcher", "session.json"), (value) => value.lastPresentedSeq === 1);
    const before = JSON.parse(await readFile(join(conv.dir, "speech-dispatcher", "session.json"), "utf8"));
    expect(before.pending).toHaveLength(1);
    await first.close();

    const secondPrompts: string[] = [];
    const second = new SpeechDispatcherManager({ appDir: dir, role, createController: fakeControllerFactory({ prompts: secondPrompts }) as never });
    await second.newSession(inbound("/new", 2), conv);
    const state = JSON.parse(await readFile(join(conv.dir, "speech-dispatcher", "session.json"), "utf8"));
    expect(state.pending).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.nextSeq).toBe(1);
    await second.submit(inbound("新消息", 3), conv, "新消息");
    await waitUntil(() => secondPrompts.length === 1);
    expect(secondPrompts[0]).toContain("[编号：1]");
    await second.close();
  });

  it("persists incoming messages when controller initialization fails", async () => {
    const { dir, conv } = await context();
    const role = {
      submit: async () => ({ queued: false, position: 1 }),
      isBusy: () => false,
      waitForIdle: async () => undefined,
    };
    const manager = new SpeechDispatcherManager({
      appDir: dir,
      role,
      createController: (async () => { throw new Error("missing model"); }) as never,
    });
    await manager.submit(inbound("必须保留", 1), conv, "必须保留");
    await waitForFileText(join(conv.dir, "speech-dispatcher", "transcript.md"), "初始化错误");
    const state = JSON.parse(await readFile(join(conv.dir, "speech-dispatcher", "session.json"), "utf8"));
    expect(state.pending).toHaveLength(1);
    expect(state.pending[0].text).toBe("必须保留");
    await manager.close();
  });

  it("clears pending messages and restarts numbering after an automatic reset", async () => {
    const { dir, conv } = await context();
    const globalDir = globalSpeechDispatcherDir(dir);
    await mkdir(globalDir, { recursive: true });
    const config = defaultSpeechDispatcherConfig();
    config.reset = { mode: "afterMessages", count: 1 };
    await writeFile(join(globalDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(join(globalDir, "tools.json"), `${JSON.stringify({ enabled: [] }, null, 2)}\n`);
    await writeFile(join(globalDir, "prompt.md"), "判断是否发言。\n");
    const prompts: string[] = [];
    const role = {
      submit: async () => ({ queued: false, position: 1 }),
      isBusy: () => false,
      waitForIdle: async () => undefined,
    };
    const manager = new SpeechDispatcherManager({ appDir: dir, role, createController: fakeControllerFactory({ prompts }) as never });
    await manager.submit(inbound("仍未派发", 1), conv, "仍未派发");
    await waitUntil(() => prompts.length === 1);
    expect(prompts[0]).toContain("仍未派发");
    const state = await waitForJson(join(conv.dir, "speech-dispatcher", "session.json"), (value) => value.nextSeq === 1 && value.lastPresentedSeq === 0 && value.messagesSinceReset === 0);
    expect(state.pending).toEqual([]);
    expect(state.messagesSinceReset).toBe(0);
    await manager.submit(inbound("重置后的第一条", 2), conv, "重置后的第一条");
    await waitUntil(() => prompts.length === 2);
    expect(prompts[1]).toContain("[编号：1]");
    await manager.close();
  });

  it("rotates the human-readable transcript by configured size", async () => {
    const { dir, conv } = await context();
    const globalDir = globalSpeechDispatcherDir(dir);
    await mkdir(globalDir, { recursive: true });
    const config = defaultSpeechDispatcherConfig();
    config.log = { maxBytes: 1, backupCount: 2 };
    await writeFile(join(globalDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(join(globalDir, "tools.json"), `${JSON.stringify(defaultSpeechDispatcherTools(), null, 2)}\n`);
    await writeFile(join(globalDir, "prompt.md"), "判断是否发言。\n");
    const role = {
      submit: async () => ({ queued: false, position: 1 }),
      isBusy: () => false,
      waitForIdle: async () => undefined,
    };
    const manager = new SpeechDispatcherManager({ appDir: dir, role, createController: fakeControllerFactory({ prompts: [] }) as never });
    await manager.submit(inbound("触发日志轮转", 1), conv, "触发日志轮转");
    await waitUntil(() => existsSync(join(conv.dir, "speech-dispatcher", "transcript.md.1")));
    expect(existsSync(join(conv.dir, "speech-dispatcher", "transcript.md"))).toBe(true);
    await manager.close();
  });

  it("applies an expired fixed-time reset without waking the model while the role is busy", async () => {
    const { dir, conv } = await context();
    const globalDir = globalSpeechDispatcherDir(dir);
    const dispatcherDir = join(conv.dir, "speech-dispatcher");
    await mkdir(globalDir, { recursive: true });
    await mkdir(dispatcherDir, { recursive: true });
    const config = defaultSpeechDispatcherConfig();
    config.reset = { mode: "interval", intervalMinutes: 1 };
    await writeFile(join(globalDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(join(globalDir, "tools.json"), `${JSON.stringify({ enabled: [] }, null, 2)}\n`);
    await writeFile(join(globalDir, "prompt.md"), "判断是否发言。\n");
    const oldTime = Date.now() - 120_000;
    await writeFile(join(dispatcherDir, "session.json"), `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: oldTime,
      sessionCreatedAt: oldTime,
      messages: [{ role: "user", content: "旧记忆" }],
      usage: { input: 1, output: 1, total: 2, lastInput: 1, lastOutput: 1, lastTotal: 2 },
      nextSeq: 1,
      lastPresentedSeq: 0,
      pending: [],
      messagesSinceReset: 4,
      dispatchesSinceReset: 0,
    }, null, 2)}\n`);
    const gate = deferred();
    const prompts: string[] = [];
    let busy = true;
    const role = {
      submit: async () => ({ queued: false, position: 1 }),
      isBusy: () => busy,
      waitForIdle: async () => { if (busy) await gate.promise; },
    };
    const manager = new SpeechDispatcherManager({ appDir: dir, role, createController: fakeControllerFactory({ prompts }) as never });
    await manager.submit(inbound("重置时清空", 1), conv, "重置时清空");
    await waitForFileText(join(dispatcherDir, "transcript.md"), "固定时间到期");
    expect(prompts).toEqual([]);
    const state = await waitForJson(join(dispatcherDir, "session.json"), (value) => Number(value.sessionCreatedAt) > oldTime);
    expect(state.pending).toEqual([]);
    expect(state.messages).toEqual([]);
    expect(state.messagesSinceReset).toBe(0);
    expect(state.nextSeq).toBe(1);
    busy = false;
    gate.resolve();
    await manager.close();
  });
});
