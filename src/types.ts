export interface MessageSegment {
  type: string;
  data: Record<string, unknown>;
}
export type AnyMessageSegment = MessageSegment;
export interface OneBotMessageEvent {
  time: number;
  self_id: number;
  post_type: string;
  message_type: "private" | "group";
  message_id: number;
  user_id: number;
  message: unknown;
  raw_message: string;
  group_id?: number;
  [key: string]: unknown;
}

export type ProviderName = "anthropic" | "openai" | "openrouter" | "deepseek" | "custom";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface Config {
  snowluma: { wsUrl: string; accessToken?: string | null };
  llm: {
    provider: ProviderName;
    model: string;
    thinkingLevel: ThinkingLevel;
    baseUrl?: string | null;
    apiKeyEnv: string;
  };
  whitelist: {
    private: number[];
    groups: number[];
  };
  groupDefaults: GroupConfig;
  group?: GroupConfig;
  session: { inactivityTtlHours: number; maxMessages: number };
  conversationsDir: string;
  media: {
    downloadsDir: string;
    autoDownload: Array<"image" | "file" | "record" | "video">;
    downloadFailedNotice: string;
    containerFallback: { enabled: boolean; volumeName?: string | null; hostDir?: string | null };
    placeholder: Record<string, string>;
  };
  promptsDir: string;
  reply: {
    mode: "realtime" | "batch";
    retryCount: number;
    retryDelayMs: number;
    queueNotice: string;
    queueFullNotice: string;
    stopNotice: string;
    stopIdleNotice: string;
    newSessionNotice: string;
    unknownCommandNotice: string;
    commandNotAllowedNotice: string;
    helpText?: string | null;
    helpExtra?: string | null;
    statusTemplate: string;
    failedSendDir: string;
  };
  commandPrefix: string;
  queue: { maxLength: number; notifyFirstOnly: boolean };
  skills: { dir: string; enabled: string[] };
  mcp: { servers: McpServerConfig[] };
  blockedToolNames: string[];
}

export interface GroupConfig {
  mode?: "at" | "all";
  session?: "shared" | "per-user";
  commandAllowlist?: string[];
}

export interface McpServerConfig {
  id: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  allow?: string[];
}

export interface SessionMessage {
  role: "user" | "assistant" | "toolResult";
  [key: string]: unknown;
}

export interface SessionUsage {
  input: number;
  output: number;
  total: number;
  lastInput: number;
  lastOutput: number;
  lastTotal: number;
}

export interface SessionEnvelope {
  schemaVersion: 1;
  key: string;
  updatedAt: number;
  createdAt?: number;
  messages: SessionMessage[];
  usage?: SessionUsage;
}

export type SessionTarget =
  | { kind: "private"; userId: number }
  | { kind: "group"; groupId: number; userId?: number };

export interface InboundMessage {
  event: OneBotMessageEvent;
  segments: AnyMessageSegment[];
  sessionKey: string;
  promptText: string;
  target: SessionTarget;
}

export interface ReplyTarget {
  kind: "private" | "group";
  userId?: number;
  groupId?: number;
}
