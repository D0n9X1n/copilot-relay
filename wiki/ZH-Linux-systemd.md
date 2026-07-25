# Linux：systemd 用户服务

推荐使用 `systemd --user`。它在登录时启动，进程退出时自动拉起，并且以你自己的身份运行
—— 因此使用的是你的 `~/.copilot-relay` 令牌缓存，而不是另一份。

## 一次性准备

```sh
npm install -g copilot-relay@latest
copilot-relay auth
command -v copilot-relay
```

## 创建用户服务

```sh
mkdir -p ~/.config/systemd/user
RELAY_BIN="$(command -v copilot-relay)"

cat > ~/.config/systemd/user/copilot-relay.service <<EOF
[Unit]
Description=copilot-relay for Claude Code
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=${RELAY_BIN} start
WorkingDirectory=%h
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
EOF
```

`copilot-relay start` 在**前台**运行并处理 `SIGTERM`，所以 `Type=simple` 是正确的。
不要加 `&` 或 `nohup` —— systemd 会把立刻退出当成失败，从而无限重启。

### 为什么用 `on-failure` 而不是 `always`

这里有三项设置是关键，而大多数教程使用的默认值对这个服务来说都是错的。

**`Restart=on-failure`** 只在非零退出时重启。用 `Restart=always` 的话，systemd 在正常
关闭后也会重启 —— 于是 `copilot-relay stop` 看起来毫无作用，因为 systemd 立刻又把它
拉了起来。参见[停止](#停止)。

**`RestartSec=30`** 限制重试频率。relay 启动时会校验上游 Copilot 访问，失败则 `exit(1)`。
开机时网络通常还没就绪，所以第一次尝试失败是正常的。`RestartSec=5` 意味着对着一个还不
存在的网络每分钟重试十二次。

**`StartLimitIntervalSec=300` + `StartLimitBurst=5`** 直接终止这种循环：5 分钟内失败超过
5 次，unit 进入 `failed`，systemd 不再重试。这把一个看不见的循环变成了一个能被发现、能
被诊断的状态。

`After=network-online.target` 只保证启动顺序，不保证网络真的可达，所以重试策略仍然有用。

## 启用并启动

```sh
systemctl --user daemon-reload
systemctl --user enable --now copilot-relay.service
```

修改 unit 文件后要先 `daemon-reload` 再 `restart`，否则 systemd 用的还是旧定义。

## 登录前就启动

`--user` 服务默认在登录时启动、注销时停止。要让 relay 在无人登录的机器上持续运行，或
跨注销存活：

```sh
sudo loginctl enable-linger "$USER"
```

## 如何确认它真的能用

### 最快的办法

```sh
copilot-relay status
```

```text
copilot-relay 0.2.5
  process    running (pid 93744, up 1h 16m)
  listening  http://127.0.0.1:4142
  health     ok (9ms)
  models     gpt-5.6-sol[1m], claude-opus-5
  upstream   not checked (use --deep)
  log        ~/.copilot-relay/logs/copilot-relay.2026-07-25.log
  config     ~/.copilot-relay/config.yaml (logLevel=info, thinkEffort=max)
```

加上 `--deep` 会额外发一个真实请求经由 Copilot 走一遍 —— 这是唯一能证明 relay 真的可以
为 Claude Code 服务的检查。它会消耗少量 token，所以默认不做：

```sh
copilot-relay status --deep
```

```text
  upstream   ok (1191ms) — end-to-end Copilot round trip
```

退出码便于脚本使用：`0` 运行中，`1` 未运行，`2` 运行中但 `--deep` 失败。`--json` 输出
机器可读格式。因此它可以直接写进 unit 文件：

```ini
ExecStartPost=/usr/bin/env copilot-relay status
```

### 手动执行这三层

`status` 已经替你跑了这三层。理解它们仍然有价值，因为**前两层在一个根本无法处理任何请求
的 relay 上也会通过** —— 在没有装 CLI 的机器上排查时也用得上。

### 第一层 —— 进程还活着吗？

```sh
systemctl --user status copilot-relay.service
curl -s http://127.0.0.1:4142/healthz
```

期望 `active (running)` 和 `{"ok":true}`。这个接口是静态处理器：它只能证明有个端口在
监听，别的什么都证明不了，完全不会访问 GitHub Copilot。

### 第二层 —— 配置解析和模型路由正常吗？

```sh
curl -s http://127.0.0.1:4142/v1/models
```

期望看到你配置的模型，例如 `gpt-5.6-sol[1m]` 和 `claude-opus-5`。结果直接来自配置，
**同样不访问上游**。一个 Copilot 令牌一小时前就过期的 relay，前两层照样通过。

### 第三层 —— 端到端

```sh
curl -s -X POST http://127.0.0.1:4142/v1/messages \
  -H "content-type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"gpt-5.6-sol","max_tokens":16,
       "messages":[{"role":"user","content":"Reply with the single word: ok"}]}'
```

返回 `200`，带 `content` 和非零 `usage`，说明整条链路都是通的：配置、令牌刷新、Copilot
调用，以及转换回 Claude 格式。**只有这一层能证明 relay 真的可以为 Claude Code 服务。**
它会消耗少量 token。

如果前两层通过而第三层失败，问题在鉴权或上游，不在 unit 文件 —— 执行
`copilot-relay auth` 并查看当天日志。

### 查看日志

systemd 把标准输出收进 journal，relay 自己也会写轮转日志文件。启动失败看 journal，请求
历史看日志文件。

```sh
journalctl --user -u copilot-relay.service -n 100 --no-pager
journalctl --user -u copilot-relay.service -f

tail -f ~/.copilot-relay/logs/copilot-relay.$(date +%F).log
```

日志按天轮转，文件名带本地日期。要搜索所有保留的日期，用通配符：

```sh
grep -n "Startup preflight failed" ~/.copilot-relay/logs/copilot-relay.*.log
```

## 停止

现在停止，下次登录时再启动：

```sh
systemctl --user stop copilot-relay.service
```

现在停止，并且以后登录也不再启动：

```sh
systemctl --user disable --now copilot-relay.service
```

重启：

```sh
systemctl --user restart copilot-relay.service
```

### `copilot-relay stop` 与 systemd 的关系

`copilot-relay stop` 会直接找到并终止 relay 进程。它是正常退出，所以在
`Restart=on-failure` 下 systemd 不会再拉起 —— 命令行和守护进程的行为是一致的。

如果用 `Restart=always`，systemd 会在 `RestartSec` 之后重启它，看起来就像命令行没生效。
出现这种情况说明你的 unit 还是旧的。

不论用哪种守护方式，确认 relay 确实没了：

```sh
copilot-relay stop
ss -ltnp 'sport = :4142'   # 应该没有 LISTEN 行
```

### 彻底移除

```sh
systemctl --user disable --now copilot-relay.service
rm ~/.config/systemd/user/copilot-relay.service
systemctl --user daemon-reload
```

## 排查

**`failed` 且提示 `start-limit-hit`。** 5 分钟内失败超过 5 次，systemd 主动放弃了 ——
这是设计如此。先修掉根因，再清除这个状态：

```sh
systemctl --user reset-failed copilot-relay.service
systemctl --user start copilot-relay.service
```

在你手动执行之前，它不会自己重试。

**反复出现 `status=1`。** 启动前校验在失败：鉴权过期或没有网络。看 `journalctl` 和当天
日志，然后执行 `copilot-relay auth`。

**注销后服务就没了。** 需要开启 linger：`sudo loginctl enable-linger "$USER"`。

**unit 里 `command -v copilot-relay` 找不到。** `--user` unit 拿不到你交互式 shell 的
PATH。上面的 `ExecStart` 在创建时就写入了绝对路径，正是为了避免这个问题 —— 如果你把它
改成了裸命令，请把完整路径改回去。

**relay 在跑但 Claude Code 不走它。** 服务注册没问题；检查 `~/.claude/settings.json`
里的 `ANTHROPIC_BASE_URL`。当 `claudeSetup: true` 时，relay 启动时会自己管理这个值。
