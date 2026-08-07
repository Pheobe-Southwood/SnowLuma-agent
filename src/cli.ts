import { readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appDir, initWorkspace, loadConfig, llmConfigurationStatus } from "./config.js";
import { checkQq, createQqClient } from "./qq.js";
import { listSkills } from "./skills.js";
import { buildInbound, isWhitelisted, promptForLlm, promptTextFromEvent, messageSegments, sessionTarget } from "./filter.js";
import { commandAllowed, parseCommand, unescapeCommandText } from "./commands.js";
import { processMedia } from "./media.js";
import { noticeText, sendText } from "./reply.js";
import { SessionManager } from "./sessions.js";
import { ConversationStore } from "./conversations.js";
import { createAgentController, probeLlm } from "./agent.js";
import type { InboundMessage, OneBotMessageEvent, ReplyTarget } from "./types.js";

const VERSION = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")).version as string;

function usage(): void {
  console.log(`snowluma-agent ${VERSION}\n\n用法：\n  snowluma-agent init [--systemd]\n  snowluma-agent start\n  snowluma-agent doctor\n  snowluma-agent skills list\n  snowluma-agent --version`);
}

function argDir(args: string[]): string { const index = args.indexOf("--dir"); return appDir(index >= 0 ? args[index + 1] : undefined); }
function targetOf(inbound: InboundMessage): ReplyTarget { return inbound.target.kind === "private" ? { kind: "private", userId: inbound.target.userId } : { kind: "group", groupId: inbound.target.groupId }; }

async function commandInit(args: string[]): Promise<void> {
  const dir = argDir(args);
  await initWorkspace(dir, args.includes("--systemd"));
  console.log(`已初始化 ${dir}`);
  console.log(`请编辑 ${dir}/config.json；SnowLuma accessToken 和白名单需由你自行配置。`);
}

async function commandDoctor(args: string[]): Promise<void> {
  const dir = argDir(args);
  const config = await loadConfig(dir);
  console.log(`检查 SnowLuma：${config.snowluma.wsUrl}`);
  let snowlumaOk = true;
  try { console.log(`SnowLuma 连通，登录信息：${JSON.stringify(await checkQq(config))}`); }
  catch (error) { snowlumaOk = false; console.error(`SnowLuma 连接失败：${String(error)}`); }
  const llm = llmConfigurationStatus(config);
  console.log(`LLM：${llm.message}`);
  if (!llm.configured) console.log("doctor 未调用 LLM；配置 provider/model/API key 后再次运行即可测试模型连接。");
  let llmOk = true;
  if (llm.configured && args.includes("--llm")) {
    try {
      const result = await probeLlm(config);
      console.log(`LLM 连通：${result.model}，模型回复：${result.text || "（空文本）"}`);
    } catch (error) {
      llmOk = false;
      console.error(`LLM 连接失败：${String(error)}`);
    }
  } else if (llm.configured) {
    console.log("LLM key 已配置；运行 doctor --llm 才会发起一次最小模型连接测试。");
  }
  if (!snowlumaOk || !llmOk) process.exitCode = 1;
}

async function commandSkills(args: string[]): Promise<void> {
  const dir = argDir(args);
  const config = await loadConfig(dir);
  const skills = await listSkills(config.skills.dir);
  if (!skills.length) { console.log("没有已安装的 skills。"); return; }
  for (const skill of skills) console.log(`${skill.name}\t${skill.description}`);
}

async function commandStart(args: string[]): Promise<void> {
  const dir = argDir(args);
  const config = await loadConfig(dir);
  const llm = llmConfigurationStatus(config);
  if (!llm.configured) {
    console.error(`无法启动：${llm.message}`);
    console.error("我已完成非 LLM 的安装和检查；请配置 LLM 后再继续。");
    process.exitCode = 2;
    return;
  }
  const qq = createQqClient(config);
  await qq.connect();
  console.log(`SnowLuma 已连接：${config.snowluma.wsUrl}`);
  const store = new ConversationStore({ config, dir });
  const manager = new SessionManager({
    config,
    store,
    qq,
    createController: (target, sessionKey, messages, systemPrompt, conv) => createAgentController({ conv, target, sessionKey, messages, systemPrompt, qq }),
  });
  const handle = async (event: OneBotMessageEvent): Promise<void> => {
    if (!isWhitelisted(event, config)) return;
    let conv;
    try {
      conv = await store.get(sessionTarget(event, config));
    } catch (error) {
      console.error(`[conversation] 会话初始化失败：`, error);
      return;
    }
    if (!isWhitelisted(event, conv.config)) return;
    const segments = messageSegments(event);
    const plain = promptTextFromEvent(event, segments);
    const inbound = buildInbound(event, conv.config, plain);
    if (!inbound) return;
    const command = parseCommand(plain, conv.config.commandPrefix);
    if (command) {
      if (!commandAllowed(command, inbound, conv.config)) { await sendText(qq, targetOf(inbound), conv.config.reply.commandNotAllowedNotice, conv.config); return; }
      if (command.name === "stop") {
        const stopped = await manager.stop(inbound.sessionKey);
        await sendText(qq, targetOf(inbound), stopped ? conv.config.reply.stopNotice : conv.config.reply.stopIdleNotice, conv.config);
      } else if (command.name === "new") {
        const status = await manager.newSession(inbound.sessionKey);
        await sendText(qq, targetOf(inbound), conv.config.reply.newSessionNotice, conv.config);
        if (status === "pending") console.log(`[${inbound.sessionKey}] /new 将在当前回答结束后生效`);
      } else {
        await sendText(qq, targetOf(inbound), conv.config.reply.unknownCommandNotice, conv.config);
      }
      return;
    }
    inbound.promptText = unescapeCommandText(plain, conv.config.commandPrefix);
    const media = await processMedia(inbound, conv.config, qq);
    inbound.promptText = promptForLlm(event, media.text);
    if (media.failed) await sendText(qq, targetOf(inbound), conv.config.media.downloadFailedNotice, conv.config);
    const result = await manager.submit(inbound);
    if (result.position === -1) await sendText(qq, targetOf(inbound), conv.config.reply.queueFullNotice, conv.config);
    else if (result.queued && (!conv.config.queue.notifyFirstOnly || result.position === 2)) await sendText(qq, targetOf(inbound), noticeText(conv.config.reply.queueNotice, result.position), conv.config);
  };
  qq.onPrivateMessage(handle);
  qq.onGroupMessage(handle);
  const close = async () => { await manager.close(); qq.close(); };
  process.once("SIGINT", () => void close().then(() => process.exit(0)));
  process.once("SIGTERM", () => void close().then(() => process.exit(0)));
  await new Promise<void>(() => undefined);
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const [command, subcommand] = argv;
  if (command === "--version" || command === "-v") { console.log(VERSION); return; }
  if (command === "init") return commandInit(argv);
  if (command === "doctor") return commandDoctor(argv);
  if (command === "skills" && subcommand === "list") return commandSkills(argv);
  if (command === "start") return commandStart(argv);
  usage();
}

export async function main(): Promise<void> {
  try { await runCli(); } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
