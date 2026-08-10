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
  "heartbeatEnabled": true,
  "heartbeatIntervalMs": 30000,
  "heartbeatTemplate": "【工作中】目前已消耗{total}token",
  "unknownCommandNotice": "未知指令，可用：/new /stop /help /status"
}
```

- `helpText`：非空时整段覆盖自动生成的 `/help` 内容。
- `helpExtra`：追加在自动生成列表之后。
- `heartbeatEnabled`：是否在 Agent「闷声干活」（长时间无用户可见文本）时向 QQ 发送进度提示，默认 `true`。
- `heartbeatIntervalMs`：静默满该毫秒数后发送一条心跳，之后若仍静默则每隔相同间隔再发；最小 `1000`，默认 `30000`。向 QQ 发出 assistant 文本（realtime 的中间回复或 batch 结束时的 flush）会重置计时；心跳本身不重置。
- `heartbeatTemplate`：心跳文案模板，支持以下占位符：

| 占位符 | 含义 |
|--------|------|
| `{total}` | 会话累计 total token（含历史与本轮已完成的 LLM 调用） |
| `{input}` / `{output}` | 会话累计 input / output |
| `{sessionTokens}` | `input/output/total`，与 `/status` 同格式 |
| `{elapsed}` | 本轮消息已处理时长 |

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

- `conversationsDir`：会话根目录，默认 `conversations`。每个会话（私聊按 QQ 号、群聊按群号）在该目录下有一个独立文件夹，存放该会话的 `session_*.json`、`prompt.md`、`config.json`、`tools.json` 和 `.env`。
- `promptsDir`：全局默认系统提示词 `SYSTEM_DEFAULT.md` 所在目录；每个会话的 `prompt.md` 首次使用时从它复制。
- `media.downloadsDir`：媒体文件。
- `reply.failedSendDir`：发送失败记录。
- `skills.dir`（在 `tools.json`）：全局 Skills 库目录。

路径应指向 Agent 用户有权限访问的目录，不要指向包含其他用户敏感数据的目录。

## 发言调度 Agent

发言调度 Agent 默认关闭。可在全局 `config.json` 中为新会话设置默认值，也可在具体会话的 `config.json` 中覆盖：

```json
"speechDispatcher": {
  "enabled": true
}
```

它只适用于私聊和群聊 `mode: "all"`、`session: "shared"`。群聊 @ 消息始终直达角色 Agent，并且完全不写入调度会话；`at` 和 `per-user` 模式保持原有直达行为。机器人自己发送的消息会被忽略。

第一次收到需要调度的消息时，程序会生成全局 `speech-dispatcher/`，并将 `prompt.md`、`config.json`、`tools.json` 复制到该会话的 `speech-dispatcher/`。已存在的文件不会覆盖。会话目录还包含持久化的 `session.json` 和供查看的 `transcript.md`。

调度 `config.json` 默认值：

```json
{
  "llm": {},
  "session": { "maxMessages": 60 },
  "reset": { "mode": "afterDispatches", "count": 1 },
  "templates": {
    "inputMessage": "[时间：{time}] [QQ：{qq}] {message}",
    "inputSuffix": "请根据规则判断是否该让角色 Agent 发消息了？",
    "dispatchMessage": "[QQ：{qq}] [时间：{time}] {message}",
    "dispatchSuffix": "以上为新的聊天记录"
  },
  "log": { "maxBytes": 10485760, "backupCount": 3 }
}
```

- `llm` 可部分覆盖角色 Agent 的 `provider`、`model`、`thinkingLevel`、`baseUrl`、`apiKeyEnv`；其余字段回退角色配置。若使用不同的 `apiKeyEnv`，程序会从全局 `.env` 补入会话 `.env`。
- `reset` 可设为 `{ "mode": "afterDispatches", "count": N }`、`{ "mode": "afterMessages", "count": N }` 或 `{ "mode": "interval", "intervalMinutes": N }`。达到阈值后等待当前轮结束再重置；自动重置和 `/new` 都会清空未派发消息、调度记忆和消息编号。
- 四个模板都必须是非空字符串。message 模板支持 `{time}`、`{qq}`、`{message}`；多条消息以换行合并，suffix 只追加一次。发给调度 Agent 时，程序会在每条 `inputMessage` 前自动注入不可配置的 Base36 短编号（如 `1`、`a`、`10`）；编号不会进入 `dispatchMessage`。
- `transcript.md` 达到 `log.maxBytes` 后轮转，默认保留 `.1` 到 `.3` 三份备份。
- 未派发消息没有独立数量上限；在下一次重置前长期不派发，可能增大会话文件和最终角色输入。

调度 `tools.json` 默认只启用原生工具：

```json
{
  "enabled": ["dispatch_to_character"]
}
```

- `dispatch_to_character`：把工具调用瞬间的全部未派发消息提交给角色 Agent，包括本轮推理期间新到的消息。
- `dispatch_selected_to_character`：接收 `{ "messageIds": ["1", "a"] }`，只提交已经展示且仍未派发的指定消息。消息按原始顺序发送；未选消息保留，但不会重新展示或重新编号。空数组、重复编号、未知编号、已派发编号或尚未展示的编号会令整次调用失败且不派发任何消息。

如需选择派发，可显式设置 `"enabled": ["dispatch_selected_to_character"]`，也可同时启用两个工具。默认仍只启用 `dispatch_to_character`。

调度 Agent 不加载角色 Agent 的 Skills 或 MCP。修改调度 `config.json`/`tools.json` 后需要重启；角色和调度的 `prompt.md` 每轮重新读取，可直接更新。固定时间重置不是定时唤醒，无新消息时不会主动调用模型或发送 QQ 消息。

## 每会话配置

首次收到某个私聊或群聊消息时，Agent 会在 `conversationsDir` 下自动创建该会话的文件夹，并生成 `config.json`、`tools.json` 和 `.env`，内容取自全局配置中与该会话相关的部分：

- 会话 `config.json` 包含 `llm`、`session`、`reply.mode`、`speechDispatcher`；群聊还会包含 `group`（`mode` / `session` / `commandAllowlist`），不包含私聊相关配置。
- 会话 `tools.json` 在新建时**完整复制**全局 `tools.json`（`skills`、`mcp`、`blockedToolNames`）。
- 会话 `.env` 只包含全局 `.env` 中 `llm.apiKeyEnv` 指向的密钥；修改会话 `config.json` 的 `llm.apiKeyEnv` 后，缺失的密钥会在下次使用时自动补入。
- 不做旧版「tools 写在会话 `config.json`」的自动迁移：若会话目录没有 `tools.json`，则使用全局 tools；需要会话级覆盖时请手动创建/拆分 `tools.json`。

会话配置会叠加在全局配置之上（未写的字段回落到全局配置）。例如让群 123456 单独使用 DeepSeek：

`conversations/123456/config.json`：

```json
{
  "llm": {
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "thinkingLevel": "medium",
    "baseUrl": null,
    "apiKeyEnv": "DEEPSEEK_API_KEY"
  },
  "group": {
    "mode": "all",
    "session": "per-user"
  }
}
```

只开放部分 Skills 时编辑同目录 `tools.json`：

```json
{
  "skills": {
    "dir": "/root/.snowluma-agent/skills",
    "enabled": ["demo"]
  },
  "mcp": {
    "servers": []
  },
  "blockedToolNames": ["bash", "terminal", "shell", "edit", "write", "read", "execute", "exec", "filesystem", "run"]
}
```

`skills.enabled` 为空数组表示使用全部 Skills；填入名称后该会话只能使用列出的 Skills。会话配置在进程启动后读取并缓存，修改后需要重启 Agent 生效。白名单始终以全局 `whitelist/*.txt` 为准，删除会话文件夹即可清空该会话的所有数据和配置。
