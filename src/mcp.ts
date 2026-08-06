import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { Config, McpServerConfig } from "./types.js";

interface McpConnection { client: Client; transport: { close?: () => Promise<void> }; }
export interface McpRuntime { tools: AgentTool[]; close: () => Promise<void>; }

function safeName(value: string): string { return value.replace(/[^a-zA-Z0-9_-]/g, "_"); }

async function connectServer(server: McpServerConfig): Promise<McpConnection> {
  const client = new Client({ name: "snowluma-agent", version: "0.1.0" }, { capabilities: {} });
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (server.transport === "stdio") {
    if (!server.command) throw new Error(`MCP ${server.id} 缺少 command`);
    transport = new StdioClientTransport({ command: server.command, args: server.args ?? [] });
  } else {
    if (!server.url) throw new Error(`MCP ${server.id} 缺少 url`);
    transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: server.headers },
    });
  }
  await client.connect(transport);
  return { client, transport };
}

export async function connectMcp(config: Config): Promise<McpRuntime> {
  const connections: McpConnection[] = [];
  const tools: AgentTool[] = [];
  for (const server of config.mcp.servers) {
    const connection = await connectServer(server);
    connections.push(connection);
    const listed = await connection.client.listTools();
    for (const item of listed.tools) {
      if (server.allow && !server.allow.includes(item.name)) continue;
      const name = `mcp__${safeName(server.id)}__${safeName(item.name)}`;
      if (tools.some((tool) => tool.name === name)) throw new Error(`MCP 工具名称冲突：${name}`);
      tools.push({
        name,
        label: item.name,
        description: item.description ?? `MCP 工具 ${item.name}`,
        parameters: Type.Unsafe(item.inputSchema as Record<string, unknown>),
        execute: async (_id, args) => {
          const result = await connection.client.callTool({ name: item.name, arguments: args as Record<string, unknown> }) as { content?: Array<{ type: string; text?: string; [key: string]: unknown }>; [key: string]: unknown };
          const content = (result.content ?? []).flatMap((block) => {
            if (block.type === "text") return [{ type: "text" as const, text: block.text ?? "" }];
            return [{ type: "text" as const, text: JSON.stringify(block) }];
          });
          return { content: content.length ? content : [{ type: "text", text: JSON.stringify(result) }], details: result };
        },
      });
    }
  }
  return {
    tools,
    close: async () => { for (const connection of connections.reverse()) { await connection.client.close().catch(() => undefined); await connection.transport.close?.().catch(() => undefined); } },
  };
}
