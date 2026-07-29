# 配置说明

`copilot-relay` 的运行配置在：

```text
~/.copilot-relay/config.yaml
```

第一次启动时会从包内模板生成。

想看**实际生效**的值 —— 补齐默认值之后的全部配置项，以及其中哪些需要重启才生效 ——
直接运行 `copilot-relay status`，它会把解析后的配置打印出来，不用再回头翻文件。

## 示例

```yaml
host: 127.0.0.1
port: 4142
copilotBaseUrl: https://api.githubcopilot.com
claudeSetup: true
logLevel: info
logRetentionDays: 3
thinkEffort: xhigh
upstreamTimeoutSeconds: 180
webSearchBackend:
gptModel: gpt-5.5
opusModel: claude-opus-4.8
```

## 字段说明

| 字段 | 作用 |
| --- | --- |
| `host` | 本地 Claude 兼容 HTTP 服务监听地址。建议保持 `127.0.0.1`，只允许本机访问。 |
| `port` | 本地端口，默认 `4142`。 |
| `copilotBaseUrl` | GitHub Copilot API 地址。一般不要改。 |
| `claudeSetup` | 为 `true` 时，`start` 会自动更新 `~/.claude/settings.json`。 |
| `logLevel` | 只能是 `error`、`info`、`debug`。其他值会导致启动失败。 |
| `logRetentionDays` | `~/.copilot-relay/logs/` 下普通 `.log` 文件保留天数。 |
| `thinkEffort` | 默认上游推理强度：`none`、`low`、`medium`、`high`、`xhigh`。 |
| `upstreamTimeoutSeconds` | 单个 Claude 请求等待上游 Copilot 调用的最长秒数，默认 `180`。 |
| `webSearchBackend` | bridge-managed WebSearch 使用的 Copilot Responses 模型；留空使用 `gptModel`。 |
| `gptModel` | 非 Opus 请求使用的上游模型。 |
| `opusModel` | 请求模型名包含 `opus` 时使用的上游模型。 |

## 热重载与重启

会热重载：

- `logLevel`
- `thinkEffort`
- `upstreamTimeoutSeconds`
- `copilotBaseUrl`
- `webSearchBackend`
- `gptModel`
- `opusModel`
- `claudeSetup`

需要重启：

- `host`
- `port`

原因是 HTTP 监听 socket 已经绑定，运行中不能自动搬到新的 host/port。

## Claude Code 配置

当 `claudeSetup: true` 时，`copilot-relay start` 会把下面的配置写入：

```text
~/.claude/settings.json
```

内容类似：

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:4142
ANTHROPIC_AUTH_TOKEN=<dummy local token>
```

这里的 token 是本地 relay 占位值。真正访问 GitHub Copilot 用的是
`~/.copilot-relay/` 里的 GitHub/Copilot token。

## 运行时文件

```text
~/.copilot-relay/
  config.yaml
  github_token
  copilot_token.json
  logs/copilot-relay.2026-07-25.log   <- 当前文件，本地零点轮转
  logs/copilot-relay.2026-07-24.log
```

`github_token` 是登录来源。`copilot_token.json` 是短期 Copilot bearer token
缓存和刷新元数据。
