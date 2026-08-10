import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { envApiKeyAuth } from "@earendil-works/pi-ai";
import type { Config, ReplyTarget, SessionMessage, SessionUsage } from "./types.js";
import { llmApiKey } from "./config.js";
import type { ConversationContext } from "./conversations.js";
import { createWorkingHeartbeat, type WorkingHeartbeat } from "./heartbeat.js";
import { assistantText, sendText } from "./reply.js";
import { accumulateUsage, blankUsage } from "./status.js";
import { safetyGate, buildTools } from "./tools.js";
import { connectMcp, type McpRuntime } from "./mcp.js";
import { listSkills, skillsPrompt } from "./skills.js";
import type { SnowLumaWebSocketClient } from "@snowluma/sdk";

function customModel(config: Config): Model<"openai-completions"> {
  if (!config.llm.baseUrl) throw new Error("custom provider 必须配置 llm.baseUrl");
  return {
    id: config.llm.model,
    name: config.llm.model,
    api: "openai-completions",
    provider: "custom",
    baseUrl: config.llm.baseUrl,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

function makeModels(config: Config) {
  const models = createModels();
  if (config.llm.provider === "custom") {
    models.setProvider(createProvider({
      id: "custom",
      name: "Custom OpenAI-compatible",
      baseUrl: config.llm.baseUrl ?? undefined,
      auth: { apiKey: envApiKeyAuth("Custom API key", [config.llm.apiKeyEnv]) },
      models: [customModel(config)],
      api: openAICompletionsApi(),
    }));
  } else {
    const provider = config.llm.provider === "anthropic"
      ? anthropicProvider()
      : config.llm.provider === "openai"
        ? openaiProvider()
        : config.llm.provider === "deepseek"
          ? deepseekProvider()
          : openrouterProvider();
    models.setProvider(provider);
  }
  return models;
}

export interface PromptOptions {
  usageBaseline?: SessionUsage;
}

export interface AgentController {
  readonly agent: Agent;
  readonly mcp: McpRuntime;
  prompt(text: string, options?: PromptOptions): Promise<void>;
  abort(): void;
  isRunning(): boolean;
  waitForIdle(): Promise<void>;
  reset(): void;
  setSystemPrompt(prompt: string): void;
  messages(): AgentMessage[];
  close(): Promise<void>;
}

export async function probeLlm(config: Config): Promise<{ model: string; text: string }> {
  const key = llmApiKey(config);
  if (!key) throw new Error(`缺少 ${config.llm.apiKeyEnv}`);
  const models = makeModels(config);
  const model = config.llm.provider === "custom" ? customModel(config) : models.getModel(config.llm.provider, config.llm.model);
  if (!model) throw new Error(`pi-ai 中找不到模型 ${config.llm.provider}/${config.llm.model}`);
  const result = await models.completeSimple(model, {
    systemPrompt: "只回复 OK，不要添加其他内容。",
    messages: [{ role: "user", content: "连接测试，请回复 OK。", timestamp: Date.now() }],
  }, { apiKey: key, maxTokens: 16 });
  const text = result.content.filter((block): block is { type: "text"; text: string } => block.type === "text").map((block) => block.text).join("").trim();
  if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage ?? `模型返回 ${result.stopReason}`);
  return { model: `${config.llm.provider}/${config.llm.model}`, text };
}

export async function createAgentController(options: {
  conv: ConversationContext;
  systemPrompt: string;
  messages: SessionMessage[];
  target: ReplyTarget;
  qq: SnowLumaWebSocketClient;
  sessionKey: string;
}): Promise<AgentController> {
  const { conv } = options;
  const config = conv.config;
  const key = llmApiKey(config, conv.env);
  if (!key) throw new Error(`缺少 ${config.llm.apiKeyEnv}，请先配置 LLM（全局 .env 或该会话的 .env）`);
  const models = makeModels(config);
  const model = config.llm.provider === "custom" ? customModel(config) : models.getModel(config.llm.provider, config.llm.model);
  if (!model) throw new Error(`pi-ai 中找不到模型 ${config.llm.provider}/${config.llm.model}；请检查配置或锁定版本的模型目录`);
  const mcp = await connectMcp(config);
  const skills = await listSkills(config.skills.dir, config.skills.enabled);
  const systemPrompt = `${options.systemPrompt}\n\n${skillsPrompt(skills)}`;
  let aborted = false;
  const batchTexts: string[] = [];
  let heartbeat: WorkingHeartbeat | undefined;
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: config.llm.thinkingLevel,
      tools: buildTools(config, config.skills, mcp.tools),
      messages: options.messages as unknown as AgentMessage[],
    },
    streamFn: models.streamSimple.bind(models),
    getApiKey: async () => key,
    toolExecution: "sequential",
    sessionId: options.sessionKey,
    beforeToolCall: async ({ toolCall }) => safetyGate(config, toolCall.name),
  });
  agent.subscribe(async (event) => {
    if (event.type !== "message_end") return;
    const text = assistantText(event.message);
    if (!text || aborted) return;
    if (config.reply.mode === "batch") batchTexts.push(text);
    else {
      await sendText(options.qq, options.target, text, config);
      heartbeat?.onUserVisible();
    }
  });
  return {
    agent,
    mcp,
    prompt: async (text, promptOptions) => {
      aborted = false;
      batchTexts.length = 0;
      const beforeCount = agent.state.messages.length;
      const usageBaseline = promptOptions?.usageBaseline ?? blankUsage();
      const startedAt = Date.now();
      heartbeat?.stop();
      heartbeat = createWorkingHeartbeat({
        enabled: config.reply.heartbeatEnabled,
        intervalMs: config.reply.heartbeatIntervalMs,
        template: config.reply.heartbeatTemplate,
        getUsage: () => accumulateUsage(usageBaseline, agent.state.messages as unknown as SessionMessage[], beforeCount),
        getElapsedMs: () => Date.now() - startedAt,
        isActive: () => !aborted,
        send: (message) => sendText(options.qq, options.target, message, config),
      });
      try {
        await agent.prompt(text);
        if (!aborted && config.reply.mode === "batch") {
          for (const item of batchTexts.splice(0)) {
            await sendText(options.qq, options.target, item, config);
            heartbeat?.onUserVisible();
          }
        }
      } finally {
        heartbeat?.stop();
        heartbeat = undefined;
      }
    },
    abort: () => {
      aborted = true;
      heartbeat?.stop();
      agent.abort();
    },
    isRunning: () => agent.state.isStreaming,
    waitForIdle: () => agent.waitForIdle(),
    reset: () => {
      aborted = false;
      batchTexts.length = 0;
      heartbeat?.stop();
      heartbeat = undefined;
      agent.reset();
    },
    setSystemPrompt: (prompt) => { agent.state.systemPrompt = `${prompt}\n\n${skillsPrompt(skills)}`; },
    messages: () => agent.state.messages as AgentMessage[],
    close: () => mcp.close(),
  };
}

/** A Pi controller without QQ replies, skills, MCP, or heartbeat side effects. */
export async function createSilentAgentController(options: {
  config: Config;
  env: Record<string, string>;
  systemPrompt: string;
  messages: SessionMessage[];
  sessionKey: string;
  tools: AgentTool[];
}): Promise<AgentController> {
  const key = llmApiKey(options.config, options.env);
  if (!key) throw new Error(`缺少 ${options.config.llm.apiKeyEnv}，请配置发言调度 Agent 的 LLM 密钥`);
  const models = makeModels(options.config);
  const model = options.config.llm.provider === "custom"
    ? customModel(options.config)
    : models.getModel(options.config.llm.provider, options.config.llm.model);
  if (!model) throw new Error(`pi-ai 中找不到模型 ${options.config.llm.provider}/${options.config.llm.model}`);
  const mcp: McpRuntime = { tools: [], close: async () => undefined };
  const agent = new Agent({
    initialState: {
      systemPrompt: options.systemPrompt,
      model,
      thinkingLevel: options.config.llm.thinkingLevel,
      tools: options.tools,
      messages: options.messages as unknown as AgentMessage[],
    },
    streamFn: models.streamSimple.bind(models),
    getApiKey: async () => key,
    toolExecution: "sequential",
    sessionId: options.sessionKey,
  });
  return {
    agent,
    mcp,
    prompt: async (text) => { await agent.prompt(text); },
    abort: () => agent.abort(),
    isRunning: () => agent.state.isStreaming,
    waitForIdle: () => agent.waitForIdle(),
    reset: () => agent.reset(),
    setSystemPrompt: (prompt) => { agent.state.systemPrompt = prompt; },
    messages: () => agent.state.messages as AgentMessage[],
    close: () => mcp.close(),
  };
}
