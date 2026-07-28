# 运行原理

`copilot-relay` 是一个本地 Claude Messages API relay，后端使用 GitHub
Copilot。

Claude Code 访问：

```text
http://127.0.0.1:4142/v1/messages
```

`copilot-relay` 把 Claude 请求转换后发给 GitHub Copilot 上游。

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

OpenAI 兼容接口不会对外公开。

## 模型路由

路由规则故意保持简单：

| 请求模型 | 上游模型 |
| --- | --- |
| 名字包含 `opus` | `opusModel` |
| 其他 | `gptModel` |

默认值：

```yaml
gptModel: gpt-5.5
opusModel: claude-opus-4.8
```

## Copilot 上游接口

内部可能调用：

- `/chat/completions`
- `/responses`

`gpt-5.5` 使用 `/responses`。Opus 当前使用 `/chat/completions`。

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

## 流式响应

Copilot 输出 OpenAI 风格 chat chunks。Claude Code 需要 Claude SSE events。
relay 内部维护一个小状态机，按顺序打开、写入、关闭 text/thinking/tool_use
content block。

