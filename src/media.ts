import { chmod, mkdir, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import type { SnowLumaWebSocketClient } from "@snowluma/sdk";
import type { AnyMessageSegment, Config, InboundMessage } from "./types.js";

export interface MediaResult { text: string; failed: number; saved: string[]; }
export interface MediaClient {
  getImage?: (params: { file?: string; file_id?: string }) => Promise<Record<string, unknown>>;
  getRecord?: (params: { file?: string; file_id?: string }) => Promise<Record<string, unknown>>;
  getGroupFileUrl?: (groupId: number, fileId: string) => Promise<Record<string, unknown>>;
  downloadFile?: (params: { url?: string; base64?: string; name?: string }) => Promise<Record<string, unknown>>;
}

const extensionFor = (type: string, data: Record<string, unknown>): string => {
  const name = String(data.file ?? data.name ?? "");
  const extension = extname(name).replace(/[^a-zA-Z0-9.]/g, "");
  if (extension) return extension;
  return type === "image" ? ".jpg" : type === "record" ? ".amr" : type === "video" ? ".mp4" : ".bin";
};

const asString = (value: unknown): string | undefined => typeof value === "string" && value.length ? value : undefined;

function resultValue(result: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!result) return undefined;
  for (const key of keys) {
    const value = result[key];
    const direct = asString(value);
    if (direct) return direct;
    if (value && typeof value === "object") {
      const nested = resultValue(value as Record<string, unknown>, keys);
      if (nested) return nested;
    }
  }
  return undefined;
}

function encodedKey(sessionKey: string): string { return Buffer.from(sessionKey).toString("base64url"); }

async function saveRemote(url: string, path: string): Promise<void> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`媒体下载 HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(path, buffer, { mode: 0o600 });
}

async function saveBase64(base64: string, path: string): Promise<void> {
  const data = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  await writeFile(path, Buffer.from(data, "base64"), { mode: 0o600 });
}

async function resolveSource(segment: AnyMessageSegment, inbound: InboundMessage, client: MediaClient): Promise<{ url?: string; base64?: string }> {
  const data = segment.data as Record<string, unknown>;
  const directUrl = asString(data.url);
  if (directUrl) return { url: directUrl };
  const file = asString(data.file);
  const fileId = asString(data.file_id) ?? file;
  if (segment.type === "image") {
    const info = await client.getImage?.({ file, file_id: fileId });
    return { url: resultValue(info, ["url", "file", "path"]), base64: resultValue(info, ["base64", "data"]) };
  }
  if (segment.type === "record") {
    const info = await client.getRecord?.({ file, file_id: fileId });
    return { url: resultValue(info, ["url", "file", "path"]), base64: resultValue(info, ["base64", "data"]) };
  }
  if (segment.type === "file" && inbound.target.kind === "group" && file && client.getGroupFileUrl) {
    const info = await client.getGroupFileUrl(inbound.target.groupId, file);
    return { url: resultValue(info, ["url", "file", "path"]), base64: resultValue(info, ["base64", "data"]) };
  }
  return {};
}

export async function processMedia(inbound: InboundMessage, config: Config, sdkClient?: SnowLumaWebSocketClient): Promise<MediaResult> {
  const client: MediaClient = sdkClient ? {
    getImage: (params) => sdkClient.getImage(params) as Promise<Record<string, unknown>>,
    getRecord: (params) => sdkClient.getRecord(params) as Promise<Record<string, unknown>>,
    getGroupFileUrl: (groupId, fileId) => sdkClient.getGroupFileUrl(groupId, fileId) as Promise<Record<string, unknown>>,
    downloadFile: (params) => sdkClient.downloadFile(params) as Promise<Record<string, unknown>>,
  } : {};
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const dir = `${config.media.downloadsDir}/${encodedKey(inbound.sessionKey)}/${date}`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => undefined);
  let failed = 0;
  const saved: string[] = [];
  let sequence = 0;
  const textParts: string[] = [];
  for (const segment of inbound.segments) {
    const type = String(segment.type);
    if (!config.media.autoDownload.includes(type as never) || !["image", "file", "record", "video"].includes(type)) {
      if (type === "text") textParts.push(String((segment.data as Record<string, unknown>).text ?? ""));
      else if (type === "at") textParts.push(`@${String((segment.data as Record<string, unknown>).qq ?? "")}`);
      continue;
    }
    sequence += 1;
    const data = segment.data as Record<string, unknown>;
    const path = `${dir}/${inbound.event.message_id}_${sequence}${extensionFor(type, data)}`;
    try {
      const source = await resolveSource(segment, inbound, client);
      if (source.url) await saveRemote(source.url, path);
      else if (source.base64) await saveBase64(source.base64, path);
      else if (config.media.containerFallback.enabled && client.downloadFile) {
        // The fallback is opt-in and only receives an explicit configured location.
        const result = await client.downloadFile({ url: asString(data.url), name: path });
        const returned = resultValue(result, ["file", "path"]);
        if (!returned) throw new Error("容器下载动作没有返回文件路径");
        throw new Error(`容器文件需由用户配置卷映射后拷贝：${returned}`);
      } else throw new Error("没有可用的媒体 URL/base64");
      saved.push(path);
      textParts.push((config.media.placeholder[type] ?? "用户发来的媒体已保存到 %s").replace("%s", path));
    } catch {
      failed += 1;
      textParts.push("用户发来的媒体下载失败");
    }
  }
  return { text: textParts.join(""), failed, saved };
}
