import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, initWorkspace, loadConfig, mergeConfig, parseIdList } from "../src/config.js";
import { buildInbound, isAdmitted, isWhitelisted, messageSegments, promptForLlm, promptTextFromEvent, sessionKey, textFromSegments } from "../src/filter.js";
import { formatHelp, parseCommand, unescapeCommandText } from "../src/commands.js";
import { accumulateUsage, blankUsage, extractMessageUsage, formatDuration, formatStatus, type StatusSnapshot } from "../src/status.js";
import { assistantText } from "../src/reply.js";
import { listSkills, useSkill } from "../src/skills.js";
import { loadSession, saveSession } from "../src/sessions.js";
import { processMedia } from "../src/media.js";
import type { InboundMessage, OneBotMessageEvent } from "../src/types.js";

function event(overrides: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent {
  return {
    time: 1,
    self_id: 999,
    post_type: "message",
    message_type: "private",
    message_id: 42,
    user_id: 10001,
    message: [{ type: "text", data: { text: "hello" } }],
    raw_message: "hello",
    ...overrides,
  };
}

describe("mergeConfig", () => {
  it("merges known fields and group policy while ignoring unknown top-level keys", () => {
    const merged = mergeConfig(defaultConfig("/tmp/snowluma-test"), {
      skillsDir: "/legacy/skills",
      whitelist: {
        private: [10001],
        groups: [1101061750],
      },
      groupDefaults: { mode: "all", session: "per-user" },
      group: { session: "shared" },
      llm: { model: "merged-model" },
    });
    expect(merged.whitelist.private).toEqual([10001]);
    expect(merged.whitelist.groups).toEqual([1101061750]);
    expect(merged.groupDefaults).toEqual({ mode: "all", session: "per-user" });
    expect(merged.group?.session).toBe("shared");
    expect(merged.llm.model).toBe("merged-model");
    expect(merged.llm.provider).toBe("anthropic");
    expect((merged as unknown as { skillsDir?: string }).skillsDir).toBeUndefined();
  });
});

describe("parseIdList", () => {
  it("parses one id per line and ignores comments/blank/invalid lines", () => {
    expect(parseIdList("# comment\n\n10001\n 123456 \nbad\n0\n10001\n")).toEqual([10001, 123456]);
  });
});

describe("initWorkspace and loadConfig", () => {
  it("creates split config files and loads tools/whitelist from them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snowluma-init-"));
    await initWorkspace(dir);
    expect(JSON.parse(await readFile(join(dir, "config.json"), "utf8")).skills).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, "tools.json"), "utf8")).mcp).toEqual({ servers: [] });
    await writeFile(join(dir, "whitelist", "private.txt"), "10001\n");
    await writeFile(join(dir, "whitelist", "groups.txt"), "# g\n123456\n");
    await writeFile(join(dir, "tools.json"), `${JSON.stringify({
      skills: { dir: join(dir, "skills"), enabled: ["demo"] },
      mcp: { servers: [] },
      blockedToolNames: ["bash"],
    }, null, 2)}\n`);
    const config = await loadConfig(dir);
    expect(config.whitelist.private).toEqual([10001]);
    expect(config.whitelist.groups).toEqual([123456]);
    expect(config.skills.enabled).toEqual(["demo"]);
    expect(config.blockedToolNames).toEqual(["bash"]);
    expect(config.groupDefaults.mode).toBe("at");
  });

  it("rejects invalid tools.json JSON with a clear error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snowluma-bad-tools-"));
    await initWorkspace(dir);
    await writeFile(join(dir, "tools.json"), "{ not-json\n");
    await expect(loadConfig(dir)).rejects.toThrow(/tools\.json 解析失败/);
  });

  it("filters malformed mcp.servers entries and keeps valid ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snowluma-mcp-"));
    await initWorkspace(dir);
    await writeFile(join(dir, "tools.json"), `${JSON.stringify({
      skills: { dir: join(dir, "skills"), enabled: [] },
      mcp: {
        servers: [
          { id: "ok", transport: "stdio", command: "uvx", args: ["demo"] },
          { id: "", transport: "stdio", command: "bad" },
          { transport: "http", url: "https://example.com" },
          { id: "bad-transport", transport: "udp" },
          "skip-me",
          { id: "http-ok", transport: "http", url: "https://example.com", headers: { a: "1", n: 2 }, allow: ["t", 1] },
        ],
      },
      blockedToolNames: [],
    }, null, 2)}\n`);
    const config = await loadConfig(dir);
    expect(config.mcp.servers).toEqual([
      { id: "ok", transport: "stdio", command: "uvx", args: ["demo"] },
      { id: "http-ok", transport: "http", url: "https://example.com", headers: { a: "1" }, allow: ["t"] },
    ]);
  });

  it("propagates non-ENOENT whitelist read errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snowluma-wl-err-"));
    await initWorkspace(dir);
    const privatePath = join(dir, "whitelist", "private.txt");
    await rm(privatePath);
    await mkdir(privatePath);
    await expect(loadConfig(dir)).rejects.toMatchObject({ code: "EISDIR" });
  });
});

describe("filter and commands", () => {
  it("enforces private/group whitelist and @ mode", () => {
    const config = defaultConfig("/tmp/snowluma-test");
    config.whitelist.private = [10001];
    config.whitelist.groups = [123];
    config.groupDefaults = { mode: "at", session: "shared" };
    expect(isAdmitted(event(), config)).toBe(true);
    expect(isWhitelisted(event(), config)).toBe(true);
    const group = event({ message_type: "group", group_id: 123, message: [{ type: "text", data: { text: "hello" } }] });
    expect(isAdmitted(group, config)).toBe(true);
    expect(isWhitelisted(group, config)).toBe(false);
    group.message = [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: "hello" } }];
    expect(isWhitelisted(group, config)).toBe(true);
    const inbound = buildInbound(group, config, "hello")!;
    expect(sessionKey(inbound.target)).toBe("group:123");
    expect(textFromSegments(messageSegments(group))).toContain("hello");
  });

  it("keeps slash commands out of escaped prompts", () => {
    expect(parseCommand("/stop")?.name).toBe("stop");
    expect(parseCommand("/help")?.name).toBe("help");
    expect(parseCommand("/status")?.name).toBe("status");
    expect(parseCommand("//help")).toBeUndefined();
    expect(parseCommand("//stop")).toBeUndefined();
    expect(unescapeCommandText("//stop")).toBe("/stop");
  });

  it("formats help from command registry and config overrides", () => {
    const auto = formatHelp("/");
    expect(auto).toContain("/new —");
    expect(auto).toContain("/stop —");
    expect(auto).toContain("/help —");
    expect(auto).toContain("/status —");
    expect(formatHelp("!", undefined, "自定义帮助")).toBe("自定义帮助");
    expect(formatHelp("/", "更多说明")).toContain("更多说明");
  });

  it("formats status template and usage helpers", () => {
    expect(formatDuration(500)).toBe("不到1秒");
    expect(formatDuration(65_000)).toBe("1分5秒");
    expect(extractMessageUsage({ role: "assistant", usage: { input: 10, output: 5, totalTokens: 15 } })).toEqual({ input: 10, output: 5, total: 15 });
    const usage = accumulateUsage(blankUsage(), [
      { role: "user" },
      { role: "assistant", usage: { input: 3, output: 2, totalTokens: 5 } },
      { role: "assistant", usage: { input: 7, output: 1, totalTokens: 8 } },
    ], 0);
    expect(usage).toEqual({ input: 10, output: 3, total: 13, lastInput: 7, lastOutput: 1, lastTotal: 8 });
    const snap: StatusSnapshot = {
      chatType: "私聊",
      sessionMode: "—",
      sessionKey: "private:1",
      busy: false,
      processing: false,
      busyText: "空闲",
      processingDuration: "空闲",
      sessionDuration: "1分",
      queueLength: 0,
      queueMax: 10,
      messageCount: 2,
      pendingReset: "否",
      model: "deepseek/x",
      replyMode: "realtime",
      sessionTokens: "10/3/13",
      lastTokens: "7/1/8",
      lastActive: "不到1秒",
      uptime: "2分",
    };
    expect(formatStatus("类型：{chatType} 状态：{busyText} token：{sessionTokens}", snap)).toBe("类型：私聊 状态：空闲 token：10/3/13");
  });

  it("removes only a leading self mention from group prompt text", () => {
    const group = event({
      message_type: "group",
      group_id: 123,
      user_id: 456,
      message: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: " /new" } }],
    });
    expect(promptTextFromEvent(group)).toBe("/new");
    expect(parseCommand(promptTextFromEvent(group))?.name).toBe("new");
    expect(promptForLlm(group, "你好")).toBe("[发送者QQ号: 456] 你好");

    const otherMention = event({
      message_type: "group",
      group_id: 123,
      message: [{ type: "at", data: { qq: "100" } }, { type: "text", data: { text: " hello" } }],
    });
    expect(promptTextFromEvent(otherMention)).toBe("@100 hello");

    const middleMention = event({
      message_type: "group",
      group_id: 123,
      message: [{ type: "text", data: { text: "hello " } }, { type: "at", data: { qq: "999" } }, { type: "text", data: { text: " world" } }],
    });
    expect(promptTextFromEvent(middleMention)).toBe("hello @999 world");
    expect(promptForLlm(event(), "你好")).toBe("你好");
  });
});

describe("skills and replies", () => {
  it("indexes frontmatter and reads only a named skill", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snowluma-skills-"));
    await mkdir(join(dir, "demo"));
    await writeFile(join(dir, "demo", "SKILL.md"), "---\nname: demo\ndescription: test skill\n---\nbody");
    expect((await listSkills(dir))[0]?.description).toBe("test skill");
    expect(await useSkill(dir, "demo")).toContain("body");
    expect(await useSkill(dir, "missing")).toContain("未找到");
  });

  it("extracts assistant text while excluding thinking/tool calls", () => {
    expect(assistantText({ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "public" }, { type: "toolCall", id: "1", name: "x", arguments: {} }], api: "x", provider: "x", model: "x", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 })).toBe("public");
  });
});

describe("media and sessions", () => {
  it("saves direct media under encoded session directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snowluma-media-"));
    const config = defaultConfig(dir);
    config.media.downloadsDir = join(dir, "downloads");
    const inbound: InboundMessage = { event: event({ message_id: 7 }), target: { kind: "private", userId: 10001 }, sessionKey: "private:10001", segments: [{ type: "image", data: { file: "a.jpg", url: "data:image/jpeg;base64,SGk=" } }], promptText: "", };
    const result = await processMedia(inbound, config);
    expect(result.failed).toBe(0);
    expect(result.text).toContain("已保存到");
    expect(await readFile(result.saved[0]!)).toEqual(Buffer.from("Hi"));
  });

  it("removes a leading self mention from group media prompt text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snowluma-group-media-"));
    const config = defaultConfig(dir);
    config.media.downloadsDir = join(dir, "downloads");
    const groupEvent = event({
      message_type: "group",
      group_id: 123,
      user_id: 456,
      message: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: " see this" } }],
    });
    const inbound: InboundMessage = {
      event: groupEvent,
      target: { kind: "group", groupId: 123 },
      sessionKey: "group:123",
      segments: [{ type: "at", data: { qq: "999" } }, { type: "text", data: { text: " see this" } }, { type: "image", data: { file: "a.jpg", url: "data:image/jpeg;base64,SGk=" } }],
      promptText: "",
    };
    const result = await processMedia(inbound, config);
    expect(result.text).toMatch(/^see this/);
    expect(result.text).not.toContain("@999");
  });

  it("expires and atomically restores session envelopes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snowluma-session-"));
    const envelope = { schemaVersion: 1 as const, key: "private:1", updatedAt: 1000, messages: [{ role: "user" as const, content: "hello" }] };
    await saveSession(dir, envelope, 60);
    expect((await loadSession(dir, "private:1", 100, 1050)).messages).toHaveLength(1);
    const expired = await loadSession(dir, "private:1", 10, 1050);
    expect(expired.messages).toHaveLength(0);
    expect(expired.updatedAt).toBe(1000);
    expect(expired.createdAt).toBe(1050);
    expect(expired.usage).toEqual({ input: 0, output: 0, total: 0, lastInput: 0, lastOutput: 0, lastTotal: 0 });
  });
});
