# 配置说明

`copilot-relay` 的运行配置在：

```text
~/.copilot-relay/config.yaml
```

第一次启动时会从包内模板生成。

想看补齐默认值之后的全部配置项、以及其中哪些需要重启才生效，直接运行
`copilot-relay status`，它会把解析后的配置打印出来，不用再回头翻文件。注意那是**磁盘上**
的值：如果守护进程在你上次编辑之前就已经在跑了，它未必已经读到这些值。

## 示例

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

## 字段说明

| 字段 | 作用 |
| --- | --- |
| `host` | 本地 Claude 兼容 HTTP 服务监听地址。建议保持 `127.0.0.1`，只允许本机访问。 |
| `port` | 本地端口，默认 `4142`。 |
| `copilotBaseUrl` | GitHub Copilot API 地址。必须是绝对的 `http://` 或 `https://` 地址，且不能包含账号密码。一般不要改。参见 [copilotBaseUrl 规则](#copilotbaseurl-规则)。 |
| `claudeSetup` | 为 `true` 时，`start` 会自动更新 `~/.claude/settings.json`。 |
| `logLevel` | 只能是 `error`、`info`、`debug`。其他值会导致启动失败。 |
| `logRetentionDays` | `~/.copilot-relay/logs/` 下普通 `.log` 文件保留天数。 |
| `thinkEffort` | 默认上游推理强度：`none`、`low`、`medium`、`high`、`xhigh`、`max`。 |
| `upstreamTimeoutSeconds` | 单个 Claude 请求等待上游 Copilot 调用的最长秒数，默认 `180`。 |
| `webSearchBackend` | bridge-managed WebSearch 使用的 Copilot Responses 模型；留空使用 `gptModel`。 |
| `gptModel` | 非 Opus 请求使用的上游模型。 |
| `opusModel` | 请求模型名包含 `opus` 时使用的上游模型。 |

## copilotBaseUrl 规则

`copilotBaseUrl` 会在加载配置时校验，不满足以下条件时启动会直接失败：

- **必须是绝对的 `http://` 或 `https://` 地址。** 相对路径（`/tenant/v1`）、只写主机名
  （`api.githubcopilot.com`）、以及其他协议（`ftp://`、`file://`）都会被拒绝。允许使用
  明文 HTTP，所以 `http://127.0.0.1:8080` 这类本地网关是合法值。
- **地址里不能带账号密码。** `https://user:password@host` 会被拒绝。上游 HTTP 客户端
  在真正发请求时本来也不接受这种写法，放行只会把一个清晰的启动错误变成一个难懂的
  请求失败。
- **不能直接写引号、尖括号、空白字符和控制字符。** 在日志里，正是这些字符标记一个
  URL 到哪里结束；地址里带上它们，之后就没法再把整条 URL 识别出来，尾部会原样打印
  出去。请改用百分号编码：`'` 写成 `%27`，`"` 写成 `%22`，反引号写成 `%60`，
  `<`/`>` 写成 `%3C`/`%3E`，空格写成 `%20`，制表符写成 `%09`。编码后的写法会被接受，
  并原样使用。值**前后**的空格或制表符只会被去掉，和其他配置项一样。

错误信息只说明是哪个字段、违反了哪条规则，不会把你配置的值重复出来——因为这条信息
可能出现在终端或日志文件里。

### 日志和 `status` 里会显示什么

如果 `copilotBaseUrl` 带有路径、查询参数或 fragment——比如
`https://gateway.example/tenant/abc123` 这样的自建网关——只会显示它的 origin：

```text
copilot base url: https://gateway.example (path/query/fragment hidden)
```

`copilot-relay status` 和 `copilot-relay status --json` 里的 `copilotBaseUrl` 一行同理；
`~/.copilot-relay/logs/` 中错误信息里出现的上游地址也一样，会写成
`https://gateway.example[redacted]`。

这么做是因为网关路径里可能带着 token，而日志文件恰恰是报问题时最常被要求附上的东西。
不带路径的地址（比如默认的 `https://api.githubcopilot.com`）会完整显示——它里面没有
需要隐藏的内容。

## 热重载与重启

会热重载（对改动之后开始的请求生效）：

- `logLevel`
- `logRetentionDays`
- `thinkEffort`
- `upstreamTimeoutSeconds`
- `copilotBaseUrl`
- `webSearchBackend`
- `gptModel`
- `opusModel`

需要重启：

- `host`
- `port`
- `claudeSetup`

`host` 和 `port` 需要重启，是因为 HTTP 监听 socket 已经绑定，运行中不能自动搬到新的
host/port。`claudeSetup` 只在启动时读取一次，改了它要等下次启动才生效。

改 `gptModel` 会立刻改变上游路由，但不会重写 `~/.claude/settings.json` 里已经写好的模型
—— 那个是启动时写的。

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
