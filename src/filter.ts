import { normalizeMessage, parseSegments } from "@snowluma/sdk";
import { groupPolicy } from "./config.js";
import type { AnyMessageSegment, Config, InboundMessage, OneBotMessageEvent, SessionTarget } from "./types.js";

export function messageSegments(event: OneBotMessageEvent): AnyMessageSegment[] {
  const raw = event.message;
  if (Array.isArray(raw)) return raw.filter((item): item is AnyMessageSegment => !!item && typeof item === "object" && "type" in item && "data" in item) as AnyMessageSegment[];
  if (typeof raw === "string") {
    try {
      const parsed = parseSegments(raw);
      if (parsed.length > 0) return parsed;
    } catch {
      // A plain string is still a valid OneBot message.
    }
    return [{ type: "text", data: { text: raw } }];
  }
  return [];
}

export function isAtSelf(event: OneBotMessageEvent, segments = messageSegments(event)): boolean {
  if (event.message_type !== "group") return true;
  return segments.some((segment) => segment.type === "at" && String(segment.data.qq) === String(event.self_id));
}

export function isAdmitted(event: OneBotMessageEvent, config: Config): boolean {
  if (event.message_type === "private") return config.whitelist.private.includes(event.user_id);
  return config.whitelist.groups.includes(event.group_id!);
}

export function isWhitelisted(event: OneBotMessageEvent, config: Config): boolean {
  if (!isAdmitted(event, config)) return false;
  if (event.message_type === "private") return true;
  const mode = groupPolicy(config).mode ?? "at";
  return mode === "all" || isAtSelf(event);
}

export function sessionTarget(event: OneBotMessageEvent, config: Config): SessionTarget {
  if (event.message_type === "private") return { kind: "private", userId: event.user_id };
  const session = groupPolicy(config).session ?? "shared";
  return session === "per-user" ? { kind: "group", groupId: event.group_id!, userId: event.user_id } : { kind: "group", groupId: event.group_id! };
}

export function conversationTarget(event: OneBotMessageEvent): SessionTarget {
  if (event.message_type === "private") return { kind: "private", userId: event.user_id };
  return { kind: "group", groupId: event.group_id! };
}

export function sessionKey(target: SessionTarget): string {
  if (target.kind === "private") return `private:${target.userId}`;
  return target.userId === undefined ? `group:${target.groupId}` : `group:${target.groupId}:user:${target.userId}`;
}

export function messageSegmentsForPrompt(event: OneBotMessageEvent, segments = messageSegments(event)): AnyMessageSegment[] {
  if (event.message_type !== "group") return segments;
  const result = segments.map((segment) => ({ ...segment, data: { ...segment.data } }));
  let index = 0;
  let removed = false;
  while (index < result.length) {
    const segment = result[index];
    if (segment.type === "text") {
      const text = String(segment.data.text ?? "");
      if (!text.trim()) { index += 1; continue; }
      if (removed) segment.data.text = text.replace(/^\s+/, "");
      break;
    }
    if (segment.type !== "at" || String(segment.data.qq) !== String(event.self_id)) break;
    result.splice(index, 1);
    removed = true;
  }
  return result;
}

export function textFromSegments(segments: AnyMessageSegment[]): string {
  return segments
    .map((segment) => {
      if (segment.type === "text") return String(segment.data.text ?? "");
      if (segment.type === "at") return `@${String(segment.data.qq ?? "")}`;
      if (segment.type === "face") return `[表情:${String(segment.data.id ?? "")}]`;
      if (segment.type === "reply") return `[回复:${String(segment.data.id ?? "")}]`;
      return "";
    })
    .join("")
    .trim();
}

export function promptTextFromEvent(event: OneBotMessageEvent, segments = messageSegments(event)): string {
  return textFromSegments(messageSegmentsForPrompt(event, segments));
}

export function promptForLlm(event: OneBotMessageEvent, text: string): string {
  return event.message_type === "group" ? `[发送者QQ号: ${event.user_id}] ${text}` : text;
}

export function buildInbound(event: OneBotMessageEvent, config: Config, promptText: string): InboundMessage | undefined {
  if (!isWhitelisted(event, config)) return undefined;
  const target = sessionTarget(event, config);
  return { event, segments: messageSegments(event), sessionKey: sessionKey(target), promptText, target };
}

export function normalizeIncomingText(value: string): string {
  const normalized = normalizeMessage(value);
  return typeof normalized === "string" ? normalized : normalized.map((segment: AnyMessageSegment) => segment.type === "text" ? String(segment.data.text ?? "") : "").join("");
}
