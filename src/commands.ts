import type { Config, InboundMessage } from "./types.js";

export type CommandName = "new" | "stop";
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
  const group = config.whitelist.groups[String(inbound.target.groupId)];
  return !group?.commandAllowlist || group.commandAllowlist.includes(command.name);
}
