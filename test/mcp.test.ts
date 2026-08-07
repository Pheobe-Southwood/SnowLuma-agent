import { describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callMcpTool } from "../src/mcp.js";

describe("MCP cancellation", () => {
  it("passes the Agent AbortSignal to client.callTool", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const client = {
      callTool: async (_params: unknown, _schema: unknown, options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as Pick<Client, "callTool">;

    await callMcpTool(client, "slow_tool", {}, controller.signal);
    expect(receivedSignal).toBe(controller.signal);
  });
});
