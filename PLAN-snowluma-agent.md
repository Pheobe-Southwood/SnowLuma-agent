# SnowLuma-Agent 最终实施计划

> 状态：**已完成实现，准备发布到 GitHub**
> 交付形态：开源 GitHub 公开仓库 + npm 包（CLI）；本机部署仅用于连接验证和运行验证。

---

## 0. 背景与目标

基于 **pi 内核**（`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`）构建一个可接入 **SnowLuma**（QQ 原生会话 → OneBot v11 桥接运行时）的 QQ AI Agent，作为独立、可分发、可配置的开源 CLI 工具发布。

核心能力：

1. LLM 循环、对话循环、工具调用循环（pi 内置）；支持接入 **MCP 工具**，但**默认禁用文件编辑、终端**等危险工具。
2. 对接 SnowLuma：
   - **白名单**：仅白名单内的 QQ 号/群号消息进入 LLM；群聊可配置"仅 @ 消息 / 全部消息"，默认仅 @。
   - **会话**：私聊按用户单独持久化；群聊无跨会话记忆；会话 12 小时无消息自动开启新会话；支持 `/new` 手动重开会话。
   - **只透传"真正发出的文本"**：思考过程、工具调用过程不上 QQ；`message_end` 实时把每一条 assistant 文本块发到 QQ。
   - **自动转发**：LLM 文本经 OneBot（`@snowluma/sdk` 直连 WebSocket）自动发送，**不走 MCP**。
3. 媒体自动下载：白名单用户发来的图片/文件/语音自动保存到按会话分层的目录，并转换成占位文本喂给 LLM。
4. Skills：文件式技能（pi 风格），默认空目录，`use_skill` 只读加载。
5. 系统提示词按会话：`SYSTEM_{用户ID|群号}.md`，首次接触自动从 `SYSTEM_DEFAULT.md` 复制。
6. 会话控制：忙碌时新消息进入等待队列并自动回提示；`/stop` 立即中止 LLM；`/new`、`/stop` 等指令全部走系统层，永不进 LLM。

---

## 1. 已确认决策

| 决策项 | 结论 |
| --- | --- |
| 交付形态 | GitHub 公开仓库 + npm 包，**不在本机部署运行** |
| GitHub 仓库 | `Pheobe-Southwood/SnowLuma-agent`（公开；`gh` 已登录，`repo` 权限，无同名仓库） |
| npm 包名 | `snowluma-agent`（已确认 npm 空闲） |
| CLI 命令 | `snowluma-agent`（`bin` 指向 `dist/index.js`） |
| npm 发布 | **GitHub 先行**；npm 未登录，待用户 `npm adduser`/提供 `NPM_TOKEN` 后启用 publish workflow |
| 本地开发目录 | `/workspace/projects/github/snowluma-agent`（只写代码+推送，不安装不运行） |
| 群聊会话模型 | 每群可配置 `shared`（全群共享一个会话）或 `per-user`（群内按用户独立）；`shared` 可配置指令名白名单 |
| LLM Provider | 用户自配（anthropic / openai / openrouter / 自定义 OpenAI 兼容端点） |
| 回复发送时机 | **`message_end` 实时发送**（`replyMode` 可切 `batch`）；发送失败最多重试 3 次，仍失败则落盘 |
| MCP | 预留适配层，默认不启用任何服务器 |
| 媒体下载范围 | `image` / `file` / `record`（语音），`video` 可选 |
| Skills | 新增，pi 风格文件式，默认空 |
| 忙碌时新消息 | 进入等待队列（FIFO），自动回可配置提示，默认每条都提示 |
| `/stop` | 立即 `agent.abort()` 终止当前运行 + 清空队列 + 自动回执；与 `/new` 职责分离 |
| `/new` 忙碌时 | **等当前回答发完再重置**（标记 pendingReset，`agent_end` 时清空记忆+队列） |
| 指令识别 | `/` 开头即指令（系统层处理，不进 LLM）；`//` 转义为字面 `/`；指令绕过等待队列即时处理 |

---

## 2. 架构总览

```
QQ 消息 → SnowLuma 容器(OneBot WS 3001) → @snowluma/sdk
  → filter(白名单 / @识别)
  → commands(指令识别：/ 开头即指令，系统层处理，不进 LLM)
  → media(图片/文件/语音下载 → 占位文本)
  → sessions(会话路由 / 12h TTL / /new / 等待队列 + busy 状态机)
  → system_prompt(读取 SYSTEM_<id>.md)
  → pi Agent.prompt()          [pi-ai 多 provider | 可选 MCP 工具 | 内置 use_skill]
  → agent.subscribe(message_end) 提取 text 块(排除 thinking/toolcall)
  → sendPrivateMessage / sendGroupMessage → QQ
```

- Agent 跑在宿主机（用户机器）独立 Node.js 进程，连 `ws://127.0.0.1:3001`（可配）。
- 全程不走 MCP 发消息；MCP 仅用于"LLM 可调用的外部工具"（默认关）。
- 每个会话一个 `pi Agent` 实例 + 串行队列，防止并发打断流式循环。

---

## 3. 功能规格（需求映射）

### 3.1 pi 内核层

- 依赖：`@earendil-works/pi-agent-core`、`@earendil-works/pi-ai`、`@modelcontextprotocol/sdk`、`typebox`、`@snowluma/sdk`。
- Provider 配置（`config.json` + `.env`）：
  - `anthropicProvider()` / `openaiProvider()` / `openrouterProvider()`（pi-ai 子路径导入）。
  - 自定义 OpenAI 兼容端点：`createProvider({...}) + openAICompletionsApi()`（支持 baseUrl，可配中转/Ollama）。
  - API key 走 pi-ai 自动解析（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY` 等），或用 `models.complete(..., { apiKey })` 显式传。
- 每会话一个 Agent：

  ```ts
  new Agent({
    initialState: { systemPrompt, model, thinkingLevel, tools: buildTools(), messages: restoredMessages },
    streamFn: models.streamSimple.bind(models),
    beforeToolCall: safetyGate,   // 命中黑名单/未知工具 → { block: true, reason }
  })
  await agent.prompt(userText)    // 内置完整 LLM + 工具调用循环
  ```

- **默认禁用文件编辑/终端**：
  1. 内置工具表默认**空**（不注册任何 file/terminal 类 AgentTool）。
  2. MCP 工具转换时按黑名单过滤（`bash/terminal/shell/edit/write/read/execute/exec/filesystem/run/...`）。
  3. `beforeToolCall` 兜底拦截。

### 3.2 白名单与群聊模式（需求 I）

```jsonc
"whitelist": {
  "private": [10001, 10002],
  "groups": { "123456": { "mode": "at", "session": "shared" } },
  "defaultGroupMode": "at",        // "at" | "all"
  "defaultGroupSession": "shared"
}
```

- 私聊：`user_id` 不在 `private` → 忽略。
- 群聊：群不在 `groups` → 忽略；`at` 模式仅当消息段含 `{type:"at", data:{qq: self_id}}`（比对 `event.self_id`）才放行；`all` 模式全放行。
- 实现：`src/filter.ts`。

### 3.3 会话管理（需求 II）

- 会话键：私聊 `private:<uid>`；群共享 `group:<gid>`；群按用户 `group:<gid>:user:<uid>`。
- 持久化：使用版本化 envelope `{ schemaVersion, key, updatedAt, messages }` JSON 落盘 `data/sessions/<encoded-key>.json`（权限 600），重启恢复；systemPrompt 不落会话文件，每次处理消息前现读（见 3.6）。
- 会话文件采用同目录临时文件 + `rename` 原子替换写入；加载时校验 `schemaVersion` 和消息结构，损坏或不兼容的文件改名为 `.corrupt.<timestamp>` 后开启新会话。
- `updatedAt` 在白名单消息通过过滤并被接收时更新；12h 无消息 → 丢弃旧上下文自动开新会话。内存等待队列不持久化，进程重启后丢弃。
- 长会话按完整 prompt turn 剪枝：只删除最旧的完整 user/assistant/toolResult 组，不截断 assistant toolCall 与对应 toolResult；`maxMessages` 是目标上限，单个完整 turn 超过时保留该 turn。
- 每个会话由唯一 worker 串行调用 Agent；`agent_end` 订阅者只做收尾/持久化，不在回调内调用下一次 `agent.prompt()`。当前 `prompt()` 完成后由 worker 消费 FIFO 队列，避免 Agent 事件订阅重入。
- 每会话 busy 状态机 + 等待队列（见 3.9）。
- 实现：`src/sessions.ts`。

### 3.4 只透传"真正发出的文本"（需求 III）

- **默认 `replyMode: "realtime"`**：`agent.subscribe` 监听 **`message_end`**，当完成的消息是 assistant 消息且含 `type:"text"` 块时，立即拼接发送到 QQ（中间 turn 的文本 + 最终答案都实时出现）；这里的“实时”指每个 assistant 消息完成后发送，不做 token 级发送。
- 排除 `type:"thinking"` 与 `type:"toolCall"` 块；文本为空的 turn（纯工具调用）不发送。
- **`replyMode: "batch"`**：运行结束后按序批量发送所有 assistant 文本块（备选）。
- 当前版本不做 QQ 超长文本分片，文本分片能力延后到后续版本；本版本按原文发送，失败后按固定间隔再重试 3 次（首次发送失败后总计最多 4 次尝试），仍失败则放弃自动发送，将目标会话、目标 QQ、原文、时间和错误信息保存到 `data/failed-sends/`，不再后台自动重试。
- `agent_end` 之前已成功发送的文本不重复发送；abort/stop 后由当前运行 generation 标记抑制尚未发送的内容。
- 实现：`src/reply.ts`。
- 若 `message_end` 事件载荷不含完整消息，回退读取 `agent.state.streamingMessage` / 最后一条 assistant 消息（运行时以实测为准）。

### 3.5 媒体自动下载（需求 2）

- 触发段：`image` / `file` / `record`（语音）。
- 下载优先级链（动作返回结构官方未标注，**实现时用 SDK 枚举动作目录实测确认**）：
  1. 段内 `data.url` 直接宿主 `fetch` 下载；
  2. 无 url：`get_image` / `get_file` / `get_record`（record 支持 `out_format` 转码拿 base64）取 url/base64；
  3. 群文件：`get_group_file_url` 拿直链（动作名以运行时目录为准）；
  4. 可选容器卷兜底：仅当 `media.containerFallback.enabled=true` 且显式配置 `volumeName` 或 `hostDir` 时，才使用 `download_file` 落到容器 `data/downloads`，并检查指定卷的挂载点拷入本目录；默认不执行此步骤。
- 落盘：

  ```
  data/downloads/<encoded sessionKey>/<YYYYMMDD>/<messageId>_<seq>.<ext>
  ```

- `encoded sessionKey` 必须由完整会话键生成：群聊 `per-user` 使用 `group:<gid>:user:<uid>`，不得退化为仅群号，确保不同会话的媒体目录隔离。

- LLM 侧占位文本（可配模板）：
  - 图片 → `用户发来了一张图片，已保存到 <abs path>`
  - 文件 → `用户发来了一个文件，已保存到 <abs path>`
  - 语音 → `用户发来了一条语音，已保存到 <abs path>`
- 其余文本段原样保留喂给 LLM。
- 所有下载路径均失败时，向 QQ 自动发送一次可配置的 `downloadFailedNotice`，并将媒体转换为“媒体下载失败”的占位文本；不向 LLM 伪造一个不存在的本地路径。
- SnowLuma 容器卷兜底不是通用必需流程，仅在 `media.containerFallback.enabled=true` 且显式配置 `volumeName` 或 `hostDir` 时启用。只有启用时才允许调用 `docker volume inspect` 检查指定卷；默认不调用 Docker CLI。未启用或无法访问卷时按下载失败处理。
- 实现：`src/media.ts`。

### 3.6 按会话系统提示词（需求 3）

- 目录 `prompts/`（config `promptsDir`），含 **`SYSTEM_DEFAULT.md`**（`init` 时生成模板，可编辑）。
- 命名：私聊 `SYSTEM_<用户ID>.md`；群聊 `SYSTEM_<群号>.md`（群内 per-user 会话共用群的系统提示词文件）。
- 首次触发：某白名单用户/群**第一次**发来消息且文件不存在 → 自动 `cp SYSTEM_DEFAULT.md SYSTEM_<id>.md`（已存在不覆盖）。
- 首次复制使用排他创建/原子替换，避免多个并发首消息覆盖彼此；`SYSTEM_DEFAULT.md` 缺失时由 `init` 报错并拒绝启动。
- 生效：每次处理新消息前现读该文件，并更新复用中 Agent 的 `agent.state.systemPrompt`；编辑后下条消息即生效。群聊 `per-user` 会话继续共用 `SYSTEM_<群号>.md`。
- 实现：`src/system_prompt.ts`。

### 3.7 Skills 功能（需求 3 / 新增）

- 目录：`skills/<技能名>/SKILL.md`，YAML frontmatter（`name` + `description`），正文为技能内容，可附带同目录素材文件。
- 注入：启动时扫描技能目录，把 `name + description` 索引写入 systemPrompt；正文不预载（省上下文，对齐 pi 理念）。
- 工具：内置只读工具 **`use_skill(name)`** —— 读取该技能 `SKILL.md`（+ 素材清单）返回给 LLM；仅限技能目录内读取，不做任意文件读写（符合安全边界）。
- 默认空目录；`snowluma-agent skills list` 查看。
- 实现：`src/skills.ts`、`src/tools.ts`。

### 3.8 MCP 工具接入（预留）

- `src/mcp.ts`：用 `@modelcontextprotocol/sdk` 连接 stdio/streamable HTTP 服务器，`listTools()` → 映射为 `AgentTool[]`（JSON Schema → TypeBox；`execute` 调 `client.callTool`）。工具名统一命名为 `mcp__<serverId>__<toolName>`；内置工具保留 `builtin__` 命名空间，`use_skill` 为保留名，发现重复映射时启动失败，不静默覆盖。
- 过滤：黑名单 `blockedToolNames` + 每服务器 `allow` 列表；`beforeToolCall` 二次兜底。
- `mcp.servers` 默认 `[]`，预留接口，不默认启用。

### 3.9 等待队列（忙碌时新消息）

- 会话状态机 `idle ⇄ busy`，每会话一个 **FIFO 队列**。
- 处理顺序：白名单过滤 → 指令识别（见 3.11）→ 媒体立即落盘 → 若 `busy` 则入队并自动回提示，否则交给该会话唯一 worker 调用 `agent.prompt()`。
- 当前 `agent.prompt()` 完成（包括 `agent_end` 收尾订阅者完成）后，worker 从队首取下一条继续跑，直到队列空；不在 `agent_end` 订阅回调内部启动下一次 prompt。
- 提示：默认**每条排队都发**（`queue.notifyFirstOnly` 默认 `false`，可配 `true` 只提示首条）；`queueNotice` 支持 `{position}` 占位显示排队位置。
- `queue.maxLength` 默认 10，超限不入队并回 `queueFullNotice`。
- 媒体在入队**前**下载完成，保证排队消息的占位文本就绪。
- 实现：`src/sessions.ts`（队列与状态机）。

### 3.10 `/stop` 立即中止 LLM

- `busy` 时收到 `/stop`：调用 pi 的 **`agent.abort()`** 终止当前流式运行 → **清空排队消息** → 自动回 `stopNotice`（默认 `已停止`）。
- 中止后从 `agent.state.messages` 移除尾部 `stopReason==="aborted"` 的残留 assistant 消息，避免污染下次上下文。
- `reply.ts` 对 abort 的运行**不再发送**剩余内容（已按 `message_end` 实时发出的保留）。
- 空闲时 `/stop` → 回 `stopIdleNotice`（默认 `当前没有正在运行的对话`）。
- 与 `/new` 职责分离：`/stop` 只中止当前运行，不重置记忆；`/new` 只重置记忆，不中止运行。
- 实现：`src/agent.ts`（abort 与中止清理）、`src/reply.ts`。

### 3.11 指令层（永不进 LLM）

- 在 `filter` 之后、队列/Agent **之前**由 `src/commands.ts` 指令注册表拦截；全部系统自动响应，**不调用 LLM**。
- 识别规则：消息 trim 后按 `commandPrefix`（默认 `/`）判断——以 `/` 开头即视为指令；`//` 开头按字面 `/` 继续（转义，可把以 `/` 开头的正常文本喂给 LLM）。
- 指令行为：
  - `/new`：**忙碌时等当前回答发完再重置**——立即标记 `pendingReset` + 清空队列 + 回 `newSessionNotice`（默认 `已开启新会话`），`agent_end` 时执行清空；空闲时立即清空。
- `/stop`：见 3.10。
- 未知指令 → `unknownCommandNotice`（默认 `未知指令，可用：/new /stop`）。
- 指令**绕过等待队列**即时处理（保证 `/stop` 忙碌时也能响应）。
- 当群聊配置为 `session: "shared"` 时，可在该群配置 `commandAllowlist`；配置后只有列表中的指令名可执行，未列出的指令只返回 `commandNotAllowedNotice`，仍不进入 LLM。未配置时使用全局默认指令集合。该字段对 `per-user` 群聊不生效。
- 实现：`src/commands.ts`。

---

## 4. 项目结构

```
snowluma-agent/
├── package.json          # ESM, engines.node>=22, bin, exports, files(dist,assets)，运行依赖使用精确版本；GitHub 安装由 prepare 构建 dist
├── package-lock.json     # 锁定全部直接/间接依赖版本
├── tsconfig.json
├── LICENSE               # MIT
├── README.md             # 快速开始/配置/技能/媒体/安全/安装方式
├── .gitignore            # node_modules, dist, data, .env, ~/.snowluma-agent
├── src/
│   ├── cli.ts            # init / start / doctor / skills list / --version
│   ├── config.ts         # config.json + .env.example 生成/校验
│   ├── qq.ts             # @snowluma/sdk WebSocket 客户端（订阅+发送）
│   ├── filter.ts         # 白名单 / @识别
│   ├── commands.ts       # 指令注册表（/new /stop /未知指令，系统层处理）
│   ├── media.ts          # image/file/record 下载链 + 占位文本
│   ├── sessions.ts       # 会话路由 / 原子持久化 / 12h TTL / 等待队列 + busy 状态机 + session worker
│   ├── agent.ts          # pi Agent 生命周期（models/streamFn/beforeToolCall/abort）
│   ├── reply.ts          # message_end 实时提取 text 块并发送、失败重试/落盘 + 各类自动提示
│   ├── tools.ts          # 内置工具表（默认空 + 安全门）
│   ├── skills.ts         # 技能索引 + use_skill 工具
│   ├── mcp.ts            # MCP → AgentTool 适配（默认关）
│   └── system_prompt.ts  # SYSTEM_<id>.md 生成与现读
├── assets/
│   ├── SYSTEM_DEFAULT.md
│   └── systemd/snowluma-agent.service    # init 时按用户目录渲染
├── test/                 # vitest：filter/media/sessions/skills/事件过滤/12h TTL
├── docs/                 # 配置/技能/媒体/安全 说明
└── .github/workflows/
    ├── ci.yml            # typecheck + lint + test
    └── publish.yml       # 打 tag 触发：npm publish（有 NPM_TOKEN 才执行）+ GitHub Release（附 npm pack tarball）
```

---

## 5. CLI 设计

| 命令 | 说明 |
| --- | --- |
| `snowluma-agent init` | 在工作目录（默认 `~/.snowluma-agent`，`SNOWLUMA_AGENT_DIR` 可覆盖）生成 `config.json`、`.env.example`、`SYSTEM_DEFAULT.md`、`prompts/`、`skills/`、`data/`；`--systemd` 输出 systemd 单元 |
| `snowluma-agent start` | 加载配置、连接 SnowLuma OneBot WS、常驻运行 |
| `snowluma-agent doctor` | 校验 SnowLuma 连通性（`getLoginInfo`）、provider/模型可用性、目录权限 |
| `snowluma-agent skills list` | 列出已安装技能索引 |
| `snowluma-agent --version` | 版本号 |

---

## 6. 配置说明

`config.json`（`init` 生成，用户编辑）：

```jsonc
{
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001/",
    "accessToken": "<从 SnowLuma onebot_*.json 读取>"
  },
  "llm": {
    "provider": "anthropic",   // anthropic | openai | openrouter | custom
    "model": "claude-sonnet-4-6", // 与锁定的 pi-ai 模型目录一致，用户可改
    "thinkingLevel": "medium", // off/minimal/low/medium/high/xhigh/max
    "baseUrl": null,           // 自定义 OpenAI 兼容端点时填写
    "apiKeyEnv": "ANTHROPIC_API_KEY"
  },
  "whitelist": {
    "private": [],
    "groups": {
      "123456": { "mode": "at", "session": "shared", "commandAllowlist": ["new", "stop"] }
    },
    "defaultGroupMode": "at",
    "defaultGroupSession": "shared"
  },
  "session": {
    "inactivityTtlHours": 12,
    "maxMessages": 60,
    "storageDir": "<dir>/data/sessions"
  },
  "media": {
    "downloadsDir": "<dir>/data/downloads",
    "autoDownload": ["image", "file", "record"],
    "downloadFailedNotice": "媒体下载失败，请稍后重试",
    "containerFallback": {
      "enabled": false,
      "volumeName": null,
      "hostDir": null
    },
    "placeholder": {
      "image": "用户发来了一张图片，已保存到 %s",
      "file": "用户发来了一个文件，已保存到 %s",
      "record": "用户发来了一条语音，已保存到 %s"
    }
  },
  "promptsDir": "<dir>/prompts",
  "reply": {
    "mode": "realtime",               // realtime | batch
    "queueNotice": "消息已进入等待队列，我会在处理完当前消息后回复你{position}",
    "queueFullNotice": "消息队列已满，请稍后再试",
    "stopNotice": "已停止",
    "stopIdleNotice": "当前没有正在运行的对话",
    "newSessionNotice": "已开启新会话",
    "unknownCommandNotice": "未知指令，可用：/new /stop",
    "commandNotAllowedNotice": "当前群聊未启用该指令",
    "failedSendDir": "<dir>/data/failed-sends"
  },
  "commandPrefix": "/",
  "queue": { "maxLength": 10, "notifyFirstOnly": false },
  "skillsDir": "<dir>/skills",
  "mcp": { "servers": [] },           // 预留，默认关
  "blockedToolNames": ["bash","terminal","shell","edit","write","read","execute","exec","filesystem","run"]
}
```

`.env`（权限 600）：`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` 等，按 `llm.apiKeyEnv` 指向。

---

## 7. 安全设计

- `.env`、会话文件、下载目录默认 `600/700`。
- 内置工具表为空：文件编辑、终端默认不存在。
- MCP 工具黑名单 + `beforeToolCall` 双层拦截。
- `use_skill` 仅读技能目录。
- 下载目录按会话隔离；仅接受白名单来源的媒体。
- 不硬编码任何本机 token/密钥；用户自配。

---

## 8. 安装与发布方式

```bash
# 方式A：npx 直接跑（无需全局安装）
npx github:Pheobe-Southwood/SnowLuma-agent start

# 方式B：全局安装
npm i -g github:Pheobe-Southwood/SnowLuma-agent
snowluma-agent init && snowluma-agent start

# 方式C：npm 正式版（用户 npm adduser 后）
npm i -g snowluma-agent
```

发布流程：

1. 本地开发 `/workspace/projects/github/snowluma-agent`。
2. `gh repo create Pheobe-Southwood/SnowLuma-agent --public` → push。
3. CI（typecheck/lint/test）全绿。
4. 打 `v0.1.0` tag → `publish.yml`：有 `NPM_TOKEN` 则 `npm publish`，同时打 GitHub Release 附 `npm pack` tarball。
5. systemd 模板随包提供（`init --systemd` 渲染）。

---

## 9. 实施步骤

1. 建目录 + `git init`；写 `package.json`（deps：pi-agent-core、pi-ai、@snowluma/sdk、@modelcontextprotocol/sdk、typebox、dotenv；devDeps：tsup、tsx、typescript、vitest、@types/node、固定版本的 lint 工具），所有直接依赖锁定精确版本并提交 `package-lock.json`，不使用 `^`/`~` 范围；配置 `prepare`/`prepack` 确保 GitHub 安装和 npm 发布均包含 `dist`。
2. 实现 `config.ts` / `cli.ts`（init/start/doctor/skills list）。
3. 实现 `qq.ts` + `filter.ts` + `sessions.ts`（含 busy 状态机与等待队列）+ `commands.ts`（/new /stop 指令注册表）。
4. 实现 `agent.ts` + `reply.ts`（`message_end` 实时发送、发送失败最多重试 3 次后落盘、`agent.abort()` 中止与 aborted 消息清理、各类自动提示）。
5. 实现 `system_prompt.ts` + `skills.ts` + `tools.ts`。
6. 实现 `media.ts`（按锁定版 SDK 类型和官方文档确认 `get_image/get_file/get_record/get_group_file_url/download_file` 返回结构，必要时保留回退；不在本机安装或运行验证，实机联调由用户完成）。
7. 实现 `mcp.ts`（预留）。
8. 单测：filter/media 占位文本与下载失败提示/sessions 12h TTL 与 /new/原子持久化/损坏会话恢复/等待队列入队出队与队列满/`/stop` 中止与清队/忙碌时 `/new` 延迟重置/`//` 转义/指令不进 LLM（mock 断言 prompt 未调用）/shared 群聊指令白名单/message_end 文本提取排除 thinking-toolcall/失败发送 3 次重试后落盘/skills 索引与 use_skill。
9. 生成构建与 CI 配置；由 CI 执行 `typecheck`、`test`、`lint` 和 `npm pack --dry-run`，本机不安装、不运行、不做验证。
10. 写 README/docs/LICENSE/systemd 模板。
11. CI + publish workflow。
12. `gh repo create` → push → CI → 打 tag 发布；发布前仅按锁定版本和官方 API 文档做理论兼容性检查，不在本机安装或运行验证。

---

## 10. 验证

- 仓库 CI 全绿（typecheck/lint/test）。
- 单元测试覆盖：白名单/@识别、媒体占位文本与目录分层、下载失败提示、会话 12h TTL 与 `/new`、原子持久化与损坏文件恢复、`message_end` 实时文本提取（排除 thinking/toolcall）、skills 索引与 `use_skill`、`replyMode: batch` 备选路径、等待队列入队/出队顺序与队列满提示、`/stop` 中止+清队、忙碌时 `/new` 延迟重置、`//` 转义、shared 群聊指令白名单、指令调用时 `agent.prompt` 未被触发、发送失败 3 次重试后落盘。
- 另外验证 `containerFallback` 默认关闭，且只有显式配置时才调用 `docker volume inspect`；群聊 `per-user` 使用完整 session key 隔离媒体目录。
- 实机 QQ 联调：由用户在安装包内自行完成（`doctor` + 白名单私聊/群聊 @ 实测、图片/文件/语音下载、`SYSTEM_<id>.md` 生成、12h 会话回收）。

---

## 11. 风险与待实测项

| 项 | 说明 | 应对 |
| --- | --- | --- |
| SnowLuma 扩展动作返回结构未文档化（`get_image/get_file/get_record/download_file/get_group_file_url`） | 官方 API 页标注"data 结构待补充" | 实现时用 SDK 枚举动作目录 + 实机探测，优先级链回退 |
| 图片 url 可能需要 QQ cookie/rkey 才能匿名下载 | qzone URL 常需鉴权 | 实测；失败则走 `download_file`/`get_image` url，必要时 `get_rkey` |
| `message_end` 事件载荷是否含完整消息对象 | README 未标注 | 回退读取 `agent.state` 最后一条 assistant 消息 |
| `agent.abort()` 后 `message_end`/事件流行为 | abort 时事件序列与部分消息状态未文档化 | 中止后以 `stopReason==="aborted"` 判定并清理尾部消息，抑制剩余发送；实测确认 |
| npm 发布依赖登录 | 本机未登录 | GitHub 方式先行；`NPM_TOKEN` 就绪后启用 publish |
| pi-ai 模型 ID 随版本变化 | 模型目录可能随依赖版本变化 | 依赖和模型目录锁定版本，发布前按官方 API 做理论兼容性检查；用户仍可配置模型 ID |

---

## 12. 参考文档

### pi（内核）

| 文档 | 用途 |
| --- | --- |
| <https://github.com/earendil-works/pi/tree/main/packages/agent> | `@earendil-works/pi-agent-core`：Agent 构造参数（initialState/streamFn/beforeToolCall/afterToolCall/transformContext/thinkingBudgets）、事件模型（agent_start/end、turn_start/end、message_start/update/end、tool_execution_*）、AgentTool 定义、steering/follow-up、低层 agentLoop |
| <https://github.com/earendil-works/pi/tree/main/packages/ai> | `@earendil-works/pi-ai`：createModels/provider 工厂、流式事件（start/text_*/thinking_*/toolcall_*/done/error）、Message/Context 结构（thinking/toolCall 块）、上下文 JSON 序列化、thinking 级别与 provider 专属选项 |
| <https://github.com/earendil-works/pi/tree/main/packages/ai/README.md> | 同上（完整 1308 行版） |
| <https://pi.dev> | pi 官方站点：明确"No MCP"，MCP 需扩展/自研适配层 |
| <https://www.npmjs.com/package/@earendil-works/pi-coding-agent> | pi 生态与扩展（skills 概念来源，供 skills 设计对齐） |
| <https://github.com/nicobailon/pi-mcp-adapter> | 第三方 pi MCP 适配器（参考 mcp 工具代理/直接工具设计思路） |

### SnowLuma

| 文档 | 用途 |
| --- | --- |
| <https://snowluma.github.io/guide/developer.html> | Monorepo 结构、OneBot 生命周期、SDK 包说明 |
| <https://snowluma.github.io/sdk.html> | `@snowluma/sdk`：`SnowLumaWebSocketClient`/`SnowLumaHttpClient`、`onGroupMessage`/`onPrivateMessage`/`command`、`ctx.reply`、消息构建器 `text()/at()/reply()`、自动重连、错误模型 |
| <https://snowluma.github.io/api/index.html> | OneBot v11 兼容动作目录（179 个动作，分类） |
| <https://snowluma.github.io/api/message/index.html> | 消息动作：`send_private_msg` / `send_group_msg` / `send_msg` / `get_msg` / `delete_msg` |
| <https://snowluma.github.io/api/extended/index.html> | 扩展动作目录：`get_image` / `get_file` / `get_record` / `download_file` / `download_file_stream` / `download_file_image_stream` / `get_group_file_url`（get_file 页注明群文件用此动作）/ `get_rkey` / `ocr_image` |
| <https://snowluma.github.io/api/extended/get_image.html> | 获取图片信息（参数 `file`/`file_id`；返回结构待实测） |
| <https://snowluma.github.io/api/extended/get_file.html> | 获取文件信息（仅图片/语音缓存；群文件用 get_group_file_url） |
| <https://snowluma.github.io/api/extended/download_file.html> | 下载文件（url 或 base64）到容器 data/downloads，返回 `{ file }` |
| <https://snowluma.github.io/mcp.html> | `@snowluma/mcp`：仅作对照——本项目**不走 MCP 发消息**，用 SDK 直连 OneBot WS |
| <https://github.com/SnowLuma/SnowLuma> | 主仓 README：能力矩阵（OneBot v11、多账号、SDK/MCP） |
| <https://github.com/botuniverse/onebot-11/blob/master/message/segment.md> | OneBot v11 消息段规范：image（file/url）、record、file 等段字段定义 |

### 本机现状（调研记录，不入库）

- 本机 SnowLuma 容器 `snowluma`（Up），OneBot HTTP `127.0.0.1:3000`、WS `127.0.0.1:3001`（宿主可达），array 消息格式。
- 容器内访问令牌：HTTP/WS 各自独立（见容器 `config/onebot_<uin>.json`）；运行时从用户自己环境读取，不硬编码。
- 宿主 node v22.22.1（满足 SDK `>=22`）、npm 9.2.0；`gh` 已登录 `Pheobe-Southwood`（repo 权限）。
- 本机 `~/.snowluma` 等仅为调研样例；本项目不读取/依赖本机实例。

---

*本文档为最终计划，批准后按"第 9 节 实施步骤"执行；执行范围不含本机安装运行。*
