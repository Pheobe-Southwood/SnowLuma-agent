import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, llmApiKey } from "../src/config.js";
import { ConversationStore, conversationId, conversationIdFromSessionKey } from "../src/conversations.js";
import { listSkills, useSkill } from "../src/skills.js";
import type { SessionTarget } from "../src/types.js";

function groupTarget(groupId = 123456): SessionTarget {
  return { kind: "group", groupId };
}

function privateTarget(userId = 10001): SessionTarget {
  return { kind: "private", userId };
}

async function testContext(): Promise<{ config: ReturnType<typeof defaultConfig>; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "snowluma-conv-"));
  const config = defaultConfig(dir);
  config.conversationsDir = join(dir, "conversations");
  config.promptsDir = join(dir, "prompts");
  await mkdir(config.promptsDir, { recursive: true });
  await writeFile(join(config.promptsDir, "SYSTEM_DEFAULT.md"), "system prompt\n");
  return { config, dir };
}

describe("conversation identity", () => {
  it("derives folder names from QQ/group ids and session keys", () => {
    expect(conversationId(privateTarget(10001))).toBe("10001");
    expect(conversationId(groupTarget(123456))).toBe("123456");
    expect(conversationIdFromSessionKey("private:10001")).toBe("10001");
    expect(conversationIdFromSessionKey("group:123456")).toBe("123456");
    expect(conversationIdFromSessionKey("group:123456:user:789")).toBe("123456");
  });
});

describe("ConversationStore", () => {
  it("creates per-conversation folders with curated config, tools, .env and prompt", async () => {
    const { config, dir } = await testContext();
    config.groupDefaults = { mode: "at", session: "per-user", commandAllowlist: ["new"] };
    config.speechDispatcher.enabled = true;
    config.skills.enabled = ["demo"];
    config.blockedToolNames = ["bash"];
    const store = new ConversationStore({ config, dir });
    const group = await store.get(groupTarget());
    const convDir = group.dir;
    expect(existsSync(join(convDir, "config.json"))).toBe(true);
    expect(existsSync(join(convDir, "tools.json"))).toBe(true);
    expect(existsSync(join(convDir, ".env"))).toBe(true);
    expect(existsSync(join(convDir, "prompt.md"))).toBe(true);
    expect(await readFile(join(convDir, "prompt.md"), "utf8")).toBe("system prompt\n");

    const raw = JSON.parse(await readFile(join(convDir, "config.json"), "utf8")) as Record<string, unknown>;
    expect(raw.llm).toEqual(config.llm);
    expect("mcp" in raw).toBe(false);
    expect("skills" in raw).toBe(false);
    expect("blockedToolNames" in raw).toBe(false);
    expect(raw.group).toEqual({ mode: "at", session: "per-user", commandAllowlist: ["new"] });
    expect(raw.speechDispatcher).toEqual({ enabled: true });
    expect("whitelist" in raw).toBe(false);

    const tools = JSON.parse(await readFile(join(convDir, "tools.json"), "utf8")) as Record<string, unknown>;
    expect(tools).toEqual({
      skills: { dir: config.skills.dir, enabled: ["demo"] },
      mcp: { servers: [] },
      blockedToolNames: ["bash"],
    });
    expect(group.config.skills.enabled).toEqual(["demo"]);
    expect(group.config.blockedToolNames).toEqual(["bash"]);

    const privateConv = await store.get(privateTarget());
    const privateRaw = JSON.parse(await readFile(join(privateConv.dir, "config.json"), "utf8")) as Record<string, unknown>;
    expect("group" in privateRaw).toBe(false);
    expect("whitelist" in privateRaw).toBe(false);
    expect(privateConv.id).toBe("10001");
  });

  it("ignores legacy tools fields in config.json when tools.json is missing", async () => {
    const { config, dir } = await testContext();
    config.skills.enabled = ["global-only"];
    config.blockedToolNames = ["bash"];
    const convDir = join(config.conversationsDir, "10001");
    await mkdir(convDir, { recursive: true });
    await writeFile(join(convDir, "config.json"), `${JSON.stringify({
      llm: config.llm,
      skills: { dir: config.skills.dir, enabled: ["legacy"] },
      mcp: { servers: [{ id: "legacy", transport: "stdio", command: "echo" }] },
      blockedToolNames: ["shell"],
    }, null, 2)}\n`);
    const conv = await new ConversationStore({ config, dir }).get(privateTarget());
    expect(existsSync(join(convDir, "tools.json"))).toBe(false);
    expect(conv.config.skills.enabled).toEqual(["global-only"]);
    expect(conv.config.mcp.servers).toEqual([]);
    expect(conv.config.blockedToolNames).toEqual(["bash"]);
  });

  it("loads tools from conversation tools.json over the global tools", async () => {
    const { config, dir } = await testContext();
    config.skills.enabled = ["global"];
    const store = new ConversationStore({ config, dir });
    const conv = await store.get(privateTarget());
    await writeFile(join(conv.dir, "tools.json"), `${JSON.stringify({
      skills: { dir: config.skills.dir, enabled: ["session"] },
      mcp: { servers: [] },
      blockedToolNames: ["bash"],
    }, null, 2)}\n`);
    const updated = await new ConversationStore({ config, dir }).get(privateTarget());
    expect(updated.config.skills.enabled).toEqual(["session"]);
    expect(updated.config.blockedToolNames).toEqual(["bash"]);
  });

  it("copies only the llm apiKeyEnv key into the conversation .env", async () => {
    const { config, dir } = await testContext();
    await writeFile(join(dir, ".env"), "ANTHROPIC_API_KEY=global-anthropic\nDEEPSEEK_API_KEY=secret-deepseek\n");
    const store = new ConversationStore({ config, dir });
    const conv = await store.get(privateTarget());
    expect(conv.env).toEqual({ ANTHROPIC_API_KEY: "global-anthropic" });
    expect(llmApiKey(conv.config, conv.env)).toBe("global-anthropic");

    process.env.ANTHROPIC_API_KEY = "process-env-key";
    try {
      expect(llmApiKey(conv.config, conv.env)).toBe("global-anthropic");
      expect(llmApiKey(conv.config)).toBe("process-env-key");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("appends a missing key when the conversation switches apiKeyEnv", async () => {
    const { config, dir } = await testContext();
    const store = new ConversationStore({ config, dir });
    const conv = await store.get(privateTarget());
    expect(conv.env.ANTHROPIC_API_KEY).toBe("");
    await writeFile(join(conv.dir, "config.json"), `${JSON.stringify({ llm: { apiKeyEnv: "DEEPSEEK_API_KEY" } }, null, 2)}\n`);
    const updated = await new ConversationStore({ config, dir }).get(privateTarget());
    expect(updated.env.DEEPSEEK_API_KEY).toBe("");
    const envText = await readFile(join(updated.dir, ".env"), "utf8");
    expect(envText).toContain("DEEPSEEK_API_KEY=");
  });

  it("keeps a non-empty conversation key when the global value changes", async () => {
    const { config, dir } = await testContext();
    await writeFile(join(dir, ".env"), "ANTHROPIC_API_KEY=global-v1\n");
    const first = await new ConversationStore({ config, dir }).get(privateTarget());
    expect(first.env.ANTHROPIC_API_KEY).toBe("global-v1");
    await writeFile(join(dir, ".env"), "ANTHROPIC_API_KEY=global-v2\n");
    const second = await new ConversationStore({ config, dir }).get(privateTarget());
    expect(second.env.ANTHROPIC_API_KEY).toBe("global-v1");
  });

  it("fills an empty conversation key from the global env", async () => {
    const { config, dir } = await testContext();
    const first = await new ConversationStore({ config, dir }).get(privateTarget());
    expect(first.env.ANTHROPIC_API_KEY).toBe("");
    await writeFile(join(dir, ".env"), "ANTHROPIC_API_KEY=filled-later\n");
    const second = await new ConversationStore({ config, dir }).get(privateTarget());
    expect(second.env.ANTHROPIC_API_KEY).toBe("filled-later");
  });

  it("recovers from a corrupt conversation config.json", async () => {
    const { config, dir } = await testContext();
    config.skills.enabled = ["demo"];
    const store = new ConversationStore({ config, dir });
    const conv = await store.get(privateTarget());
    await writeFile(join(conv.dir, "config.json"), "{not-json\n");
    const recovered = await new ConversationStore({ config, dir }).get(privateTarget());
    expect(recovered.config.llm.model).toBe(config.llm.model);
    expect(existsSync(join(conv.dir, "config.json"))).toBe(true);
    expect(existsSync(join(conv.dir, "tools.json"))).toBe(true);
    expect(JSON.parse(await readFile(join(conv.dir, "config.json"), "utf8")).llm).toEqual(config.llm);
    expect(JSON.parse(await readFile(join(conv.dir, "tools.json"), "utf8")).skills.enabled).toEqual(["demo"]);
    expect((await readdir(conv.dir)).some((name) => name.startsWith("config.json.corrupt."))).toBe(true);
  });

  it("merges user edits to the conversation config over the global config", async () => {
    const { config, dir } = await testContext();
    const store = new ConversationStore({ config, dir });
    const before = await store.get(privateTarget());
    expect(before.config.llm.model).toBe(config.llm.model);
    await writeFile(join(before.dir, "config.json"), `${JSON.stringify({ llm: { provider: "deepseek", model: "deepseek-v4-flash", thinkingLevel: "high" } }, null, 2)}\n`);
    const after = await new ConversationStore({ config, dir }).get(privateTarget());
    expect(after.config.llm.model).toBe("deepseek-v4-flash");
    expect(after.config.llm.thinkingLevel).toBe("high");
    expect(after.config.session.maxMessages).toBe(config.session.maxMessages);
    expect(after.config.reply.mode).toBe(config.reply.mode);
  });

  it("lets each conversation override the group mode and session policy", async () => {
    const { config, dir } = await testContext();
    config.groupDefaults = { mode: "at", session: "shared" };
    const store = new ConversationStore({ config, dir });
    const conv = await store.get(groupTarget());
    expect(conv.config.group?.session).toBe("shared");
    expect(conv.config.group?.mode).toBe("at");
    await writeFile(join(conv.dir, "config.json"), `${JSON.stringify({ group: { session: "per-user" } }, null, 2)}\n`);
    const updated = await new ConversationStore({ config, dir }).get(groupTarget());
    expect(updated.config.group?.session).toBe("per-user");
    expect(updated.config.group?.mode ?? updated.config.groupDefaults.mode).toBe("at");
  });
});

describe("per-conversation skills", () => {
  it("filters skills by the enabled list", async () => {
    const dir = await mkdtemp(join(tmpdir(), "snowluma-skill-filter-"));
    await mkdir(join(dir, "demo"));
    await writeFile(join(dir, "demo", "SKILL.md"), "---\nname: demo\ndescription: test skill\n---\nbody");
    await mkdir(join(dir, "other"));
    await writeFile(join(dir, "other", "SKILL.md"), "---\nname: other\ndescription: another skill\n---\nbody");
    expect((await listSkills(dir)).map((s) => s.name)).toEqual(["demo", "other"]);
    expect((await listSkills(dir, ["demo"])).map((s) => s.name)).toEqual(["demo"]);
    expect(await useSkill(dir, "demo", ["demo"])).toContain("body");
    expect(await useSkill(dir, "other", ["demo"])).toContain("未找到");
    expect(await useSkill(dir, "other")).toContain("body");
  });
});
