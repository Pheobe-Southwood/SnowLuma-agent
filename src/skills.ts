import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

export interface SkillInfo { name: string; description: string; path: string; files: string[]; }

export async function listSkills(skillsDir: string, enabled?: string[]): Promise<SkillInfo[]> {
  const result: SkillInfo[] = [];
  let entries;
  try { entries = await readdir(skillsDir, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(skillsDir, entry.name);
    const skillPath = join(dir, "SKILL.md");
    try {
      const text = await readFile(skillPath, "utf8");
      const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
      const frontmatter = match?.[1] ?? "";
      const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? entry.name;
      if (enabled && enabled.length && !enabled.includes(name)) continue;
      const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "未提供描述";
      const files = (await readdir(dir, { withFileTypes: true })).filter((item) => item.isFile()).map((item) => relative(dir, join(dir, item.name)));
      result.push({ name, description, path: skillPath, files });
    } catch { /* malformed skill is skipped from the index */ }
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export function skillsPrompt(skills: SkillInfo[]): string {
  if (!skills.length) return "可用 skills：无（技能目录为空）。";
  return `可用 skills（需要时调用 use_skill 读取正文）：\n${skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`;
}

export async function useSkill(skillsDir: string, name: string, enabled?: string[]): Promise<string> {
  const skills = await listSkills(skillsDir, enabled);
  const skill = skills.find((item) => item.name === name);
  if (!skill) return `未找到 skill: ${name}`;
  const skillDir = join(skillsDir, name);
  const resolved = await stat(skillDir).catch(() => undefined);
  if (!resolved?.isDirectory()) return `skill 路径无效: ${name}`;
  const body = await readFile(skill.path, "utf8");
  return `${body}\n\n素材文件：${skill.files.join(", ") || "无"}`;
}

export function buildUseSkillTool(skills: { dir: string; enabled: string[] }): AgentTool {
  return {
    name: "use_skill",
    label: "Use skill",
    description: "读取技能目录中指定 skill 的 SKILL.md；只能读取技能目录，不执行任意文件操作。",
    parameters: Type.Object({ name: Type.String({ description: "技能名称" }) }),
    execute: async (_toolCallId, args) => ({ content: [{ type: "text", text: await useSkill(skills.dir, String((args as { name: string }).name), skills.enabled) }], details: {} }),
  };
}
