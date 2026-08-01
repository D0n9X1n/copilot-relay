# 日志与问题排查

当 `copilot-relay` 已经启动，但 Claude Code 请求失败、路由到错误的模型、或者感觉很慢
时，用这一页 —— 它同时也是"每一行日志是什么意思"的参考。

每个配置键的作用见[配置说明](ZH-Configuration.md)。日志格式为什么是这样，见
[内部实现](ZH-Internals.md)。

## 先做的检查

1. 确认中继在监听：

   ```sh
   curl -sS http://127.0.0.1:4142/healthz
   curl -sS http://127.0.0.1:4142/v1/models
   ```

2. 跟踪当天日志：

   ```sh
   tail -f ~/.copilot-relay/logs/copilot-relay.$(date +%F).log
   ```

3. 检查配置：

   ```sh
   cat ~/.copilot-relay/config.yaml
   ```

`/healthz` 或 `/v1/models` 返回 `200` 只能证明中继**在监听**，不能证明它能处理请求。
两者都不访问 Copilot，所以一个 token 一小时前就过期的中继照样能通过。真正能证明它可用
的检查是：

```sh
copilot-relay status --deep
```

`--deep` 会经由 Copilot 发一个真实请求。它是可选的，因为要花掉一点 token。退出码：
`0` 运行且可达，`1` 未运行，`2` 在运行但不可用。

## 日志文件

当前文件带**本地**日历日期，每天本地零点轮转：

```text
~/.copilot-relay/logs/copilot-relay.2026-07-31.log
```

路径按写入逐次解析，所以一个跨过零点仍在运行的中继会自己开始写第二天的文件 —— 没有
会漂移的轮转定时器。用本地日期而不是 UTC 是刻意的：`logRetentionDays` 是一个"我要保留
几天"的、面向人的设置，而 UTC 戳会让格林尼治以西的人在本地下午的正中间发生文件切换。

### 保留策略

文件按 `~/.copilot-relay/config.yaml` 里的 `logRetentionDays` 删除，默认是 `3`。

保留按**包含今天在内的本地日历日**计数，所以 `3` 保留今天、昨天和前天。是否够到删除
条件由文件名里的日期决定，对没有日期戳的文件退化为按 mtime 判断。之所以优先用文件名，
是因为 mtime 会被备份、`cp` 以及编辑器碰一下文件而改写，这些都会悄悄拉长或缩短保留
窗口。

如果你是从 v0.2.3 之前升级上来的，目录里可能还留着一个不带日期的
`copilot-relay.log`。那是旧的单一日志文件；它没有文件名日期，所以在中继不再往里追加
之后会按 mtime 过期。现在已经没有任何东西往里写了，也不需要手动清理。

轮转是保留策略能生效的前提。在它存在之前，每一次追加都会刷新那唯一一个日志文件的
mtime，于是它永远不会老过截止线，什么都不会被删除；曾观察到一个安装在
`logRetentionDays: 3` 一直配置着的情况下涨到了 9.3 GB。

### 一条日志，一行

每条日志 —— 包括携带完整请求/响应上下文的错误条目 —— 都写成一行物理行，对象 payload
按有界深度渲染，不做美化换行。

这对搜索的意义和对体积一样重要。多行对象 dump 曾经让下面这些 `grep` 配方返回某个
payload 的第一个片段，而不是匹配的那条日志；按字节算，它还占了大约三分之二的日志量。

payload 的边界是深度 6、100 个数组元素、每个字符串 4000 字符。超出这些限制的值会在
日志里被截断，而不是丢弃。

### 行格式

```text
<iso 时间戳> <级别> <消息...>
```

```text
2026-06-06T04:00:00.000Z info request_id=3b241101-e2bb-4255-8caf-4136c566a962 POST /v1/messages -> 200 1234ms
```

## 日志级别

只有三个合法级别：

| 级别 | 记录内容 |
| --- | --- |
| `error` | 启动、preflight、请求、token 刷新和上游失败。 |
| `info` | error 的内容，加上启动状态、preflight 状态、request ID、上游生命周期和本地 HTTP 状态码。 |
| `debug` | info 的内容，加上模型路由摘要、Copilot 上游耗时和请求 payload。 |

`warn`、`trace`、`silent` 之类的非法值会让启动失败。文件日志与控制台日志遵循同一个
`logLevel` 过滤。

先用 `info`。只在你确实需要模型路由、上游耗时或请求 payload 时，才临时设成
`logLevel: debug` —— 它可能记录 prompt 和工具 payload。

## 常用搜索

通配符覆盖所有保留的日期：

```sh
grep -n "Startup preflight failed" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Failed to create" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "request_id=" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Model request" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Copilot POST" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Failed to refresh Copilot token" ~/.copilot-relay/logs/copilot-relay.*.log
```

跨天跟踪同一个请求的完整过程：

```sh
grep -h "request_id=<id>" ~/.copilot-relay/logs/copilot-relay.*.log | sort
```

## 各类日志长什么样

### 启动

在 `info` 级别，启动日志会确认生效的配置和 preflight：

```text
info Log level: info
info Think effort: xhigh
info Exposed models: gpt-5.6-sol[1m], claude-opus-5
info Running upstream preflight
info Upstream models available: gpt-5.6-sol, claude-opus-5
info Preflight OK: model=gpt-5.6-sol think_effort=xhigh
info Preflight OK: model=claude-opus-5 think_effort=xhigh
info copilot-relay listening on http://127.0.0.1:4142
```

### HTTP 请求

每个本地 HTTP 请求都会拿到一个 GUID `request_id`，在收到时记录：

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 request received method=POST path=/v1/messages
```

同一个 `request_id` 会出现在最终的状态摘要上：

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 POST /v1/messages -> 200 1234ms
```

字段：method、path、响应状态、耗时毫秒、request ID。

流式请求的本地 HTTP 响应会立刻打开，所以中继还会记录端到端的流耗时：

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 stream completed 1234ms
```

对非 2xx 响应，同一行会在有错误信息时附上一段简短描述：

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 POST /v1/messages -> 400 123ms error="Invalid request"
```

### 模型路由

在 `debug` 级别：

```text
debug Model request client=claude requested_model=opus upstream_model=claude-opus-5 requested_think_effort=high requested_thinking=type:enabled,budget:2048 effective_think_effort=xhigh
```

| 字段 | 含义 |
| --- | --- |
| `client` | Claude Code 流量为 `claude`，内部启动 preflight 为 `generic` |
| `requested_model` | Claude Code 发来的模型名 |
| `upstream_model` | 实际使用的 Copilot 模型 |
| `requested_think_effort` | Claude Code 发来的 `reasoning_effort`，没有则为 `none` |
| `requested_thinking` | Claude Code 的 `thinking` 配置，有 budget 时一并包含 |
| `effective_think_effort` | 经过配置/路由后真正发往上游的值 |

调试"我的请求为什么用了这个模型/effort？"时，先看这一行。

### 上游 Copilot 调用

在 `info` 级别，每次上游调用都会记录发出和返回两条生命周期日志：

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 send upstream method=POST path=/responses attempt=1 upstream_request_id=5a0f91b1-e0d3-4fd3-81a3-116238688754
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 return from upstream method=POST path=/responses status=200 ms=9200 attempt=1 upstream_request_id=5a0f91b1-e0d3-4fd3-81a3-116238688754
```

字段：上游 method、上游 path、上游响应状态、耗时毫秒、重试次数、本地 `request_id`，
以及每次调用独立的 `upstream_request_id`。

在 `debug` 级别，还会额外输出一条紧凑的耗时摘要：

```text
debug request_id=3b241101-e2bb-4255-8caf-4136c566a962 Copilot POST /responses -> 200 9200ms (attempt 1) upstream_request_id=5a0f91b1-e0d3-4fd3-81a3-116238688754
```

瞬时 5xx 的重试会在 `error` 级别连同重试上下文记录。当 Copilot 返回非 2xx 时，`error`
条目会把完整上游上下文保持在一行里：

```text
error Failed to create responses: route=/responses model=gpt-5.6-sol status=400 { request: { ... }, response: { status: 400, headers: { ... }, body: { ... } } }
```

### 请求 payload

只在 `debug` 级别：

```text
debug Full Claude request payload { payload: ... }
debug Full request payload { payload: ... }
```

只在你确实需要精确的请求形状时才用它。

### Token

token 值永远不会被打印。生命周期日志只包含路径和调度信息：

```text
info Using cached GitHub token at ~/.copilot-relay/github_token
info Using cached Copilot token at ~/.copilot-relay/copilot_token.json
info Next Copilot token refresh in 1430s
info Refreshed Copilot token
error Failed to refresh Copilot token: ...
```

### 配置重载

```text
info Config reloaded: logLevel=debug thinkEffort=xhigh upstreamTimeoutSeconds=180
```

热重载会更新 `logLevel`、`logRetentionDays`、`thinkEffort`、
`upstreamTimeoutSeconds`、`copilotBaseUrl`、`webSearchBackend`、`gptModel` 和
`opusModel`。改 `host`、`port` 或 `claudeSetup` 需要重启。

## 启动失败

```sh
grep -n "Startup preflight failed\|Preflight failed\|Required Copilot model\|Invalid logLevel" ~/.copilot-relay/logs/copilot-relay.*.log
```

常见原因：

- `github_token` 缺失或过期
- Copilot 无法用缓存的 GitHub token 换出 bearer token
- 配置的 `gptModel` 或 `opusModel` 在上游 `/models` 里不存在
- `logLevel` 非法
- `thinkEffort` 被配置的模型拒绝

重新登录后再试：

```sh
copilot-relay auth
copilot-relay start
```

## 新版本似乎没有生效

某个修复在你已经安装的版本里发布了，但行为没有变化。先看看真正在服务的是哪个构建：

```sh
copilot-relay status
```

```text
copilot-relay 0.3.0
  process    running (pid 30516, up 1h 58m)
  version    0.2.6 — MISMATCH, 0.3.0 is installed
```

第一行是你刚刚运行的那个 CLI；`version` 是正在运行的守护进程自己报告的版本。
`npm i -g` 只会替换磁盘上的可执行文件，不会动已经在跑的进程，所以在重启之前两者会
不一致：

```sh
copilot-relay restart
```

如果是以服务方式运行的，请通过服务管理器重启，而不是通过 CLI。在 macOS 上启用了
`KeepAlive` 时，launchd 可能在 `copilot-relay restart` 之下把任务重新拉起，导致重启
静默地没有生效 —— 此时用：

```sh
launchctl kickstart -k "gui/$(id -u)/com.d0n9x1n.copilot-relay"
```

然后重新检查 `status`。参见 [macOS](ZH-macOS-LaunchAgent.md)、
[Linux](ZH-Linux-systemd.md) 或 [Windows](ZH-Windows-Service.md) 页面。

`version unknown` 表示守护进程比 v0.3.1 更旧，根本不报告自己的版本；重启之后这一行才
有意义。版本不一致永远不会改变退出码 —— 中继是能用的，只是它不是你装的那个构建。

## 请求返回 400 或 500

在 `info` 级别，本地失败长这样：

```text
info POST /v1/messages -> 400 123ms error="Invalid request"
```

同一个日志文件里对应的 `error` 行包含完整上游上下文：route、model、请求 payload、
响应状态、响应 header 和响应 body。

```sh
grep -n "Failed to create" ~/.copilot-relay/logs/copilot-relay.*.log
```

如果响应 body 提到请求形状，就看 `error` 条目里附近的 `request` 对象。如果它提到认证
或模型访问权限，重新跑 `copilot-relay auth` 并再检查一次 `/v1/models`。

## 模型不对

临时设置：

```yaml
logLevel: debug
```

然后：

```sh
grep -n "Model request" ~/.copilot-relay/logs/copilot-relay.*.log
```

对比 `requested_model`（Claude Code 发来的）和 `upstream_model`（copilot-relay 发给
Copilot 的）。路由刻意保持简单：名字包含 `opus` 的请求用 `opusModel`，其他都用
`gptModel`。

## think effort 不对

```sh
grep -n "effective_think_effort" ~/.copilot-relay/logs/copilot-relay.*.log
```

把 `effective_think_effort` 与 `requested_think_effort`，以及配置里的 `thinkEffort`
做对比。`~/.copilot-relay/config.yaml` 里的 `thinkEffort` 会压过客户端提供的
reasoning effort，这样启动 preflight 和真实流量才会走同一套上游行为。

## WebSearch 失败或没有结果

Claude WebSearch 由中继通过 Copilot `/responses` 加 `web_search_preview` 执行。如果
搜索返回错误结果：

```sh
grep -n "web_search_preview\|Failed to create responses\|Copilot web search" ~/.copilot-relay/logs/copilot-relay.*.log
```

WebSearch 默认使用 `gptModel`。要改用另一个 Copilot Responses 模型：

```yaml
webSearchBackend: gpt-5.5
```

## 响应慢

每个 Claude 请求都有一个可配置的上游超时：

```yaml
upstreamTimeoutSeconds: 180
```

### 499 与 504

这两者含义不同，很容易混淆：

| 状态码 | 含义 |
| --- | --- |
| `499` | **客户端**在 Copilot 完成之前断开了。 |
| `504` | 中继自己的上游超时触发了，报告为 `upstream_timeout`。 |

```text
info request_id=... POST /v1/messages -> 499 60004ms error="Client request cancelled before Copilot upstream completed."
```

一个大约在 60 秒出现的 `499`，说明调用方在 180 秒的上游超时能够触发之前很久就关闭了
本地 HTTP 请求 —— 所以调大 `upstreamTimeoutSeconds` 不会有任何改变。

### 对比本地与上游耗时

在 `info` 级别，本地请求耗时：

```text
info request_id=... POST /v1/messages -> 200 8291ms
```

流式请求的本地 SSE 响应会在等待上游 header 时就立刻打开，所以要用 `stream completed`
那一行看端到端耗时：

```text
info request_id=... stream completed 8291ms
```

在 `info` 级别与上游耗时对比：

```text
info request_id=... return from upstream method=POST path=/chat/completions status=200 ms=8287 attempt=1 upstream_request_id=...
```

或者看 `debug` 的紧凑摘要：

```text
debug Copilot POST /chat/completions -> 200 8287ms (attempt 1)
```

如果本地和上游耗时接近，瓶颈就是上游/模型延迟。如果本地明显更大，就去检查流式翻译或
客户端行为。

## Token 缓存问题

```text
~/.copilot-relay/github_token
~/.copilot-relay/copilot_token.json
```

`github_token` 是长期登录来源。`copilot_token.json` 是在到期前刷新的短期 bearer token
缓存。

```sh
grep -n "Failed to refresh Copilot token\|Using cached Copilot token\|Next Copilot token refresh" ~/.copilot-relay/logs/copilot-relay.*.log
```

如果请求突然开始出现认证错误：

1. 检查 `github_token` 是否存在。
2. 检查 `copilot_token.json` 是否存在。
3. 搜索 `Failed to refresh Copilot token`。
4. 运行 `copilot-relay auth` 刷新 GitHub 登录 token。

## Claude Code 设置不对

当 `claudeSetup: true` 时，`copilot-relay start` 会更新 `~/.claude/settings.json`。

```sh
cat ~/.claude/settings.json
```

期望的值：

- `ANTHROPIC_BASE_URL` 指向 `http://127.0.0.1:4142`
- `ANTHROPIC_AUTH_TOKEN` 存在；它是给本地中继用的占位值

改 `host` 或 `port` 需要重启中继，因为监听 socket 无法在热重载期间迁移。

## 安全分享日志

不要未经审查就公开完整的 `debug` 日志 —— 它可能包含 prompt 和工具 payload。

日志里的上游 URL 会被脱敏：带 path、query string 或 fragment 的 `copilotBaseUrl` 会被
写成 `https://gateway.example[redacted]`，因为网关路径可能携带 token，而日志文件正是
用户唯一被要求附到 bug 报告里的东西。

提 bug 时建议提供：

- 精确时间点
- 对应的 `info` 请求摘要
- 相关的 `error` 条目（如果有）
- 是否开启过 `logLevel: debug`
- 去掉私有 endpoint 后的相关配置
