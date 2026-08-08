import type { SessionMessage, SessionUsage } from "./types.js";

export const processStartedAt = Date.now();

export interface StatusSnapshot {
  chatType: string;
  sessionMode: string;
  sessionKey: string;
  busy: boolean;
  processing: boolean;
  busyText: string;
  processingDuration: string;
  sessionDuration: string;
  queueLength: number;
  queueMax: number;
  messageCount: number;
  pendingReset: string;
  model: string;
  replyMode: string;
  sessionTokens: string;
  lastTokens: string;
  lastActive: string;
  uptime: string;
}

export function blankUsage(): SessionUsage {
  return { input: 0, output: 0, total: 0, lastInput: 0, lastOutput: 0, lastTotal: 0 };
}

export function normalizeUsage(value: unknown): SessionUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const num = (key: string): number => {
    const n = raw[key];
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return {
    input: num("input"),
    output: num("output"),
    total: num("total"),
    lastInput: num("lastInput"),
    lastOutput: num("lastOutput"),
    lastTotal: num("lastTotal"),
  };
}

export function extractMessageUsage(message: SessionMessage | { usage?: unknown }): { input: number; output: number; total: number } {
  const usage = (message as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return { input: 0, output: 0, total: 0 };
  const raw = usage as Record<string, unknown>;
  const pick = (...keys: string[]): number => {
    for (const key of keys) {
      const n = raw[key];
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
    }
    return 0;
  };
  const input = pick("input", "inputTokens", "prompt_tokens");
  const output = pick("output", "outputTokens", "completion_tokens");
  const total = pick("totalTokens", "total_tokens", "total") || input + output;
  return { input, output, total };
}

export function accumulateUsage(current: SessionUsage, messages: SessionMessage[], fromIndex: number): SessionUsage {
  let lastInput = 0;
  let lastOutput = 0;
  let lastTotal = 0;
  let addedInput = 0;
  let addedOutput = 0;
  let addedTotal = 0;
  for (let i = Math.max(0, fromIndex); i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const u = extractMessageUsage(msg);
    if (!u.total && !u.input && !u.output) continue;
    lastInput = u.input;
    lastOutput = u.output;
    lastTotal = u.total;
    addedInput += u.input;
    addedOutput += u.output;
    addedTotal += u.total;
  }
  return {
    input: current.input + addedInput,
    output: current.output + addedOutput,
    total: current.total + addedTotal,
    lastInput,
    lastOutput,
    lastTotal,
  };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  if (ms < 1000) return "不到1秒";
  const totalSec = Math.floor(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  const parts: string[] = [];
  if (hours) parts.push(`${hours}小时`);
  if (minutes) parts.push(`${minutes}分`);
  if (seconds || !parts.length) parts.push(`${seconds}秒`);
  return parts.join("");
}

export function formatTokens(input: number, output: number, total: number): string {
  return `${input}/${output}/${total}`;
}

export function formatStatus(template: string, snap: StatusSnapshot): string {
  const map: Record<string, string> = {
    chatType: snap.chatType,
    sessionMode: snap.sessionMode,
    sessionKey: snap.sessionKey,
    busy: snap.busy ? "是" : "否",
    processing: snap.processing ? "是" : "否",
    busyText: snap.busyText,
    processingDuration: snap.processingDuration,
    sessionDuration: snap.sessionDuration,
    queueLength: String(snap.queueLength),
    queueMax: String(snap.queueMax),
    messageCount: String(snap.messageCount),
    pendingReset: snap.pendingReset,
    model: snap.model,
    replyMode: snap.replyMode,
    sessionTokens: snap.sessionTokens,
    lastTokens: snap.lastTokens,
    lastActive: snap.lastActive,
    uptime: snap.uptime,
  };
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in map ? map[key] : match));
}
