# SnowLuma Agent

一个基于 [pi](https://github.com/earendil-works/pi) 的 SnowLuma QQ AI Agent。它通过 OneBot WebSocket 接收白名单消息，调用可配置的 LLM，并将最终文本回复发送回 QQ。

## 功能

- 对接 SnowLuma OneBot WebSocket。
- 支持私聊和群聊白名单；群聊默认只处理 @ 机器人的消息。
- 支持 `/new` 开启新会话、`/stop` 中止当前回答。
- 会话按用户或群组持久化，并支持超时清理和忙碌消息队列。
- 自动下载图片、文件和语音，并将本地路径作为上下文提供给 LLM。
- 支持 pi 的多种模型提供商：Anthropic、OpenAI、OpenRouter、DeepSeek 和自定义 OpenAI 兼容接口。
- 预留 MCP 和文件式 Skills 接口，默认不启用危险的文件或终端工具。
- 支持 `doctor` 检查 SnowLuma 和 LLM 连通性。

## 环境要求

- Node.js 22 或更高版本。
- 已登录并运行的 SnowLuma，且已启用 OneBot WebSocket 服务。
- 能访问所选 LLM 服务的 API。

## 安装

### 从 npm 安装（推荐）

当前已发布版本为 `0.1.2`：

```bash
npm install -g snowluma-agent
snowluma-agent --version
```

如果使用 root 用户并希望与本机其他全局 npm 软件保持一致：

```bash
mkdir -p /root/.npm-global
npm install -g snowluma-agent --prefix /root/.npm-global
export PATH="/root/.npm-global/bin:$PATH"
snowluma-agent --version
```

### 从 GitHub 安装开发版本

需要直接安装 GitHub `main` 分支时：

```bash
npm install -g github:Pheobe-Southwood/SnowLuma-agent --prefix /root/.npm-global
export PATH="/root/.npm-global/bin:$PATH"
snowluma-agent --version
```

更新时重复执行安装命令即可。卸载 CLI 不会自动删除运行数据。

安装目录、运行目录和配置文件可以分开管理：

- CLI 程序：`/root/.npm-global/`
- Agent 配置与运行数据：`/root/.snowluma-agent/`
- systemd 服务：`/etc/systemd/system/snowluma-agent.service`

## 初始化与配置

```bash
snowluma-agent init
cp ~/.snowluma-agent/.env.example ~/.snowluma-agent/.env
chmod 600 ~/.snowluma-agent/.env
```

编辑 `~/.snowluma-agent/config.json`，至少配置 SnowLuma 地址、访问 token、QQ 白名单和 LLM：

```json
{
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001/",
    "accessToken": "从 SnowLuma OneBot 配置中取得的 token"
  },
  "llm": {
    "provider": "deepseek",
    "model": "deepseek-v4-flash",
    "thinkingLevel": "medium",
    "baseUrl": null,
    "apiKeyEnv": "DEEPSEEK_API_KEY"
  },
  "whitelist": {
    "private": [10001],
    "groups": {
      "123456": {
        "mode": "at",
        "session": "shared"
      }
    },
    "defaultGroupMode": "at",
    "defaultGroupSession": "shared"
  }
}
```

API key 放在 `.env` 中，不要写入 Git：

```dotenv
DEEPSEEK_API_KEY=你的 DeepSeek API key
```

SnowLuma token 通常位于容器内的 OneBot 配置文件 `snowluma-data/config/onebot_*.json` 的 `networks.wsServers[].accessToken` 字段。将它填入 `config.json` 的 `snowluma.accessToken`，不要把真实 token 粘贴到 GitHub、公开聊天或日志中。也可以保留为 `null`，启动时使用环境变量临时注入。

配置完成后，建议先检查文件权限：

```bash
chmod 700 ~/.snowluma-agent
chmod 600 ~/.snowluma-agent/config.json ~/.snowluma-agent/.env
```

也可以通过 `SNOWLUMA_ACCESS_TOKEN` 临时覆盖配置文件中的 token。完整配置说明见 [`docs/config.md`](docs/config.md)。

## 检查与运行

先检查 SnowLuma 连接和 API key 配置：

```bash
snowluma-agent doctor
```

需要实际调用一次模型时：

```bash
snowluma-agent doctor --llm
```

前台运行：

```bash
snowluma-agent start
```

如果需要后台运行和开机自启，先执行 `snowluma-agent init --systemd` 生成参考服务文件，再按照 [`docs/deployment.md`](docs/deployment.md) 安装系统级服务。

## 可复制给其他 AI 的安装提示词

下面的提示词可以直接复制给有本机终端权限的 AI。执行前请把方括号中的内容替换成自己的值；不要把真实 API key 或 token 写进提示词后发送到不可信的服务。

```text
请帮我在这台 Linux 主机上安装、配置并验证 SnowLuma Agent。

项目仓库： https://github.com/Pheobe-Southwood/SnowLuma-agent.git
Node.js 要求：22 或更高版本
CLI 安装目录：/root/.npm-global
Agent 运行目录：/root/.snowluma-agent
SnowLuma WebSocket：ws://127.0.0.1:3001/

请严格遵守以下要求：
1. 先只读检查系统、Node.js/npm、Docker、SnowLuma 容器、现有配置和 systemd 状态；不要盲目覆盖已有配置。
2. 可以安装缺少的前置依赖，但所有文件安装到合适的目录，CLI 使用 /root/.npm-global，运行数据使用 /root/.snowluma-agent。
3. 先备份已有 config.json、.env 和 systemd 服务，再进行修改；不要删除会话、媒体、日志或其他运行数据。
4. 不要在终端输出、日志、Git 提交或聊天回复中显示 SnowLuma token、LLM API key 或完整的敏感配置。
5. 不要把 /root/.snowluma-agent、.env、真实 token 或真实 API key 提交到 GitHub。
6. 如果需要配置 LLM provider、model 或 API key，请先停下来告诉我需要哪些值，等待我确认后再写入；没有得到确认时不要猜测或调用模型。
7. 只有在配置确认后，才运行 doctor；doctor --llm 会产生一次真实模型请求，执行前先明确告诉我。
8. SnowLuma 如果运行在 Docker 中，确认 Docker 已开机自启、容器使用 restart: unless-stopped，并确认 OneBot WebSocket 可从宿主机访问。
9. Agent 使用系统级 systemd 服务开机自启，服务应在 Docker 之后启动，失败自动重启；不要只创建依赖登录会话的 user service。
10. 所有修改完成后，运行类型检查、测试、doctor 和服务状态检查，并报告实际结果和可回滚方式。

已确认或待我提供的业务配置：
- LLM provider：[例如 deepseek]
- LLM model：[例如 deepseek-v4-flash]
- LLM API key 环境变量名：[例如 DEEPSEEK_API_KEY]
- LLM API key：不要在没有安全确认前自行索取或打印
- SnowLuma access token：从本机 SnowLuma 配置读取，或由我安全提供
- 允许的私聊 QQ 号：[填写 QQ 号]
- 允许的群号：[填写群号]
- 群聊模式：at（仅 @ 机器人）
- 群聊会话：shared（全群共享）或 per-user（按发送者区分）

完成后请告诉我：
- 安装目录和运行目录
- 配置文件位置及权限（不要显示密钥内容）
- doctor 和 doctor --llm 是否通过
- systemd 服务名称、enabled/active 状态
- 日后修改 API key、更新、停止和完整卸载的命令
```

## 开机自启

SnowLuma 容器应使用 Docker 的 `restart: unless-stopped`。Agent 可以使用系统级 systemd 服务开机启动。部署、日志、更新和卸载方法见 [`docs/deployment.md`](docs/deployment.md)。

## 白名单与群聊模式

- `whitelist.private`：允许使用机器人的 QQ 号列表。
- `whitelist.groups`：允许使用机器人的群号及群聊策略。
- `mode: "at"`：只有 @ 机器人时处理。
- `mode: "all"`：群内所有消息都处理。
- `session: "shared"`：群共享一个会话。
- `session: "per-user"`：群内每个用户使用独立会话。

未加入白名单的私聊和群聊会被忽略。

群聊消息发送给 LLM 前会自动添加发送者标识，例如：

```text
[发送者QQ号: 123456] 请帮我查一下天气
```

如果消息以 @ 机器人开头，发送给 LLM 的文本会移除这个开头的 @ 和其后的空白；其他用户的 @ 和消息中间的 @ 会保留。系统命令不会添加发送者标识，因此 `@机器人 /new` 可以直接重置当前群聊会话。

## 安全说明

默认不注册文件编辑、任意文件读取或终端工具；MCP 服务器默认为空。token 和 API key 都属于敏感信息，配置文件和 `.env` 应限制为仅文件所有者可读。更多说明见 [`docs/security.md`](docs/security.md)。

## 开发

```bash
npm install
npm run check
npm run build
npm pack --dry-run
```

`npm run check` 会执行类型检查、代码检查和测试。上游 pi 源码仅用于 API 对照，发布包不包含本机源码或运行数据。

## 许可证

[项目 MIT 许可证](LICENSE)

pi 依赖及其许可证说明见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
