import { mkdir, writeFile, chmod } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SnowLumaWebSocketClient } from "@snowluma/sdk";
import type { Config, ReplyTarget } from "./types.js";

export function assistantText(message: AgentMessage): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content.filter((block): block is { type: "text"; text: string } => block.type === "text").map((block) => block.text).join("").trim();
}

export async function sendText(client: SnowLumaWebSocketClient, target: ReplyTarget, text: string, config: Config): Promise<void> {
  if (!text) return;
  let lastError: unknown;
  const attempts = Math.max(1, config.reply.retryCount + 1);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if (target.kind === "private") await client.sendPrivateMessage(target.userId!, text);
      else await client.sendGroupMessage(target.groupId!, text);
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, config.reply.retryDelayMs));
    }
  }
  await mkdir(config.reply.failedSendDir, { recursive: true, mode: 0o700 });
  const file = `${config.reply.failedSendDir}/${Date.now()}-${process.pid}.json`;
  await writeFile(file, `${JSON.stringify({ target, text, time: new Date().toISOString(), error: String(lastError) }, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

export function noticeText(template: string, position?: number): string {
  return template.replaceAll("{position}", position === undefined ? "" : `（前面还有 ${Math.max(0, position - 1)} 条）`);
}
