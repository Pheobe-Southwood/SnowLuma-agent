import { groupPolicy } from "./config.js";
import type { Config, InboundMessage } from "./types.js";

export const COMMANDS = [
  { name: "new", description: "开启新会话（清空当前记忆）" },
  { name: "stop", description: "停止当前回答并清空等待队列" },
  { name: "help", description: "显示全部可用指令与功能说明" },
  { name: "status", description: "显示当前会话状态" },
] as const;

export type CommandName = (typeof COMMANDS)[number]["name"];
export interface ParsedCommand { name: string; args: string; }

export function parseCommand(text: string, prefix = "/"): ParsedCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(prefix) || trimmed.startsWith(`${prefix}${prefix}`)) return undefined;
  const body = trimmed.slice(prefix.length).trim();
  const [name = "", ...rest] = body.split(/\s+/);
  return { name: name.toLowerCase(), args: rest.join(" ") };
}

export function unescapeCommandText(text: string, prefix = "/"): string {
  const trimmed = text.trimStart();
  return trimmed.startsWith(`${prefix}${prefix}`) ? `${prefix}${trimmed.slice(prefix.length * 2)}` : text;
}

export function commandAllowed(command: ParsedCommand, inbound: InboundMessage, config: Config): boolean {
  if (inbound.target.kind !== "group" || inbound.target.userId !== undefined) return true;
  const allowlist = groupPolicy(config).commandAllowlist;
  return !allowlist || allowlist.includes(command.name);
}

export function formatHelp(prefix: string, helpExtra?: string | null, helpText?: string | null): string {
  if (helpText && helpText.trim()) return helpText.trim();
  const lines = [
    "可用指令：",
    ...COMMANDS.map((cmd) => `${prefix}${cmd.name} — ${cmd.description}`),
    "",
    `以 ${prefix}${prefix} 开头可发送字面量 ${prefix}（不会当作指令）。`,
  ];
  const extra = helpExtra?.trim();
  if (extra) lines.push("", extra);
  return lines.join("\n");
}
