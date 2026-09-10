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
gptModel: gpt-6-astra
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
| `upstreamTimeoutSeconds` | 单个 Claude 请求等待上游 Copilot 调用的最长秒数，默认 `180`；`0` 禁用 relay 的总超时。 |
| `webSearchBackend` | bridge-managed WebSearch 使用的 Copilot Responses 模型；留空使用 `gptModel`。 |
| `gptModel` | 非 Opus 请求使用的上游模型。 |
| `opusModel` | 请求模型名包含 `opus` 时使用的上游模型。 |

## 选择模型和 thinking effort

### 列出可用模型

模型是否可用取决于 Copilot 账号及组织策略。安装 GitHub Copilot CLI 后，在终端运行
`copilot`，然后**在其交互会话中**输入：

```text
/model
```

选择器会列出账号可见的模型及所选模型支持的 effort。请使用与 relay 相同的账号。
在这里选择模型只会改变 Copilot CLI 会话，不会修改 relay 配置。不存在
`copilot-relay models` 命令。

Relay 使用的权威模型目录是配置的 `copilotBaseUrl` 上需要认证的 `GET /models`。
启动时会查询该目录，再探测两个配置模型。`copilot-relay status` 显示配置的 relay ID；
本地 `GET /v1/models` 还会在目录提供数据时返回缓存的 `context_window`、
`max_input_tokens` 和 `max_tokens`。这两个接口都不会拉取上游目录，也不能证明模型
当前可用。
自建网关的模型目录可能与 Copilot CLI 不同。不要把 bearer token 粘贴到命令、日志或
issue 中。

### 选择兼容的 effort

`thinkEffort` 会覆盖客户端传入的 effort，并同时应用于两条路由。选择 `gptModel` 和
`opusModel` **都支持**的值；如果设置了 `webSearchBackend`，它也必须支持该值。
Relay 接受 `none`、`low`、`medium`、`high`、`xhigh`、`max`。旧配置值 `minimal`
会被规范化为 `low`，不是独立档位。缺少 effort 元数据表示“未公布”，不是“支持所有档位”。

2026-09-05 查询的实时目录显示，`gpt-6-astra` 和 `claude-opus-5` 都支持 `low`、
`medium`、`high`、`xhigh`、`max`；Astra 未公布 `none`。更高 effort 通常会以更多
延迟和 token 消耗换取更多推理。切换任意模型时应重新检查选择器，而不是假设所有模型都
接受 `max`。

### 更新 relay 配置

修改已有的键并保留其他设置。macOS 或 Linux：

```sh
${EDITOR:-vi} ~/.copilot-relay/config.yaml
```

Windows PowerShell：

```powershell
notepad "$env:USERPROFILE\.copilot-relay\config.yaml"
```

在 macOS/Linux 上，可选用 **Mike Farah 的 `yq` v4** 切换 GPT 路由并保留你的 Opus
选择；直接用编辑器不需要额外依赖：

```sh
cp -p ~/.copilot-relay/config.yaml ~/.copilot-relay/config.yaml.bak
yq -i '.gptModel = "gpt-6-astra" | .thinkEffort = "max"' ~/.copilot-relay/config.yaml
```

确认另一个配置模型支持后再用 `max`。全新安装的默认组合为：

```yaml
gptModel: gpt-6-astra
opusModel: claude-opus-5
thinkEffort: max
```

这些键支持热重载。如需立即验证两条路由，先等待正在进行的工作结束，再运行
`copilot-relay restart`，或通过服务管理器重启（见各平台服务页面）。启动会发送少量真实
上游请求并消耗 token；`restart` 会以前台方式运行 relay。`status --deep` 只向 GPT
路由发送一次真实请求，不是对两条路由的完整验证。

已有安装会保留已保存的模型选择，升级软件包不会迁移这些值。如果启动报告 Astra 不可用，
请编辑已生成的 `config.yaml`，选择账号支持的模型，例如**目录中存在时**使用
`gpt-5.6-sol`，并设置兼容的 effort。Relay 会明确失败，不会静默回退。需要撤销修改时，
恢复 `config.yaml.bak`。

### 使用模型的完整 context 和输出预算

Relay 配置保留规范 ID `gpt-6-astra`。Relay 向 Claude Code 暴露
`gpt-6-astra[1m]`，向 Copilot 只发送 `gpt-6-astra`。`[1m]` 控制 Claude Code 的
context 计数，不能扩大上游容量。2026-09-09 查询的实时目录公布了：

| 模型 | 总 context | 最大 prompt | 最大输出 |
| --- | ---: | ---: | ---: |
| `gpt-6-astra` | 1,000,000 | 872,000 | 128,000 |
| `claude-opus-5` | 1,000,000 | 936,000 | 64,000 |
| `gpt-5.6-sol` | 1,050,000 | 922,000 | 128,000 |

这些值来自模型发现，并非运行时代码写死的限制，也不是通过生产环境中的百万 token
请求测得。应在总窗口内为输出（包括推理）预留空间。Relay 不会截短输入，也不会扩大
客户端明确指定的较小输出预算。Prompt 是否真正符合限制，仍由上游判定。
流式和完整 JSON 响应都可以使用模型的完整输出上限。

已有 Claude Code 配置需要明确选择新身份：

```sh
CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000 claude --model 'gpt-6-astra[1m]'
```

也可以在 Claude Code 中输入 `/model gpt-6-astra[1m]`。`claudeSetup: true` 只在没有
主要模型覆盖项时写入默认模型；它会保留已有模型选择和 shell wrapper。如果 wrapper
固定了其他 `--model`，也需要修改。
应使用配置模型的准确身份，不要假设内置别名具有相同的客户端 context 预算。

如果发现的 GPT 窗口并非恰好 1M，自动设置会使用不带后缀的模型 ID，并将
`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 初始化为实际窗口。否则 Claude 的 `[1m]` 后缀会覆盖
该数值设置。以上述目录为例，手动配置 Sol 时可运行：

```sh
CLAUDE_CODE_MAX_CONTEXT_TOKENS=1050000 CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000 \
  claude --model gpt-5.6-sol
```

PowerShell 中用 `$env:CLAUDE_CODE_MAX_OUTPUT_TOKENS = "128000"` 赋值；需要时同样设置
`CLAUDE_CODE_MAX_CONTEXT_TOKENS`，再运行对应的 `claude` 命令。数值应以你的模型目录
为准，不要照搬其他账号的容量。Claude 设置、shell 环境、自动压缩和上游限制仍可能约束
实际可用窗口；自动设置不会禁用压缩。详见 Claude 的
[context 覆盖规则](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id)。

如果响应可能超过已保存的超时，请明确设置：

```yaml
upstreamTimeoutSeconds: 0
```

该设置会热重载，只移除 relay 的总超时。客户端取消，以及客户端、上游和传输层自身
的超时仍然有效。全新安装的默认值仍为 `180`，已有值不会被迁移。

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

改 `gptModel` 会立刻改变上游路由，但不会重写 `~/.claude/settings.json` 中已有的模型或
token 设置。切换模型时应检查这些设置；自动设置只补充缺失的预算值。

## Claude Code 配置

当 `claudeSetup: true` 时，`copilot-relay start` 会把下面的配置写入：

```text
~/.claude/settings.json
```

内容类似：

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:4142
ANTHROPIC_AUTH_TOKEN=<dummy local token>
CLAUDE_CODE_MAX_CONTEXT_TOKENS=<发现的 GPT context 窗口>
CLAUDE_CODE_MAX_OUTPUT_TOKENS=<两个配置模型中最大的已公布输出预算>
```

这里的 token 是本地 relay 占位值。真正访问 GitHub Copilot 用的是
`~/.copilot-relay/` 里的 GitHub/Copilot token。
两个预算变量仅在缺失时写入；明确设置的较小值会被保留。Relay 会按实际路由到的模型
限制每个请求的输出预算，因此从 Astra 切换到 Opus 时，共用的客户端设置不会让请求
超过 Opus 的上限。若网关没有提供有效的限制元数据，启动日志会说明限制不可用，
并保留客户端的显式预算，而不是猜测容量。`claudeSetup: false` 时，请自行配置这些
客户端变量。

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
