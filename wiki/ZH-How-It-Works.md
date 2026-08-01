# 运行原理

`copilot-relay` 是一个本地 Claude Messages API relay，后端使用 GitHub
Copilot。

Claude Code 访问：

```text
http://127.0.0.1:4142/v1/messages
```

`copilot-relay` 把 Claude 请求转换后发给 GitHub Copilot 上游。

本页是简版。设计地图见[架构](ZH-Architecture.md)；其背后的机制与不变量见
[内部实现](ZH-Internals.md)。

## 请求流程

```text
Claude Code
  -> 本地 Hono server
  -> /v1/messages route
  -> Claude 到 Copilot 协议转换
  -> 模型路由
  -> GitHub Copilot /chat/completions 或 /responses
  -> Copilot 到 Claude 协议转换
  -> Claude Code
```

## 启动流程

```text
copilot-relay start
  -> 读取 ~/.copilot-relay/config.yaml
  -> 读取 github_token
  -> 读取或刷新 copilot_token.json
  -> 通过 preflight 验证模型和配置
  -> 可选更新 ~/.claude/settings.json
  -> 监听 host/port
  -> 监听 config.yaml 热重载
```

Preflight 在 socket 绑定之前运行，所以一个连配置模型都够不着的中继会直接启动失败，
而不是先接下它根本处理不了的流量。

## 公开 API

只公开 Claude Code 需要的接口：

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /healthz`
- `GET|HEAD /api/hello`

`/api/hello` 是 Claude Code 在启动以及正常请求前后发送的连通性探测接口。它与
`/healthz` 一样由本地直接返回，不会访问 Copilot，因此返回 `200` 只说明中继正在
监听，并不代表它能够正常处理请求。若需确认后者，请使用
`copilot-relay status --deep`。

`/healthz` 返回 `{"ok": true, "version": "..."}`，其中 `version` 是**正在应答的那个
进程**的版本 —— 也就是运行中的中继本身，而不是发起询问的那个 CLI。正因如此，
`copilot-relay status` 才能告诉你：新版本已经装上了，但进程还没有重启。

OpenAI 兼容接口不会对外公开。

## 模型路由

路由规则故意保持简单：

| 请求模型 | 上游模型 |
| --- | --- |
| 名字包含 `opus` | `opusModel` |
| 其他 | `gptModel` |

默认值：

```yaml
gptModel: gpt-5.6-sol
opusModel: claude-opus-5
```

## Copilot 上游接口

内部可能调用：

- `/chat/completions`
- `/responses`

`gpt-5.6-sol` 以及 `gpt-5.5`/`gpt-5.6` 系列的其余成员使用 `/responses`。Opus 当前
使用 `/chat/completions`。

这些差异对 Claude Code 隐藏，外部始终看到 Claude Messages 风格响应。

## 认证和 token

`github_token` 是通过 device login 得到的长期来源 token。

`copilot_token.json` 缓存短期 Copilot bearer token：

```json
{
  "refreshedAt": 0,
  "refreshIn": 0,
  "token": "..."
}
```

启动时，如果缓存的 Copilot token 还有超过 60 秒有效期，就直接复用；
否则使用 `github_token` 刷新。

token 值永远不会写进日志。

## 流式响应

Copilot 输出 OpenAI 风格 chat chunks。Claude Code 需要 Claude SSE events。
relay 内部维护一个小状态机，按顺序打开、写入、关闭 text/thinking/tool_use
content block。

声明 WebSearch 工具不再需要放弃流式。中继只把模型的响应读到"足以判断是否会发生搜索"
为止，所以一个不会搜索的回合就是普通流式 —— 而这是绝大多数回合，因为 Claude Code 每
个请求都会提供这个工具。细节见[内部实现](ZH-Internals.md)。
