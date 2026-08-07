# 安全边界

## 消息访问控制

- 未配置白名单的私聊和群聊会被忽略。
- 群聊默认要求消息中 @ 机器人。
- `/new` 和 `/stop` 在系统层执行，不会发送给 LLM。
- `//` 可将以 `/` 开头的普通文本转义后发送给 LLM。

## 工具访问控制

- 内置工具默认为空，不提供任意文件读写或终端执行能力。
- MCP 默认关闭；启用后按服务器 `allow` 列表筛选工具。
- MCP 工具名使用 `mcp__<服务器标识>__<工具名>` 格式。
- 工具还会经过危险名称黑名单和二次安全拦截。
- `use_skill` 只能读取 `skills/<技能名>/SKILL.md` 及其允许的技能资源。

## 密钥与 token

- SnowLuma token 和 LLM API key 都是敏感信息，不要提交到 GitHub、日志或工单。
- `config.json` 和 `.env` 建议设置为 `600`，配置目录建议设置为 `700`。
- 备份配置文件时，备份同样包含敏感信息，也必须限制权限。
- 更换 token 后应立即重启 Agent，并撤销旧 token。
- `SNOWLUMA_ACCESS_TOKEN` 可用于临时注入 token，适合诊断或一次性运行。

## 文件与会话

- 会话文件使用同目录临时文件和原子替换写入。
- 损坏的会话文件会被改名为 `.corrupt.<timestamp>`，不会直接覆盖。
- 媒体只从通过白名单过滤的消息中下载。
- 媒体、会话和失败发送记录按会话目录隔离；每个会话的 `config.json`、`.env` 和 `prompt.md` 存放在各自的 `conversations/<群号|QQ号>/` 文件夹中。
- 会话 `.env` 默认只复制全局 `.env` 中 `llm.apiKeyEnv` 对应的密钥；不要复制多余密钥。
- 不要把运行目录 `~/.snowluma-agent` 复制到公开仓库。

## 部署建议

- 使用专用系统用户运行 Agent；如果必须使用 root，请严格限制配置文件权限。
- systemd 服务应通过 `Restart=on-failure` 自动恢复，并使用 `journalctl` 查看日志。
- SnowLuma 的 Web UI 如需局域网访问，应单独配置防火墙和访问控制；OneBot WebSocket 建议只绑定宿主机回环地址。
