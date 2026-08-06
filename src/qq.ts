import { createWebSocketClient, type SnowLumaWebSocketClient } from "@snowluma/sdk";
import type { Config } from "./types.js";

export function createQqClient(config: Config): SnowLumaWebSocketClient {
  return createWebSocketClient({ url: config.snowluma.wsUrl, accessToken: config.snowluma.accessToken ?? undefined, reconnect: true });
}

export async function checkQq(config: Config): Promise<Record<string, unknown>> {
  const client = createWebSocketClient({ url: config.snowluma.wsUrl, accessToken: config.snowluma.accessToken ?? undefined, reconnect: false });
  try {
    await client.connect();
    return await client.getLoginInfo() as Record<string, unknown>;
  } finally {
    client.close();
  }
}
