# macOS：LaunchAgent 后台保活

推荐使用当前用户的 LaunchAgent。它在登录时启动，进程退出时自动拉起，并且以你自己的
身份运行 —— 因此使用的是你的 `~/.copilot-relay` 令牌缓存，而不是另一份。

## 一次性准备

```sh
npm install -g copilot-relay@latest
copilot-relay auth
which copilot-relay
```

记下 `which` 输出的路径。Apple Silicon 的 Homebrew 装在 `/opt/homebrew/bin`，
Intel 在 `/usr/local/bin`，nvm 则在 `~/.nvm` 下带版本号的目录。plist 需要绝对路径。

## 创建 plist

创建 `~/Library/LaunchAgents/com.d0n9x1n.copilot-relay.plist`，替换可执行文件路径和
`YOUR_USER`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.d0n9x1n.copilot-relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/copilot-relay</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USER</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/YOUR_USER/.copilot-relay/logs/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOUR_USER/.copilot-relay/logs/launchd.err.log</string>
</dict>
</plist>
```

`copilot-relay start` 在**前台**运行并处理 `SIGTERM`，这正是 launchd 期望的形式。
不要加 `&`、`nohup` 或任何后台化写法 —— 那会让 launchd 认为进程立刻退出，从而无限
重启。

### 为什么 `KeepAlive` 用字典而不是 `true`

这里有两项设置是关键。写错的话，服务看起来一切正常，直到你重启机器。

**`SuccessfulExit: false`** 只在进程**非零退出**时才重启。如果写成 `KeepAlive: true`，
launchd 在正常关闭后也会重启 —— 于是 `copilot-relay stop` 看起来毫无作用，因为
launchd 一秒后又把它拉了起来。参见[停止](#停止)。

**`ThrottleInterval: 30`** 限制重启频率。relay 启动时会校验上游 Copilot 访问，失败则
`exit(1)`。登录瞬间 Wi-Fi 往往还没连上，所以第一次尝试失败是正常的。没有节流的话，
launchd 会以进程失败的速度不断重试。30 秒足够覆盖网络就绪的时间，网络一通 relay 就会
自己起来。

代价是：重启后在慢速网络下，relay 可能要一两分钟才起得来。那是在重试，不是坏了。

## 加载并启动

```sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.d0n9x1n.copilot-relay.plist
launchctl enable "gui/$(id -u)/com.d0n9x1n.copilot-relay"
launchctl kickstart -k "gui/$(id -u)/com.d0n9x1n.copilot-relay"
```

修改 plist 之后要先 `bootout` 再 `bootstrap`。`kickstart` 只重启任务，不会重新加载
文件。

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

退出码便于脚本使用：`0` 运行中且可达，`1` 未运行，`2` 运行中但不可用（健康检查失败，或 `--deep` 失败）。`--json` 输出
机器可读格式。

### 手动执行这三层

`status` 已经替你跑了这三层。理解它们仍然有价值，因为**前两层在一个根本无法处理任何请求
的 relay 上也会通过** —— 在没有装 CLI 的机器上排查时也用得上。

### 第一层 —— 进程还活着吗？

```sh
launchctl print "gui/$(id -u)/com.d0n9x1n.copilot-relay" | grep -E "state|pid|last exit"
curl -s http://127.0.0.1:4142/healthz
```

期望 `{"ok":true}`。这是一个静态处理器：它只能证明有个端口在监听，别的什么都证明不了。
它完全不会访问 GitHub Copilot。

### 第二层 —— 配置解析和模型路由正常吗？

```sh
curl -s http://127.0.0.1:4142/v1/models
```

期望看到你配置的模型，例如 `gpt-5.6-sol[1m]` 和 `claude-opus-5`。这个结果直接来自配置，
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

如果前两层通过而第三层失败，问题在鉴权或上游，不在服务注册 —— 执行
`copilot-relay auth` 并查看当天日志。

### 查看日志

```sh
tail -f ~/.copilot-relay/logs/copilot-relay.$(date +%F).log
```

日志按天轮转，文件名带本地日期。要搜索所有保留的日期，用通配符：

```sh
grep -n "Startup preflight failed" ~/.copilot-relay/logs/copilot-relay.*.log
```

`launchd.err.log` 记录 relay 自身日志器启动之前的输出。服务完全起不来时看这个文件。

## 停止

用哪条命令，取决于你希不希望它**保持**停止。

现在停止，下次登录时由 launchd 再拉起：

```sh
launchctl kill SIGTERM "gui/$(id -u)/com.d0n9x1n.copilot-relay"
```

现在停止并卸载任务，在你重新 bootstrap 之前都不会回来：

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.d0n9x1n.copilot-relay.plist
```

重启：

```sh
launchctl kickstart -k "gui/$(id -u)/com.d0n9x1n.copilot-relay"
```

### `copilot-relay stop` 与 launchd 的关系

`copilot-relay stop` 会直接找到并终止 relay 进程。它是正常退出，所以在
`SuccessfulExit: false` 下 launchd 不会再拉起 —— 命令行和守护进程的行为是一致的。

如果写成 `KeepAlive: true`，launchd 会在几秒内重启它，看起来就像命令行没生效。出现这种
情况说明你的 plist 还是旧的。

不论用哪种守护方式，确认 relay 确实没了：

```sh
copilot-relay stop
lsof -nP -iTCP:4142 -sTCP:LISTEN   # 应该没有任何输出
```

### 彻底移除

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.d0n9x1n.copilot-relay.plist
rm ~/Library/LaunchAgents/com.d0n9x1n.copilot-relay.plist
```

## 排查

**起不来，`last exit code = 1`。** 启动前校验失败：鉴权过期或没有网络。看当天日志的
末尾，然后执行 `copilot-relay auth`。

**反复重启。** 确认 `ThrottleInterval` 存在。`launchctl print` 里反复出现的退出码 `1`
是启动前校验在失败，也就是鉴权或网络问题，不是 plist 的问题。

**bootstrap 时报 `Operation not permitted`。** 通常是 plist 的属主不是你，或权限不对。
执行 `chmod 644` 并检查属主。

**relay 在跑但 Claude Code 不走它。** 服务注册没问题；检查
`~/.claude/settings.json` 里的 `ANTHROPIC_BASE_URL`。当 `claudeSetup: true` 时，relay
启动时会自己管理这个值。
