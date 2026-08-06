# 部署与开机自启

本文说明如何让 SnowLuma 和 Agent 在 Linux 主机上开机自动运行。

## SnowLuma 容器

Docker 服务应设置为开机启动，SnowLuma Compose 服务使用：

```yaml
restart: unless-stopped
```

检查状态：

```bash
systemctl is-enabled docker.service
docker inspect -f '状态={{.State.Status}} 重启策略={{.HostConfig.RestartPolicy.Name}}' snowluma
```

如果输出为 `enabled`、`running` 和 `unless-stopped`，SnowLuma 会在 Docker 启动后自动恢复。

## Agent systemd 服务

将以下内容保存为 `/etc/systemd/system/snowluma-agent.service`：

```ini
[Unit]
Description=SnowLuma Agent
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/.snowluma-agent
ExecStart=/root/.npm-global/bin/snowluma-agent start --dir /root/.snowluma-agent
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

加载并启用：

```bash
systemctl daemon-reload
systemctl enable --now snowluma-agent.service
```

验证：

```bash
systemctl is-enabled snowluma-agent.service
systemctl is-active snowluma-agent.service
journalctl -u snowluma-agent.service -f
```

## 更新

从 GitHub 更新：

```bash
npm install -g github:Pheobe-Southwood/SnowLuma-agent --prefix /root/.npm-global
systemctl restart snowluma-agent.service
```

更新不会覆盖 `/root/.snowluma-agent/config.json`、`.env`、会话和媒体数据。

## 修改配置

编辑配置后重启服务：

```bash
vi /root/.snowluma-agent/config.json
systemctl restart snowluma-agent.service
```

修改 API key：

```bash
vi /root/.snowluma-agent/.env
chmod 600 /root/.snowluma-agent/.env
systemctl restart snowluma-agent.service
```

## 卸载

只移除 Agent 自启和全局 CLI：

```bash
systemctl disable --now snowluma-agent.service
rm /etc/systemd/system/snowluma-agent.service
systemctl daemon-reload
npm uninstall -g snowluma-agent --prefix /root/.npm-global
```

上述命令不会删除 `/root/.snowluma-agent`。确认不再需要配置、会话、媒体和备份后，再手动删除运行目录。
