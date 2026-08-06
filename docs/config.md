# 配置说明

配置目录默认为 `~/.snowluma-agent`，也可以通过 `SNOWLUMA_AGENT_DIR` 指定。`snowluma-agent init` 会生成基础配置文件。

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

```json
"whitelist": {
  "private": [10001, 10002],
  "groups": {
    "123456": {
      "mode": "at",
      "session": "shared",
      "commandAllowlist": ["new", "stop"]
    }
  },
  "defaultGroupMode": "at",
  "defaultGroupSession": "shared"
}
```

- `private` 是允许使用机器人的 QQ 号列表。
- `groups` 是允许使用机器人的群号配置。
- `mode` 可选 `at` 或 `all`，默认是 `at`。
- `session` 可选 `shared` 或 `per-user`。
- `commandAllowlist` 仅对共享群聊会话生效。

未列入白名单的消息会被忽略，不会调用 LLM。

群聊普通消息发送给 LLM 前会自动添加 `[发送者QQ号: <user_id>] ` 前缀，便于共享群聊会话区分不同发送者。消息开头的机器人 @ 会被移除；私聊消息和 `/new`、`/stop` 等系统命令不添加该前缀。

## 路径与会话

会话、媒体和失败发送记录默认保存在 `~/.snowluma-agent/data` 下。可以在配置中修改以下路径：

- `session.storageDir`：会话文件。
- `media.downloadsDir`：媒体文件。
- `reply.failedSendDir`：发送失败记录。
- `promptsDir`：按用户或群组区分的系统提示词。
- `skillsDir`：Skills 目录。

路径应指向 Agent 用户有权限访问的目录，不要指向包含其他用户敏感数据的目录。
