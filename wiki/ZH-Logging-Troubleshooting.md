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
`0` 运行且可达，`1` 未运行，`2` 不可用，或因配置无效/不可读而无法建立状态。

诊断保留 16-token 输出预算，推理与可见文字共享这个预算。成功的 assistant message 若
带有 `stop_reason: max_tokens` 和正数 `usage.output_tokens`，即使 `content` 为空也能
证明上游往返成功。这时文字输出和 JSON 的 `deep.detail` 都会显示
`output budget exhausted before visible text`；退出码 `0` 表示可达，不代表答案已经完成。
空的已完成响应、缺少预算耗尽证据的响应和 HTTP 错误仍然会失败。如果需要可见答案，请
用更大的输出预算手动发请求，不要仅因为推理用完探针预算就重新认证。

## 排查 Opus API 错误

先看**失败回合本身的证据**，不要把每个 API 错误都当成认证问题。拒绝、无效请求、
传输中断和 relay 翻译失败，需要不同的下一步。

1. 保存简短报错、本地时间、模型和 effort。Relay 生成的流式/内部错误带有
   `(request_id=<uuid>)`，HTTP 响应也带 `x-copilot-relay-request-id`。ID 由 relay
   生成，不采用客户端提供的值。用它关联该请求日志，避免混入另一会话的失败。
2. 要重新检查准确模型的可用性，可运行：

   ```sh
   copilot-relay models --deep --model claude-opus-5.5 --details
   ```

   这会消耗真实 Copilot 用量，只测试隔离的短请求，不是运行中的 daemon，也不是历史
   长会话。PASS 不能复现长上下文、流式、工具或特定提示引发的失败。`status --deep`
   则测试 daemon 配置的 GPT 路由；廉价 health/models 检查完全不访问上游。
3. 分别阅读 `client_http`、`upstream_http`、实际 `route`、响应状态和语义 `outcome`。
   HTTP 200 加 `content_filter`/`refusal` 是拒绝，不是成功。完整正文/捕获仍可能包含
   错误。`terminal=observed` 只说明观察到结束标记，不代表成功回答。未报告的证据保持
   `unknown`，不能据此断言网络或提供方有问题。
4. 用本地/上游请求 ID 和已知 provider/message ID 关联各次尝试。已丢弃的失败尝试后
   成功，与最终失败不同。刷新结果会显示，但不会输出 token 值。
5. 完整 debug 捕获存在时，详情显示 `capture=complete` 和**离线**命令
   `copilot-relay replay <request-id>`。`capture=off` 表示当时未启用 debug；
   `capture=incomplete`、`pending` 或 `failed` 表示没有完整记录。Replay 不会重新
   发送到 Copilot。`MATCH` 说明当前 handler 可复现记录行为，包括拒绝/错误，不代表
   模型健康或已知提供方拒绝原因。新 handler 给错误消息加上请求 ID 后，旧捕获可能
   返回 DIFF。

遇到接口跳过时，比较 `--details` 中的 `planned_route`、`route_source`、
`advertised_endpoints` 和 `sent`。它们反映提供方的 `supported_endpoints`；未知
接口字符串只计数，不打印。仅公布 `/responses` 的模型不会再因为名称较新就被送到
`/chat/completions`。`SKIPPED` 表示没有发送推理请求，不等于账号或模型不可用。
请求已发送后出现 HTTP 400 是另一类失败，需要独立证据。目录 `reasoning_effort`
为 false 或空档位列表时，`effort=omitted` 是刻意省略；显式控制则返回
`relay_unsupported_effort`。完整规则见[配置说明](ZH-Configuration.md)。

| 观察结果 | 下一步 |
| --- | --- |
| No advertised route / Unsupported route | 检查已知接口元数据与未知接口数量；当前没有可测试的兼容已公布适配器。 |
| Protocol policy conflict | 检查 `claudeUpstreamApi`；不要盲目切换已有签名/原生会话的接口。 |
| 401 或 token 刷新失败 | 检查认证，再次探测前使用 `copilot-relay auth`。 |
| 403 | 检查账号/模型权限和网关策略，不要直接认定 token 过期。 |
| 429 | 等待后再请求；重试/探测会消耗用量。 |
| 超时或正文中断 | 检查连接与有效期限，不要把部分文本当作完成。 |
| 无效工具输入 / 本地校验 | 检查准确接口和请求 ID，保留私有捕获供离线诊断。 |
| 拒绝或未完成生成 | 检查 stop/finish 原因与输出预算，不绕过安全控制或静默切换接口。 |
| 未知 API 错误 | 在关联日志或完整记录提供新证据前，保持未知。 |

长会话可先参考[配置说明](ZH-Configuration.md)中的 **800K** 自动压缩建议及余量约束；
上下文超限只是一种可能，不能据此诊断笼统 API 错误。复制终端输出时可用 `NO_COLOR=1`。
彩色 `status` 仍保留文字状态与原退出码，`status --json` 始终无颜色。

重复失败时，按下文使用短暂、明确的 debug 窗口，或另开端口与隔离目录的诊断实例。
不要为了复现而重启活跃 relay，不要忽视并发请求直接全局开启 debug，也不要上传整个
捕获。原始提示/工具结果可能含敏感数据，只分享人工核对后的状态/ID 和结构性 replay
结果。

## 日志文件

当前文件带**本地**日历日期，每天本地零点轮转：

```text
~/.copilot-relay/logs/copilot-relay.2026-07-31.log
```

路径按写入逐次解析，所以一个跨过零点仍在运行的中继会自己开始写第二天的文件 —— 没有
会漂移的轮转定时器。用本地日期而不是 UTC 是刻意的：`logRetentionDays` 是一个"我要保留
几天"的、面向人的设置，而 UTC 戳会让格林尼治以西的人在本地下午的正中间发生文件切换。

### 保留策略

普通 relay 日志与 debug 捕获共用 `~/.copilot-relay/config.yaml` 的 `logRetentionDays`
（默认 `3`）。这是日历保留窗口，不是字节配额。

保留按**包含今天在内的本地日历日**计数，所以 `3` 保留今天、昨天和前天。是否够到删除
条件由文件名里的日期决定，对没有日期戳的文件退化为按 mtime 判断。之所以优先用文件名，
是因为 mtime 会被备份、`cp` 以及编辑器碰一下文件而改写，这些都会悄悄拉长或缩短保留
窗口。普通日志只清理 relay 自己的日期/旧式文件名；服务管理器 stderr 文件和其他诊断
不属于这个清理器。

捕获按外层本地日期目录计龄。启动、配置重载时清理；接入 POST 请求时也检查，节流为
每小时最多一次，离线重放不触发。活动捕获受到保护，包括 owner 仍存活或无法确定的
pending 捕获。只有已确认记录的 owner 退出，遗留 pending 捕获才可清理。符号链接、
意外文件和未知/变化中的记录保留，不递归删除。因此不安全/未知残留可能超过保留窗口，
应先检查，不能把 retention 当作所有目录必定消失的保证。优雅关停在 server 关闭后等待
捕获/日志写入；崩溃、SIGKILL 或磁盘失败仍可能留下不完整捕获。

如果你是从 v0.2.3 之前升级上来的，目录里可能还留着一个不带日期的
`copilot-relay.log`。那是旧的单一日志文件；它没有文件名日期，所以在中继不再往里追加
之后会按 mtime 过期。现在已经没有任何东西往里写了，也不需要手动清理。

轮转是保留策略能生效的前提。在它存在之前，每一次追加都会刷新那唯一一个日志文件的
mtime，于是它永远不会老过截止线，什么都不会被删除；曾观察到一个安装在
`logRetentionDays: 3` 一直配置着的情况下涨到了 9.3 GB。

### 一条日志，一行

每条普通日志 —— 包括携带请求/响应上下文的错误条目 —— 都写成一行物理行，对象 payload
按有界深度渲染，不做美化换行。内嵌换行分隔符在 URL 脱敏后转义。

这对搜索的意义和对体积一样重要。多行对象 dump 曾经让下面这些 `grep` 配方返回某个
payload 的第一个片段，而不是匹配的那条日志；按字节算，它还占了大约三分之二的日志量。

对象检查的边界是深度 6、100 个数组元素、对象内每个字符串 4000 字符。最终每个渲染
参数限制 16 KiB，每条文件日志限制 64 KiB，并以 `[truncated]` 标明最终大小截断。
两端均在最终限制前进行 URL 和已知凭据脱敏。这些日志不是逐字节捕获，下文独立的
原始 debug 正文文件不受这些限制。

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
| `info` | error 的内容，加上启动/preflight 状态、request ID、模型与 effort 摘要、上游生命周期、HTTP 状态码和完成/拒答/缓存元数据。 |
| `debug` | info 的内容，加上详细耗时/捕获路径日志，并为通过接入检查的 Messages/token 计数 POST 自动捕获完整原始正文；不做常规完整 payload 日志转储。 |

`warn`、`trace`、`silent` 之类的非法值会让启动失败。文件日志与控制台日志遵循同一个
`logLevel` 过滤。

先用 `info`。只在明确、短暂的捕获窗口内开启 `logLevel: debug`，之后恢复 `info`。
这会捕获**窗口内全部通过接入检查的 Messages/token 计数 POST**，不只是你在调查的那次
请求；不能补回之前的流量。GET/静态探针，以及被 Host/Origin/content-type 接入检查拒绝
的请求，不进行完整正文捕获。

## Debug 捕获与离线重放

### 存储内容

Debug 自动把**实际观察到的**完整原始客户端请求、上游请求/响应和下游响应字节写入：

```text
~/.copilot-relay/captures/<local-date>/<request-id>/
  meta.json
  client-request.bin
  client-response.bin
  upstream-<order>-request.bin
  upstream-<order>-response.bin
```

用日志里的本地 `request_id` 查找捕获；响应也通过 `x-copilot-relay-request-id` 返回它。
`meta.json` 包含 HTTP 状态、正文/chunk 状态、有序传输尝试/刷新结果、策略/目录快照和
有界完成元数据。`<order>` 包含刷新步骤，因此上游文件序号不一定连续。空正文可以没有
对应 `.bin` 文件。文件以 0600、目录以 0700 创建；POSIX 上强制这些权限，Windows
访问权限仍依赖账号 ACL。

Header 允许列表仅包含 `content-type`、`accept`、`anthropic-version`、`anthropic-beta`、
`claude-beta`、`x-request-id`、`x-github-request-id`、`x-copilot-service-request-id`
和 `retry-after`，不含认证 header 和 bearer 状态。**这不是 payload 脱敏。**正文文件
包含实际观察到的精确提示词/工具/响应数据，包括其中的密钥或私有 URL。不要把捕获整份
归档分享、粘贴或上传；分享前应在本地审查挑选的元数据/摘录。

### 完整性与限制

写入器最多允许**每请求 8 MiB 排队字节**，以及**每正文 100,000 个已记录 chunk**。
磁盘异步写入，不会为了保持捕获完整而阻塞转发。过载、写入/初始化/最终落盘失败、取消
或正文仍待完成时，明确保留不完整/待定状态，不声称成功。重放对未完成捕获报告
`INCOMPLETE`。查看 `meta.json` 的 `captureState`、`captureError` 及正文状态；初始化
失败时可能只有普通错误日志，没有可用捕获目录。

这些是队列/元数据边界，**不是总磁盘配额**。长时间开 debug 仍可能写入大量正文。
原始流只包含 handler/客户端路径实际消费的字节，不会为了诊断而暗中读完取消/丢弃的传输。
完整字节记录仍可能包含语义拒答、生成截断或错误；捕获完整**不代表答案成功**。

### 本地重放

```sh
copilot-relay replay <request-id>
copilot-relay replay /absolute/path/to/capture-directory
```

两种形式统称 `copilot-relay replay <request-id|directory>`。ID 会搜索本地日期目录；
显式目录可位于默认 home 之外。重放使用记录的有序上游/刷新传输，运行**当前真正的进程内
handler**，不创建 socket、不做真实认证、不写 token/config 或新捕获。它比较实际出站
请求与最终 JSON/SSE，不是仅比较两个已保存文件。输出包含每次交换的状态、已知完成
原因和 token/缓存数字，以及客户端 block 类型和工具调用数；不会打印工具参数或响应
正文。不要只为重放就运行 `auth`、重启守护进程或重新调用 Copilot。

| 结果 | 退出码 | 含义 |
| --- | ---: | --- |
| `MATCH` | `0` | 当前转换和有序操作与记录一致，不证明实时上游健康、答案正确或缓存效率。 |
| `DIFF` | `2` | 出站/下游结构或传输顺序不同。Diff 只输出路径和固定原因，**不含 payload 文本**。 |
| `INCOMPLETE` | `2` | 捕获未完整结束，不声称匹配。 |
| `MISSING` / `MALFORMED` | `1` | 捕获不存在、存在歧义、不安全、无效或超过重放限制。 |

重放最多接受 **16 MiB 元数据**和 **256 MiB 合计正文字节**。它会校验固定文件名、
目录/文件安全、schema 及 chunk 大小，拒绝不安全链接。即使磁盘捕获成功，超出重放
范围的有效记录也不能直接重放。不能把中断后的片段当作完整响应，从而把它提升为 `MATCH`。

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
info Default think effort: xhigh
info Running upstream preflight
info Upstream models available: gpt-6-astra, claude-opus-5
info Preflight OK: model=gpt-6-astra think_effort=xhigh
info Preflight OK: model=claude-opus-5 think_effort=xhigh
info Exposed models: gpt-6-astra[1m], claude-opus-5
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

`stream completed` 只表示 handler 结束，不表示模型成功回答。独立的 `request outcome`
与上游 `completion` 条目记录 `http_status`、正文状态、`stop_reason`/`finish_reason`、
响应状态、终止证据、拒答类别、未完成原因及已报告缓存/输入/输出用量。终止字段缺失时
为 `unknown`；不能把缺少的缓存字段当成零用量。HTTP 200 仍可能携带拒答、`max_tokens`、
工具结果错误或损坏的 SSE 流，应查看完成结果而不只看传输状态。

对非 2xx 响应，同一行会在有错误信息时附上一段简短描述：

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 POST /v1/messages -> 400 123ms error="Invalid request"
```

### 模型路由

在 `info` 级别（`debug` 也包含这些内容）：

```text
info Model request client=claude requested_model=opus upstream_model=claude-opus-5 requested_think_effort=high requested_thinking=type:enabled,budget:2048 effective_think_effort=high
```

| 字段 | 含义 |
| --- | --- |
| `client` | Claude Code 流量为 `claude`，内部启动 preflight 为 `generic` |
| `requested_model` | Claude Code 发来的模型名 |
| `upstream_model` | 实际使用的 Copilot 模型 |
| `requested_think_effort` | Claude Code 的 `output_config.effort`、旧字段 `reasoning_effort`，缺失时为 `unset` |
| `requested_thinking` | Claude Code 的 `thinking` 配置，有 budget 时一并包含 |
| `effective_think_effort` | 有请求 effort 时使用该值；否则使用配置的默认值；模型明确声明不支持 effort 且请求未指定时为 `omitted` |

调试"我的请求为什么用了这个模型/effort？"时，先看这一行。
`requested_think_effort=unset` 表示请求未指定 effort：此时有效值为配置默认值；
模型明确声明不支持 effort 时为 `omitted`。显式请求的 `none` 会记录成 `none`，不会与缺失字段混淆。
该摘要只包含元数据，不包含普通 prompt/工具 payload 转储，并会移除终端控制字符以保持单行。
原生路由的摘要更简短，包含 `upstream_api=messages`、路由后模型及生效 effort。完整的
原始模型/控制字段在 debug 捕获中保留，不保证两种摘要格式完全相同。

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

瞬时 5xx 的重试会在 `error` 级别连同重试上下文记录。翻译路径的非 2xx 错误会用单行
`error` 条目保留有界上游上下文：

```text
error Failed to create responses: route=/responses model=gpt-6-astra status=400 { request: { ... }, response: { status: 400, headers: { ... }, body: { ... } } }
```

### 请求捕获

在 `debug` 级别，捕获初始化会报告本地 request ID 和目录（示例路径）：

```text
debug request_id=<request-id> capture=/home/<user>/.copilot-relay/captures/<local-date>/<request-id> privacy=full-bodies
```

原始已观察 payload 存在 `client-request.bin`、`client-response.bin` 及
`upstream-<order>-request.bin` / `upstream-<order>-response.bin`，完整性由 `meta.json`
记录。常规 debug 日志不输出完整 payload 对象，普通日志中剩余的请求/响应上下文是有界
错误诊断。检查精确的已观察字节时，应遵守上面的捕获完整性与隐私规则，而不是依赖日志摘录。

### Token

认证生命周期日志不打印 bearer 值，只包含路径和调度信息。原始正文捕获仍可能包含
提示词里的密钥或上游回显，这属于另一条隐私边界：

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
`upstreamTimeoutSeconds`、`copilotBaseUrl`、`webSearchBackend`、`claudeUpstreamApi`、
`gptModel` 和 `opusModel`。改 `host`、`port` 或 `claudeSetup` 需要重启。Watcher 从不
重写文件：无效、空白或不完整保存会保留上一次有效设置，直到全部落盘键再次齐备。
活动请求保持接入时策略，但会使用刷新后的凭据。

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

## 配置损坏与安全停止

错误编辑不一定停止正在用上一次有效策略服务的 daemon。`status` 会以 `2` 退出并输出
安全的配置诊断，不猜测健康状态，也不改写无效值。修复文件并恢复全部键后才能热重载；
见[配置说明](ZH-Configuration.md)。

若需要先停止，`copilot-relay stop` 可不依赖配置端口提示继续尽力恢复，并识别 `start`
及长期运行的 `restart` 进程。只向身份已验证的 relay 发送信号，升级终止前再次检查，
保留未知/存活 PID 记录。进程查询失败不能证明进程已退出：发现状态未知会在有限时间内
重试，之后报告无法确认停止。`status` 对未知检查状态以 `2` 退出，不用“No existing
instance found”掩盖未知候选。不要盲目终止未验证 PID；先检查身份，或使用拥有该 relay
的服务管理器。

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

翻译路径的上游错误可在对应 `error` 条目中包含 route/model 和有界请求/响应上下文。
不要把渲染摘录当作完整捕获。原生错误保留上游失败，不会静默切换 API；先按 request ID
关联完成元数据。

```sh
grep -n "Failed to create" ~/.copilot-relay/logs/copilot-relay.*.log
```

如果响应 body 提到请求形状，查看审查过的有界摘录或完整的本地捕获。翻译路径仅在内联
system `output_config` 的唯一键为 `effort`、取值属于五种配置档位且与当前解析后的请求
effort 完全相同时接受它，system 文本和顺序不变。不同的历史 effort、额外/未知键、
`clear_at`、未知角色或格式错误的 system 文本，都在上游操作/SSE 前返回 HTTP 400 JSON。
原生强制 bridge 搜索选择及无法识别的旧 bridge 历史也一样。不要通过静默改写控制字段
或剥离签名历史掩盖这些错误；见[内部实现](ZH-Internals.md)。

Host/Origin 拒绝为 `403`，非空推理/token 计数 POST 缺少 `application/json` 时为 `415`。
这些是本地接入错误，不是 Copilot 认证失败，也不会使非 loopback 监听器获得认证保护。

上游 HTTP 400 也可能是客户端/provider 能力不匹配。2026-09-30 的隔离 Claude Code
2.1.285 原生检查中，最初两次请求因不支持 `safeguards` 被拒绝，随后客户端自行降低
请求能力，完成了两个回合的 `Read`/工具结果交换。Relay 没有剥离该字段或绕过安全控制。
这条观察不建议移除 safeguard，也不是对端口 4142 上生产监听器的验证。有限证据及边界
见[内部实现](ZH-Internals.md)。

如果它提到认证或模型访问权限，先刷新登录，然后用一个**真的会访问 Copilot** 的检查
来验证：

```sh
copilot-relay auth
copilot-relay restart      # 如果中继本来就在运行
copilot-relay status --deep
```

**不要用 `/v1/models` 来确认这件事。** 它列出的是你配置里写的模型 ID，永远不会访问
Copilot，所以一个过期的 token、或者一个你的订阅无权访问的模型，都能原样通过它。只有
`POST /v1/messages` 会真正触发 token 刷新和上游模型访问 —— 那正是 `status --deep`
发出的请求，也是一次真实 Claude Code 请求所做的事。

## 模型不对

使用 `logLevel: info` 或 `debug` 时：

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
做对比。请求 effort 优先；只有请求未指定且模型未明确排除 effort 时才使用配置值。
启动 preflight 验证默认值；明确不支持 effort 的模型日志显示 `omitted`，不会测试每一种
请求覆盖值。优先级及 effort 与 thinking-token 预算的
区别见[配置说明](ZH-Configuration.md)。
`thinkEffort: none` 和格式错误的默认值现在会阻止启动，并提示有效选项；
无效的热重载会记录错误，之前的运行时设置继续生效。

## WebSearch 失败或没有结果

Claude WebSearch 由中继通过 Copilot `/responses` 加 `web_search_preview` 执行，即使
会话使用原生 Claude Messages 也一样。原生 bridge 搜索要求自动选择；强制 `any` 或显式
强制搜索在检索前拒绝，不支持多次/重复搜索调用。旧 chat bridge 搜索历史不会被原生
路径透明接受，应保留原路由或新建会话。签名历史重建见[内部实现](ZH-Internals.md)。

如果搜索返回错误结果：

```sh
grep -n "web_search_preview\|Failed to create responses\|Copilot web search" ~/.copilot-relay/logs/copilot-relay.*.log
```

上游 HTTP 请求失败时，工具结果仍使用 `unavailable` 错误码，但附带文本会报告实际的
上游状态码和后端模型：

```text
Copilot web search upstream service unavailable (HTTP 503; model gpt-6-astra).
```

503 表示服务暂不可用，其他 5xx 表示服务器故障，429 表示限流，401 表示认证被拒绝，
403 表示访问被拒绝。这些状态不能证明模型或工具不受支持，也不能证明令牌已经过期。
其他状态报告通用请求失败。外层 Claude 响应仍可能为 HTTP 200，包括已经打开的 SSE
流；应检查工具结果和上游 `return from upstream ... status=...` 日志，而不只看外层
状态码。HTTP 成功响应会单独分类，确认状态后才决定是否接受部分结果：

| Responses 正文 | 提示 / 行为 |
| --- | --- |
| `incomplete` | `response incomplete (max_output_tokens)` 或 `content_filter`；未知原因记为 `unknown`，未提供原因记为 `unreported`。不接受部分链接。 |
| `failed` / `cancelled` | `response failed` / `response cancelled`，即使部分文本中存在 URL 也不会作为成功结果。 |
| `queued` / `in_progress` / 未知状态 | `response not complete (...)`；不会自动重试。 |
| 搜索调用明确失败或尚未完成 | `search call did not complete`；不接受部分结果。 |
| `completed`，但没有文本或可用结构化来源 | `completed without extractable text or sources`。 |
| 有文本，但没有可用 URL 或结构化来源 | `returned text without usable source URLs`。 |
| 缺少状态且没有可用结果 | `returned no usable results (response status unreported; no extractable text or sources)`。缺少元数据不代表搜索成功执行。 |
| JSON 或正文格式错误 | `returned a malformed response`；不会附带原始正文。 |

这些情况仍返回 `web_search_tool_result_error`，`error_code` 为 `unavailable`。
2xx 失败会保留上游提供的输入/输出用量和有效响应 ID，不再全部替换成零用量及无关的
随机 ID。缺少或不合法的 token 数只在 Claude 协议要求数字的字段中使用零；诊断摘要
会显示 `unknown`，与上游明确报告的零区分开。

`info` 级别的 `Copilot web search completion` 记录有界的单行元数据：`request_id`、
`upstream_response_id`、配置的后端模型、请求/实际 effort、输出上限、响应状态、已知的
未完成原因、输出条目数量、搜索调用状态计数、输入/输出/推理 token 数、来源格式、
执行证据和结果分类。另一条 `Copilot web search tool result` 把这些 ID 与返回的
`tool_use_id` 关联。不符合格式约束的 ID 会被省略，未知状态或类型使用固定标记；
这两类日志都不会记录查询、提示词、响应文本、推理文本、请求头或任意错误对象。

有结构化引用或来源 URL 时优先使用；否则保留现有的文本 URL 回退。缺少引用或搜索
调用元数据不代表模型不支持搜索。只有明确报告完成的 `web_search_call` 才作为执行
证据；其他结果会在最终回答上下文中明确标记为未验证，来源内容始终视为不可信数据。

继承的 effort 和现有搜索输出上限（最多 1200 token）保持不变。
`incomplete_reason=max_output_tokens` 加上报告的推理/输出用量可以证明该次请求耗尽
输出预算，但不能证明历史空结果的原因。不要在原因未知时调大全局超时、改变主会话
模型或 effort，或反复重试空响应。

如果可用，会在清理后附上上游错误消息或错误码，最多 240 个字符。识别出的凭据或请求
回显以及无法识别的结构化正文会被省略；不会新增原始响应头或请求 payload 日志。
重试策略和模型选择保持不变。这是诊断处理，不是搜索执行的证明：生成文本中的链接
本身不能证明搜索已经执行。

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

缓存 bearer 可能在声明的期限之前被拒绝。无论 preflight 还是正常请求，遇到 HTTP 401
或纯文本 `forbidden` 的 HTTP 403 时，中继都会尝试一次非交互刷新。并发失败共享刷新；
明确的策略、模型或配额拒绝不会触发刷新。仅凭 403 不能断定 token 到期或账户失去权限。

```sh
grep -n "authentication rejected\|token refresh completed\|token recovery failed" ~/.copilot-relay/logs/copilot-relay.*.log
```

`token refresh completed; retrying` 只表示交换完成或复用了更新的 token，不表示推理已经
成功。应检查重试后的上游状态；持续拒绝仍会报告。交换失败不会启动设备授权。已取消
的请求和已经开始的流永远不会重放。

如果认证错误持续存在：

1. 检查 `github_token` 和 `copilot_token.json` 是否存在，不要打印内容。
2. 检查刷新、恢复失败日志及最终上游状态。
3. 明确的权限或配额错误应与凭据被拒绝分开排查。
4. 只有需要更新 GitHub 登录时才运行 `copilot-relay auth`；删除缓存或重新授权不是正常恢复路径。

恢复后用 `copilot-relay status --deep` 验证推理；本地健康检查和模型列表接口本身不能
证明上游可用。

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

**绝不要整份分享原始捕获。** 即使排除了认证 header，提示词、工具参数/结果、签名
thinking、响应及回显 URL 仍可能含私有数据或密钥。不要把整份捕获上传到 issue、聊天或
诊断服务，先在本地审查最小必要摘录。

普通日志会脱敏 URL 尾部（例如 `https://gateway.example[redacted]`），但不会因此净化
任意 payload 密钥。连 `error` 摘录都需审查；有界不等于可以安全公开。

提 bug 时仅提供经过审查的必要信息：

- 精确时间点及本地 request ID
- 对应的 `info` 请求/结果摘要，区分 HTTP 状态与完成状态
- 必要时附上清理过的相关 `error` 摘录
- 重放结果及结构 diff 路径，不附正文文件
- 是否开启 debug、捕获是否完整
- 去掉私有 endpoint 及敏感值后的相关配置

捕获拒答只能证明观察到了拒答，不能证明 provider 的原因；仍未证明历史拒答由推理内容
扁平化导致。2026-09-30 的有限 native/chat 缓存试验及独立真实客户端检查记录在
[内部实现](ZH-Internals.md)，也包含为平衡顺序而进行的第二次试验被 native 冷请求拒答
中断这一结果。它们不能证明广泛缓存无退化、计费等价或当前生产可用性，默认值仍为
`chat-completions`。记录的成功和拒答案例都重放为 `MATCH`，这验证本地复现，不是认可
答案或新的上游成功调用。这些隔离检查没有触碰端口 4142。
