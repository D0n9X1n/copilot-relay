# 架构

`copilot-relay` 只是又一个让 Claude Code 使用 GitHub Copilot 订阅的中继。它在本地
暴露 Claude 兼容接口，并把这些请求翻译成 GitHub Copilot 上游调用。

本页是一张地图：有哪些部件、一个请求如何穿过它们、边界在哪里。每个边界背后的
精确机制 —— 模块名、不变量，以及固定它们的理由 —— 见
[内部实现](ZH-Internals.md)。日常使用见[配置说明](ZH-Configuration.md)和
[日志与问题排查](ZH-Logging-Troubleshooting.md)。

## 整体形状

Claude Code 以为自己在和 Anthropic Messages API 通信。实际上它在和一个本地 Hono
server 通信 —— 该 server 讲同样的协议，但用 GitHub Copilot 订阅来作答。

```text
Claude Code
  |
  |  Anthropic 风格 HTTP 请求
  v
src/server.ts
  |
  |  Hono routes
  v
src/routes/claude.ts
  |
  |  Claude payload + 工具名映射
  v
src/claude/*
  |
  |  Copilot chat/responses payload
  v
src/copilot/*
  |
  |  GitHub Copilot 认证请求
  v
GitHub Copilot API
```

`src/copilot/*` 以上的一切讲 Claude，以下的一切讲 Copilot。夹在中间的翻译层就是
这个项目本身。

## 公开 API

只有面向 Claude Code 的接口是公开的：

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /healthz`
- `GET|HEAD /api/hello`

内部会调用 Copilot `/chat/completions` 和 `/responses`，但不对外暴露 OpenAI 兼容
路由。未知路由返回 `500`，并记录 method、path、部分 header 和请求 payload，这样
将来要补兼容性时，证据已经在手上了。

### 廉价接口能证明什么，不能证明什么

`/api/hello` 是 Claude Code 在启动以及正常请求前后发送的静态连通性探测，由
`src/server.ts` 直接应答，永远不访问 Copilot。

`/healthz` 返回 `{ok: true, version}`，同样是进程本地的 —— 它也不访问 Copilot。

一个 Copilot token 一小时前就过期的中继，这两个接口照样返回 `200`。`200` 只说明
中继在监听，不代表它能处理请求。只有 `POST /v1/messages` 会真正触发 token 刷新和
一次真实的 Copilot 调用 —— 这正是 `copilot-relay status --deep` 存在的原因，也是
廉价检查不够用的原因。

`/healthz` 里的 `version` 是**正在应答的那个进程**的版本 —— 运行中的守护进程，而
不是发起询问的 CLI。它是唯一报告这一点的接口，也正因如此
`copilot-relay status` 才能告诉你：新版本装上了，但还没重启。

## 模型路由

路由刻意保持简单，且完全由配置驱动：

| 请求模型 | 上游模型 |
| --- | --- |
| 名字包含 `opus` | `opusModel` |
| 其他 | `gptModel` |

默认值：

```yaml
gptModel: gpt-5.6-sol
opusModel: claude-opus-5
```

`src/lib/models.ts` 负责这个映射，同时校验允许的 `thinkEffort` 取值：`none`、
`low`、`medium`、`high`、`xhigh`、`max`。

模型走哪个上游 **API** 和跑哪个模型是两个问题。`gpt-5.6-sol` 以及
`gpt-5.5`/`gpt-5.6` 系列的其余成员走 Copilot `/responses`；Opus 目前走
`/chat/completions`。Claude Code 看不到这个差别 —— 两条路径都返回 Claude
Messages 风格的响应。这个分叉带来的后果见[内部实现](ZH-Internals.md)。

## 主要模块

| 模块 | 职责 |
| --- | --- |
| `src/server.ts` | 创建 Hono server，挂载请求日志，注册 Claude routes，暴露 health/root 接口。 |
| `src/routes/claude.ts` | 本地 Claude API 表面：解析请求、记录模型路由、调用翻译层、处理流式与非流式响应、实现 `count_tokens`。 |
| `src/claude/types.ts` | 只包含代理需要的那部分 Claude Messages API 类型。刻意不做成完整 SDK。 |
| `src/claude/translate.ts` | 双向非流式翻译，包括 tool call 与 thinking/text block。 |
| `src/claude/stream.ts` | 把流式 Copilot chunk 转成 Claude SSE 事件。有状态，因为 Claude 要求显式的 block start/delta/stop。 |
| `src/claude/web-search-stream.ts` | 让声明了 WebSearch 的回合依然可以流式输出。 |
| `src/claude/tool-names.ts` | 把 Claude 工具名规范化成 Copilot 可接受的名字，并在响应里映射回来。 |
| `src/copilot/client.ts` | 底层 Copilot HTTP 客户端：必需 header、bearer token、耗时日志、瞬时 5xx 重试。 |
| `src/copilot/chat.ts` | 供 routes 和启动 preflight 共用的内部 chat 抽象。应用模型路由与 think effort。 |
| `src/copilot/responses.ts` | 在 Copilot Responses API 与 chat-completion 风格结果之间翻译。 |
| `src/lib/app-config.ts` | 读写 `~/.copilot-relay/config.yaml`，运行期热重载。 |
| `src/lib/models.ts` | 配置驱动的模型路由与 `thinkEffort` 校验。 |
| `src/lib/auth.ts` | GitHub device login、token 存储、到期前刷新 Copilot bearer token。 |
| `src/lib/preflight.ts` | 在绑定端口之前运行：验证配置的模型存在、配置的 effort 可用。 |

## 启动流程

```text
start 命令
  |
  | 读取 ~/.copilot-relay/config.yaml
  | 不存在则从 config.default.yaml 创建
  v
应用运行期配置
  |
  | 读取/同步 github_token
  | 读取/刷新 copilot_token.json
  v
对上游模型与 think effort 做 preflight
  |
  | 可选写入 Claude Code 设置
  v
启动 HTTP server
  |
  | 监听 config.yaml 热重载
  v
开始服务 Claude Code 请求
```

Preflight 在 socket 绑定**之前**运行。一个连配置模型都够不着的中继会直接启动失败，
而不是先接下它根本处理不了的流量。

## 运行期文件

```text
~/.copilot-relay/
  config.yaml
  github_token
  copilot_token.json
  copilot-relay.pid
  logs/
    copilot-relay.2026-07-31.log   <- 当前文件，本地日期
    copilot-relay.2026-07-30.log
    copilot-relay.2026-07-29.log
```

`github_token` 是长期登录/刷新来源。`copilot_token.json` 缓存短期 Copilot bearer
token 及其刷新元数据。

`copilot-relay.pid` 保存 `{host, pid, port, startedAt, version}`，由守护进程在启动
时写入 —— 所以 `version` 是真正在服务的那个构建。它是两个守护进程版本来源中的第二
个：`/healthz` 优先，因为活着的进程报不出过期答案；pid 文件覆盖"进程已起但还不健康"
的那段窗口。两者都没有，说明守护进程比 v0.3.1 更旧，此时报告 `unknown`，而不是悄悄
拿 CLI 自己的版本顶上 —— 后者就是 #43。

## 配置模型

项目遵循配置优先原则：如果某个行为可能因人而异，就放进 `config.yaml`，而不是写死。

```yaml
host: 127.0.0.1
port: 4142
copilotBaseUrl: https://api.githubcopilot.com
claudeSetup: true
logLevel: info
logRetentionDays: 3
thinkEffort: max
upstreamTimeoutSeconds: 180
webSearchBackend:
gptModel: gpt-5.6-sol
opusModel: claude-opus-5
```

`host`、`port`、`claudeSetup` 只在启动时读取一次。其余八项热重载，对改动之后开始的
工作生效。`webSearchBackend` 为空表示使用 `gptModel`。`upstreamTimeoutSeconds` 限制
单个 Claude 请求在上游上的总等待预算。

`readAppConfig()` 会把解析后的配置写回磁盘，所以一个已有安装的每个键都已经落盘，
`?? defaultConfig.x` 这类兜底在那条路径上再也不会被用到。因此**修改发布默认值只对
全新安装生效**。这是刻意的：copilot-relay 不会改写你配置里已有的值，所以一次有意的
固定能扛过每一次升级。

每个键的含义、校验规则，以及热重载/重启的分界，见[配置说明](ZH-Configuration.md)。

## 日志

日志同时写入控制台和
`~/.copilot-relay/logs/copilot-relay.<本地日期>.log`。当前文件按写入逐次解析路径，
因此无需定时器即可在本地零点轮转；保留策略删除超过 `logRetentionDays` 个本地日历日
的文件。

每条日志是一行物理行，payload 渲染有界。这两条性质都是承重的，不是美观问题；理由
见[内部实现](ZH-Internals.md)，操作手册见
[日志与问题排查](ZH-Logging-Troubleshooting.md)。

在 `debug` 级别，每个模型请求都会记录 client、请求模型、上游模型、请求 think
effort、请求 thinking budget、生效 think effort。同样在 `debug` 级别，Claude 与上游
请求诊断会**不做脱敏**地记录 —— 这正是 debug 日志不适合未经审查就分享的原因。

## 测试策略

单元测试覆盖纯粹的路由行为、配置校验，以及不该依赖 mock 上游的协议翻译边界情况。

集成测试让 Hono app 跑在本地 mock 的 Copilot 上游之上。CI 绝不可以调用真实的
GitHub Copilot 服务。

命令、CI 矩阵和发布关卡见[开发指南](ZH-Development.md)。
