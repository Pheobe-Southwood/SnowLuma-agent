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

从 GitHub 安装最新版本：

```bash
npm install -g github:Pheobe-Southwood/SnowLuma-agent --prefix /root/.npm-global
export PATH="/root/.npm-global/bin:$PATH"
snowluma-agent --version
```

如果之后发布到 npm，也可以直接安装：

```bash
npm install -g snowluma-agent
```

更新时重复执行安装命令即可。卸载 CLI 不会自动删除运行数据。

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

[MIT License](LICENSE)
