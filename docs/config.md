# 配置说明

配置目录默认为 `~/.snowluma-agent`，也可以通过 `SNOWLUMA_AGENT_DIR` 指定。`snowluma-agent init` 会生成基础配置文件。

全局配置拆分为三个部分：

| 文件 | 内容 |
|------|------|
| `config.json` | SnowLuma、LLM、会话、媒体、回复、队列、**群聊默认策略** |
| `tools.json` | `skills`、`mcp`、`blockedToolNames` |
| `whitelist/private.txt` | 私聊 QQ 号，每行一个 |
| `whitelist/groups.txt` | 群号，每行一个 |

不做旧版单文件配置的自动迁移；升级后请手动拆分。

## SnowLuma 配置

```json
"snowluma": {
  "wsUrl": "ws://127.0.0.1:3001/",
  "accessToken": "从 SnowLuma OneBot 配置中取得的 token"
}
```

如果不希望把 token 保存到 JSON，可以临时设置环境变量：

```bash
SNOWLUMA_ACCESS_TOKEN="你的 SnowLuma token" snowluma-agent doctor
```

环境变量优先级高于 `config.json`。生产环境建议将配置文件权限设为 `600`，并且不要将配置文件提交到 Git。

## LLM 配置

支持的 provider：

- `anthropic`
- `openai`
- `openrouter`
- `deepseek`
- `custom`（OpenAI 兼容接口）

DeepSeek 示例：

```json
"llm": {
  "provider": "deepseek",
  "model": "deepseek-v4-flash",
  "thinkingLevel": "medium",
  "baseUrl": null,
  "apiKeyEnv": "DEEPSEEK_API_KEY"
}
```

在 `~/.snowluma-agent/.env` 中填写对应 API key：

```dotenv
DEEPSEEK_API_KEY=你的 DeepSeek API key
```

然后执行：

```bash
chmod 600 ~/.snowluma-agent/.env
snowluma-agent doctor --llm
```

`doctor` 只检查 SnowLuma 和 key 是否存在；`doctor --llm` 才会发起一次最小模型请求。

## 白名单

编辑纯文本文件即可，每行一个号码；空行和 `#` 注释会被忽略：

```text
# ~/.snowluma-agent/whitelist/private.txt
10001
10002
```

```text
# ~/.snowluma-agent/whitelist/groups.txt
123456
789012
```

- `private.txt`：允许使用机器人的 QQ 号。
- `groups.txt`：允许使用机器人的群号。
- 未列入白名单的消息会被忽略，不会调用 LLM。

群聊默认策略写在主配置的 `groupDefaults` 中；每个群会话首次创建时会复制到该会话 `config.json` 的 `group` 字段，之后可按会话单独修改：

```json
"groupDefaults": {
  "mode": "at",
  "session": "shared"
}
```

- `mode` 可选 `at` 或 `all`，默认 `at`。
- `session` 可选 `shared` 或 `per-user`，默认 `shared`。
- `commandAllowlist` 可选；仅对共享群聊会话生效。若配置了白名单，需显式包含 `help`、`status` 等指令名才能在共享群聊中使用。

群聊普通消息发送给 LLM 前会自动添加 `[发送者QQ号: <user_id>] ` 前缀，便于共享群聊会话区分不同发送者。消息开头的机器人 @ 会被移除；私聊消息和 `/new`、`/stop`、`/help`、`/status` 等系统命令不添加该前缀。

## 系统指令与 /status 模板

系统层指令（不进入 LLM、不占消息队列）：

| 指令 | 说明 |
|------|------|
| `/new` | 开启新会话（清空当前记忆） |
| `/stop` | 停止当前回答并清空等待队列 |
| `/help` | 显示全部可用指令与功能说明 |
| `/status` | 按模板显示当前会话状态 |

相关 `reply` 配置：

```json
"reply": {
  "helpText": null,
  "helpExtra": null,
  "statusTemplate": "【会话状态】\n类型：{chatType}\n会话模式：{sessionMode}\n状态：{busyText}\n当前消息处理：{processingDuration}\n会话时长：{sessionDuration}\n队列：{queueLength}/{queueMax}\n历史消息：{messageCount}\n待重置：{pendingReset}\n模型：{model}\n回复模式：{replyMode}\n会话 Token：{sessionTokens}\n上次 Token：{lastTokens}\n上次活跃：{lastActive}\n进程运行：{uptime}",
  "unknownCommandNotice": "未知指令，可用：/new /stop /help /status"
}
```

- `helpText`：非空时整段覆盖自动生成的 `/help` 内容。
- `helpExtra`：追加在自动生成列表之后。
- `statusTemplate`：`/status` 输出模板，支持以下占位符：

| 占位符 | 含义 |
|--------|------|
| `{chatType}` | 私聊 / 群聊 |
| `{sessionMode}` | 共享会话 / 每人单独会话（私聊为 —） |
| `{sessionKey}` | 内部会话键 |
| `{busy}` / `{processing}` | 是 / 否 |
| `{busyText}` | 空闲 / 处理中 / 忙碌 |
| `{processingDuration}` | 当前消息已处理时长，空闲时为「空闲」 |
| `{sessionDuration}` | 自上次 `/new` 或首次建会话起的时长 |
| `{queueLength}` / `{queueMax}` | 当前队列长度 / 上限 |
| `{messageCount}` | 历史消息条数 |
| `{pendingReset}` | 是否有待生效的 `/new` |
| `{model}` | `provider/model` |
| `{replyMode}` | realtime / batch |
| `{sessionTokens}` | 会话累计 token：`input/output/total` |
| `{lastTokens}` | 上次回复 token：`input/output/total` |
| `{lastActive}` | 距上次活跃的时长 |
| `{uptime}` | 进程运行时长 |

会话文件会额外保存 `createdAt` 与 `usage`（可选字段，旧文件兼容）。

## 工具配置（tools.json）

```json
{
  "skills": {
    "dir": "/root/.snowluma-agent/skills",
    "enabled": []
  },
  "mcp": {
    "servers": []
  },
  "blockedToolNames": ["bash", "terminal", "shell", "edit", "write", "read", "execute", "exec", "filesystem", "run"]
}
```

- `skills.enabled` 为空数组表示使用全部 Skills。
- `mcp.servers` 默认为空（不启用 MCP）。
- `blockedToolNames` 为危险工具名黑名单。

## 路径与会话

会话、提示词、媒体和失败发送记录默认保存在 `~/.snowluma-agent` 下。可以在配置中修改以下路径：

- `conversationsDir`：会话根目录，默认 `conversations`。每个会话（私聊按 QQ 号、群聊按群号）在该目录下有一个独立文件夹，存放该会话的 `session_*.json`、`prompt.md`、`config.json` 和 `.env`。
- `promptsDir`：全局默认系统提示词 `SYSTEM_DEFAULT.md` 所在目录；每个会话的 `prompt.md` 首次使用时从它复制。
- `media.downloadsDir`：媒体文件。
- `reply.failedSendDir`：发送失败记录。
- `skills.dir`（在 `tools.json`）：全局 Skills 库目录。

路径应指向 Agent 用户有权限访问的目录，不要指向包含其他用户敏感数据的目录。

## 每会话配置

首次收到某个私聊或群聊消息时，Agent 会在 `conversationsDir` 下自动创建该会话的文件夹，并生成 `config.json` 和 `.env`，内容取自全局配置中与该会话相关的部分：

- 会话 `config.json` 包含 `llm`、`session`、`mcp`、`skills`、`reply.mode`、`blockedToolNames`；群聊还会包含 `group`（`mode` / `session` / `commandAllowlist`），不包含私聊相关配置。
- 会话 `.env` 只包含全局 `.env` 中 `llm.apiKeyEnv` 指向的密钥；修改会话 `config.json` 的 `llm.apiKeyEnv` 后，缺失的密钥会在下次使用时自动补入。

会话配置会叠加在全局配置之上（未写的字段回落到全局配置）。例如让群 123456 单独使用 DeepSeek、只开放部分 Skills：

```json
{
  "llm": {
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "thinkingLevel": "medium",
    "baseUrl": null,
    "apiKeyEnv": "DEEPSEEK_API_KEY"
  },
  "skills": {
    "dir": "/root/.snowluma-agent/skills",
    "enabled": ["demo"]
  },
  "mcp": {
    "servers": []
  },
  "group": {
    "mode": "all",
    "session": "per-user"
  }
}
```

`skills.enabled` 为空数组表示使用全部 Skills；填入名称后该会话只能使用列出的 Skills。会话配置在进程启动后读取并缓存，修改后需要重启 Agent 生效。白名单始终以全局 `whitelist/*.txt` 为准，删除会话文件夹即可清空该会话的所有数据和配置。
