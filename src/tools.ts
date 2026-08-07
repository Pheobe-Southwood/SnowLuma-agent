import type { AgentTool, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import type { Config } from "./types.js";
import { buildUseSkillTool } from "./skills.js";

export function buildTools(config: Config, skills: { dir: string; enabled: string[] }, mcpTools: AgentTool[] = []): AgentTool[] {
  // The built-in table intentionally contains only the read-only skills tool.
  return [buildUseSkillTool(skills), ...mcpTools].filter((tool, index, list) => list.findIndex((item) => item.name === tool.name) === index);
}

export function safetyGate(config: Config, toolName: string): BeforeToolCallResult | undefined {
  const normalized = toolName.toLowerCase();
  const blocked = config.blockedToolNames.some((name) => normalized === name || normalized.includes(`__${name}`) || normalized.includes(name));
  return blocked ? { block: true, reason: `工具 ${toolName} 被安全策略禁用` } : undefined;
}
