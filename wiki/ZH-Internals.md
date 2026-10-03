# 内部实现

[架构](ZH-Architecture.md)里画出的那些边界，背后的精确机制都在这一页。本页面向任何
需要改动中继、又不想弄坏那些代价高昂才学到的东西的人 —— 无论是人还是编码智能体。

这里给出源码路径和符号名，方便检索。行号刻意不写：行号会过期，名字不会。

## 模块地图

```text
src/
  main.ts                     CLI 入口（citty）：auth、start、stop、restart、status、models、replay
  server.ts                   Hono app、请求日志、health/root 接口
  start.ts                    启动序列与热重载接线
  stop.ts                     进程发现与关停升级
  restart.ts                  stop + start
  status.ts                   检测、健康探测、--deep、--json、退出码
  auth.ts                     GitHub device login 命令
  replay.ts                   replayCapture：校验捕获，用当前 handler 离线重放

  routes/claude.ts            POST /v1/messages、count_tokens、GET /v1/models

  claude/
    types.ts                  用到的那部分 Claude Messages 类型
    translate.ts              非流式 Claude <-> Copilot 翻译
    stream.ts                 Copilot chunk -> Claude SSE 状态机
    web-search.ts             由中继托管执行的 WebSearch
    web-search-stream.ts      resolveWebSearchStreamDecision
    tool-names.ts             Claude <-> Copilot 工具名规范化
    utils.ts                  共用翻译辅助函数

  copilot/
    client.ts                 认证 HTTP 客户端、重试、计时
    chat.ts                   chat 抽象、路由、think effort
    models.ts                 按上游地址隔离的模型目录和 token 限制
    endpoint.ts               目录驱动的接口选择与协议策略
    responses.ts              Responses API 翻译、prompt_cache_key
    native.ts                 原生 Claude 传输及签名 WebSearch 历史
    stream.ts                 共用聚合逻辑与完整流校验
    tool-schema.ts            仅用于 Responses 的工具 schema 兼容处理
    types.ts                  上游 payload 类型

  lib/
    app-config.ts             readAppConfig()、写回、热重载
    config.ts                 运行期代理配置与请求策略快照
    atomic-file.ts            文件快照检查与原子替换
    address.ts                监听/客户端 URL 规范化
    request-trace.ts          RequestTrace、有序传输捕获及完成结果
    defaults.ts               发布默认值
    paths.ts                  ~/.copilot-relay 布局，import 时解析
    auth.ts                   token 存储与刷新调度
    models.ts                 路由 + thinkEffort 校验
    preflight.ts              启动期上游验证
    lifecycle.ts              pid 文件、findRelayOnPort、findRelayProcessIds
    log.ts                    formatLogValue、轮转、保留
    redact.ts                 纯函数 URL/密钥脱敏
    claude-settings.ts        ~/.claude/settings.json 管理
    tokenizer.ts              count_tokens 启发式
    upstream-diagnostics.ts   上游错误上下文采集
    error.ts                  错误整形
    state.ts                  运行期状态
    version.ts                构建版本
```

## 配置解析、写回与重载

`src/lib/app-config.ts` 中的 `readAppConfig()` 校验扁平标量文档并解析运行值，随后
`materializeMissingKeys` 仅向原始文本追加**缺失键**。注释、未知标量键、顺序、引号
写法及已有换行风格都会保留。重复的规范键/别名、不受支持的 YAML 和无效已知值会在
写回前报错；必填键为空不等于键缺失。新建/缺失文件使用包内模板（或旧配置）。

`src/lib/atomic-file.ts` 的 `readFileSnapshot` / `writeFileSnapshot` 解析符号链接，
但不替换链接本身；保留文件权限，先写私有临时文件，再原子发布完整字节。身份、目标
及内容检查拒绝已观察到的并发编辑；最初不存在的文件以排他方式发布。进程内协作写入
会串行化。这**不是操作系统级 compare-and-swap rename**：外部写入仍可能在最后一次
检查与替换之间竞争。`applyClaudeConfig` 共用这个边界，保留无关设置，并拒绝覆盖
格式错误或已经存在的空 JSON 文件。
若一次读取中唯一不一致的身份字段是 `ctime`，可以立即重新读取，最多共尝试三次。
每次重读必须与首次读取的字节、目标路径、权限及其他身份字段一致；其他变化或持续
不一致仍会拒绝。发布前的检查也可重新取得读取结果，但仍以包含 `ctime` 的完整身份
与调用方最初的快照比较。过期的写入绝不自动重试。

> 键一旦落盘，保存的值就优先于新的发布默认值。

不新增默认值迁移。用户固定的值属于用户；旧的 `configVersion` 迁移机制正是因此在
#26 中移除。

### 热重载与需要重启

热重载 —— 对改动之后开始的工作生效：

`logLevel`、`logRetentionDays`、`thinkEffort`、`upstreamTimeoutSeconds`、
`copilotBaseUrl`、`webSearchBackend`、`claudeUpstreamApi`、`gptModel`、`opusModel`

需要重启：

`host`、`port`、`claudeSetup`

`host` 和 `port` 动不了，因为监听 socket 已经绑定。`claudeSetup` 在启动时读取一次，
所以改它在下次启动之前什么都不会变。改 `gptModel` 会立刻改变上游请求路由，但不会
重写已经保存在 `~/.claude/settings.json` 里的模型 —— 那是启动时写的。

一次重载会记录它应用了什么：

```text
info Config reloaded: logLevel=debug thinkEffort=xhigh upstreamTimeoutSeconds=180
```

`ConfiguredReasoningEffort` 和 `configurableReasoningEfforts` 将合法配置默认值与请求级
`ReasoningEffort` 分开。`normalizeThinkEffort` 在配置写回和认证之前拒绝 `none` 及
其他格式错误的显式默认值；`startRelay` 也会校验程序直接传入的默认值。只有缺失的键
使用发布默认值。无效重载会记录错误并保留当前设置；一般文件或语法错误不会回显可能
含有敏感信息的配置内容。

`watchAppConfig` 只读：全部已知落盘键都必须存在，包括可选但留空的搜索后端。
空文件/部分保存不会恢复默认值。应用前还会校验第二次快照，读取或应用失败不会被标为
已接受，因此修正后可以重试。

新增一个键意味着同时更新 `config.default.yaml`、README，以及**两种语言**的
[配置说明](ZH-Configuration.md)。

## 请求翻译

### 接入检查与请求策略

`src/server.ts` 在推理前检查 Host/authority、显式 Origin 及 JSON content type。
这是浏览器来源/本地请求检查，**不是认证**；可从网络访问的非 loopback 监听器不受
Claude 占位 token 保护。

读取 POST 正文之前，`src/lib/config.ts` 的 `snapshotProxyConfig` 及
`src/lib/state.ts` 的 `snapshotRuntimeState` / `withRuntimeState` 为该请求固定路由、
base URL、超时、协议模式、搜索后端、effort 和目录视图。后续异步调用使用该请求作用域，
而非可变的全局状态。Token 和 generation getter 刻意保持实时，让重试使用刷新后的
凭据。该快照所选上游需要重新发现时，可更新自己的目录，不会切换到重载后的新策略。
接入阶段完成发现后，`pinCopilotModelCatalog` 为所有阶段固定该目录引用，即使发现
结果中没有目标模型也一样。输出预算处理不能在 SSE 开始后重新发现并改变能力；
token 计数仍完全本地，不会固定或刷新推理目录。

### 翻译后的历史

`src/claude/translate.ts` 处理双向非流式 payload：Claude 请求 -> Copilot chat 请求，
以及 Copilot 响应 -> Claude 响应。它在两种协议形状之间映射 tool call 和
thinking/text block。消息内的 system 文本保留原位置的 `role: system`，包括工具结果
之后；不能变成 assistant 发言，也不能附加 assistant 续写提示。`validateClaudeMessages`
在翻译路径上只接受唯一键为 `effort` 的 system `output_config`，其值必须为
`low`、`medium`、`high`、`xhigh`、`max` 之一。历史标记具有不同档位是合法的。
校验和 effort 选择共用 `src/claude/utils.ts` 的 `isEffortOnlyControl`，避免已被接受的
切换被静默忽略。

上游 tool call 的 `arguments` 通过 `src/claude/utils.ts` 的 `parseUpstreamToolInput`
转换为 Claude 的 `tool_use.input`，`translateToClaude` 与流式的
`translateChunkToClaudeEvents` 共用该函数。对于不接受参数的工具，Copilot 发送空字符串
而不是 `{}`，因此空白或仅含空白字符的文本视为空对象；流式路径随后输出
`partial_json: "{}"`，因为客户端会解析累积文本，而 `""` 不是 JSON 对象。非空但不是
JSON 对象的文本会抛出 `UpstreamToolInputError`：非流式路径返回 HTTP 502
`api_error`，流式路径在 SSE `error` 事件中给出同一消息。该消息只写明工具名，从不回显
参数文本，因为其中可能包含用户数据。其他流式失败仍使用通用错误消息。

`getClaudeTurnEffort` 先校验初始顶层 effort，再只读遍历消息。合法的 system effort
标记先处于待生效状态，直到后续 `role: user` 消息将它激活；仅包含工具结果的 user
消息也算。最后激活的值生效；最新 user 之后的标记仍待生效。翻译保留 system 文本
和顺序，消化空的 effort-only 消息而不插入空 system 提示，并将当前档位映射到上游
请求字段。追加切换不会改写既有翻译前缀，也不会在工具调用与结果之间插入控制消息。

额外/未知键、null/数组控制、内联 `none` 和任何 `clear_at` 仍在翻译路径被拒绝。
未知角色、格式错误的 system 文本也会被拒绝。接入校验发生在推理请求或 SSE 之前，
即使 `stream: true` 也返回 HTTP 400 JSON；`translateToOpenAI` 对直接调用和 token
计数重复校验。原生消息保留初始设置与逐消息控制字段，由上游解释。辅助函数在原生
路径遇到无法解释的控制时跳过它，不会为了诊断而改写请求。

`src/claude/tool-names.ts` 在出站时把 Claude 工具名规范化成 Copilot 可接受的名字，
入站时再映射回来。Claude Code 的工具名不总是合法的上游标识符，而一个带着规范化后
名字的响应，与客户端注册的那个工具对不上。

`src/lib/models.ts` 中的 `getRequestReasoningEffort` 和 `resolveReasoningEffort`
保留初始字段优先级与配置回退规则。Claude 专用辅助函数解析已激活的内联控制后，
翻译层将当前档位固定到 chat payload。Chat/Responses、requested/effective 日志及
WebSearch 检索使用这个当前值，翻译路径的最终回答 payload 直接继承它。请求级运行时
快照保证配置热重载不会改变某阶段的回退值。
原生请求保留原控制字段；诊断和搜索检索使用规范化后的出站历史，包括恢复出的 user
工具结果回合。原生后续调用追加 user 工具结果时，可能激活待生效标记。即使后续标记合法，错误的
初始 effort 仍会被拒绝。见[配置说明](ZH-Configuration.md)。

稳定的翻译文本前缀和 Responses 缓存键是回归约束，不是缓存命中率不变的保证：翻译
协议在请求级表达 effort，切换可能使上游缓存失效。原生逐消息控制保留原样，交由
提供方实现缓存保持语义。

`src/claude/types.ts` 只定义代理需要的那部分 Claude Messages API 类型。它刻意不是
完整的 Claude SDK —— 一个用不到的类型就是没有测试覆盖的维护成本。

## 原生 Messages、chat 与 Responses

`src/copilot/chat.ts` 为 routes 与启动 preflight 发送已解析好的上游 ID。
`src/copilot/endpoint.ts` 的 `selectCopilotEndpoint` 通过 `getCachedCopilotModel`
读取当前提供方的 `supported_endpoints`，探测和真实请求共用该选择器。固定的旧偏好
只用于多接口选择和元数据缺失，不再是不断扩大的模型白名单。
`requireCopilotEndpoint` 在接入阶段、SSE 之前，把固定的不支持原因变成本地错误。
Claude 的显式协议策略优先；选择结果还指明是否允许仅针对特定错误码的
`/chat/completions` 到 `/responses` 恢复。被恢复的失败正文会标为 discarded 并取消，
让捕获/replay 记录一致的调用顺序。

`src/copilot/models.ts` 的 `resolveModelReasoningEffort` 区分显式请求与配置默认值。
`translateToOpenAI` 传递 `getClaudeTurnEffort().requested`，适配器只解析一次，Chat
和 Responses builder 都不会重新添加已刻意省略的值。在 `parseReasoningEfforts` 中，
目录的 `reasoning_effort: false` 和省略该键的 `supports` 对象都转换为
`reasoningEfforts: []`；缺少 `supports` 对象及格式错误的接口/档位数组保持未知，不会
过滤成权威的空数组。捕获/replay 使用已有数组字段，无需新格式。探测的 `route_source` 和白名单
接口详情说明选择过程，不会打印原始元数据。用户策略见[配置说明](ZH-Configuration.md)。

`src/copilot/responses.ts` 为任意选中的兼容模型翻译 Copilot Responses 与
chat-completion 风格结果。检索仍是独立的 Responses `web_search_preview` 操作；
决策/最终阶段使用共享适配器，但仅支持 Chat 的搜索后端会产生结构化搜索失败，
不会把普通聊天伪装成检索。能力缺失保持未验证，不代表支持内置搜索。

### 原生 Claude 边界

`src/copilot/native.ts` 的 `shouldUseNativeMessages` 仅作用于路由后以 `claude-` 开头
的 ID。`auto` 要求当前上游目录公布 `/v1/messages` 支持，`messages` 强制原生，
`chat-completions` 固定 Chat 翻译。最后一项仍是默认值；非 Claude 模型不受该
Claude 专属设置影响，按目录选择翻译接口。

`createNativeMessages` 保留消息/block 结构、签名 thinking 与 redacted-thinking block、
缓存标记、原位置的 system 角色/控制字段及原生响应元数据，不经过 chat 扁平化。
它仍会路由模型、约束输出、解析 effort 并适配 relay 的 WebSearch 声明。协议 header
明确传递 `anthropic-version` 和可选 `anthropic-beta`；上游认证由共用 Copilot 客户端
负责，不使用客户端认证 header。超过原生非流式上限时请求 SSE，再聚合为 JSON。
`nativeEvents` / `collectNative` 保留签名和尾部 usage，SSE 必须有 stop reason 及
`message_stop`。错误或提前 EOF 不会被当作成功；也不会改走其他 API 来绕过原生
错误/拒答。

`src/lib/model-probe.ts` 的 `probeModels` 通过 `reportsSelectedModel` 将返回模型与
准确的目录选择比较。除原有的 GPT context 后缀规范化之外，只接受以下已观察到的
provider 行为：

- 原生拼写：接口为 `/v1/messages`，所选 ID 为 `claude-opus-5.5`，返回
  `claude-opus-5-5`。
- Priority 层级：接口为 `/responses`，所选 ID 为 `gpt-5.6-sol-fast`，返回
  `gpt-5.6-sol`。目录将该项命名为 "GPT-5.6 Sol Fast"，实际回复报告
  `model: gpt-5.6-sol` 及 `service_tier: priority`。
- 带日期快照：不带日期的所选 ID 在返回时附加一个 `-YYYY-MM-DD` 日期，实际回复中
  `gpt-5.5` 报告 `gpt-5.5-2026-04-23`，`gpt-4o` 报告 `gpt-4o-2024-11-20`。带日期的
  所选 ID 必须完全一致。

这些都不是通用标点规范化、`-fast` 或后缀剥离，也不是新增目录别名。
`claude-opus-5-5-preview`、`claude-opus-5`、报告为 `gpt-6-sol` 的 `gpt-6-sol-fast`、
`gpt-5.5-preview`，以及上游改由其他模型应答的别名（`gpt-4` 和 `gpt-4o-2024-05-13`
都报告 `gpt-4.1-2025-04-14`）仍失败。配置和发现保留目录 ID，`SENT/REPORTED` 保留
两种实际拼写。接受仍需通过正常的完整文本/终止检查；不能只因为模型匹配就把拒答当作
`PASS`。

上游 HTTP 400 且 code 为 `model_not_supported` 时，单独报告为 `Model not supported`，
与请求内容被拒绝的情况区分。`trajectory-compaction` 列在目录中，但上游以此拒绝。

隐式探测 effort 为高于 `none` 的公布最低档。仅当 `none` 是唯一公布的档位时才探测它：
relay 自身从不发送 `none`，而 `gpt-6.1-sol` 公布了它却以 HTTP 400
`invalid_request_body` 拒绝。显式的 `--effort none` 仍按请求发送。

### 工具 schema 兼容性

`src/copilot/tool-schema.ts` 中的 `normalizeResponsesToolSchema` 在共用的
`buildResponsesRequestPayload` 边界适配函数参数。Copilot 会拒绝包含 `\p{Cc}`、
`\P{L}` 等 Unicode 属性转义，以及 `(?!...)` 等前瞻或后顾断言的 JSON Schema
`pattern` 约束。Claude Code 的 `Artifact` 工具在 `field`、`database` 和 `doc_id`
参数中包含这些 pattern，即使用户从未调用该工具，也会随请求发送。仅删除 Unicode
pattern 后，上游的下一层校验仍会拒绝前瞻断言。

中继只从发往上游的副本中省略这些 pattern，保留受支持的 pattern 和其他 schema
字段。转义后的字面字符，以及字符类中形似环视断言的文本，均保持不变。
遍历仅针对承载 schema 的关键字，不会改写 `default`、`const`、`enum`、
`examples` 中的字面数据，也不会改写属性名。原始 Claude schema 和
`/chat/completions` 路径保持不变；客户端工具校验仍执行原始约束。所有使用 Responses
的流式、非流式以及 WebSearch 模型调用都经过同一适配。规范化是写时复制的：不需要改动的
schema 作为同一个对象发送，省略 pattern 时只复制通往它的路径上的对象，因此较长的工具
列表不会在每个请求中重建。

`src/copilot/responses.ts` 中的 `translateTools` 还会在每个 Responses 函数工具上
显式设置 `strict: false`。省略该字段时，上游可能把兼容的 schema 规范化为严格模式，
使原本可选的属性变为必填。显式使用非严格模式可保留 `Agent.isolation`、`Read.pages`
以及嵌套属性的可选语义，不注入 null 或默认值，也不删除或改写返回的参数。
该设置不用于内置 `web_search_preview`，也不影响 `/chat/completions` 工具。

### 上游连接

`src/copilot/client.ts` 中的 `fetchCopilot` 通过同一个只用 HTTP/1.1 的 undici
`Agent` 发送所有上游请求。Copilot 不发送 `Keep-Alive` 提示，因此 undici 默认在连接
空闲超过 4 秒后关闭它，下一个请求要重新进行 TCP 和 TLS 握手。#141 中 Copilot 复用了
空闲 60 秒的连接，而空闲 120 秒的连接已被关闭；Agent 现在把空闲连接保留 50 秒。

`package.json` 要求 undici 7.30 或更高版本。undici 7.28 在复用空闲 socket 之前，用一个
unref 的零延迟定时器检查它；在 Windows 上，这个定时器可能要等到下一次系统定时器 tick。
`tests/unit/copilot-client.test.ts` 覆盖这两点。

## 流式

### 长 context 与输出预算

`src/copilot/models.ts` 中的 `loadCopilotModelCatalog` 保留 preflight 读取的模型
目录。限制数据绑定到准确的上游 base URL；地址改变后会先重新发现，再使用预算。
并发刷新共用一个请求，较旧的响应不能覆盖新上游的目录。缺失或无效的限制元数据不会
被替换成猜测的容量。

`boundModelOutputTokens` 按实际路由模型公布的最大输出限制请求，同时不会提高客户端
明确指定的较小预算。Preflight 和深度健康检查仍保留 16-token 预算。Prompt 内容不会
为了适应限制而被切片。`count_tokens` 在有数据时使用受支持的已发现 tokenizer，并在这种情况下
跳过旧的 Claude 系列 15% 余量，避免已有 tokenizer 数据时仍因模型名称启发式而过早
压缩。本地模型发现返回缓存的限制，不会调用上游。

Preflight 之后、开始监听之前，`start` 会加载回退用的 `o200k_base`，以及配置模型报告的
每个受支持 tokenizer，因此第一个 `count_tokens` 请求不必等待构建编码器。热重载换入的
模型在首次使用时加载它的 tokenizer。

`src/lib/tokenizer.ts` 在任何文本编码调用之前，为**每张图片分配 4096 个估算 token**。
不会把 base64/URL 文本送入 tokenizer，不解码图片，也不拉取 URL。文本继续使用所选
tokenizer，消息/工具启发式及适用的旧余量仍保留。这是客户端预算估算，**不是上游计费**，
也不能证明多模态 prompt 一定符合容量限制。

某些模型公布的 `max_non_streaming_output_tokens` 小于流式上限。超过该阈值时，
`createChatCompletions` 会向上游请求 SSE，再由 `collectChatCompletionStream` 为
JSON 调用方及 WebSearch 最终模型调用返回完整 chat 响应。它复用 WebSearch 的聚合器，
保留 usage、推理、工具参数片段和 `length` 终止原因，并拒绝不完整的流，而不是构造
成功结果。普通流式调用方仍然实时接收 chunk。

Claude 自动预算、模型选择器处理，以及可选的无总超时设置，见
[配置说明](ZH-Configuration.md)。`tests/integration/model-text-limits.test.ts` 在
两种响应模式下完整传递经 tokenizer 计数的 872K/936K-token prompt 和
128K/64K-token 输出；上游使用 mock，不会执行付费的百万 token 生成。

### Claude SSE 翻译

`src/claude/stream.ts` 把流式 Copilot chat chunk 转换成 Claude SSE 事件。它是一个
状态机，因为 Claude 要求 text、thinking、tool use 的 content block 按正确顺序显式
start/delta/stop —— 而 Copilot 的 chunk 流里没有这种分帧信息。

终止状态与 usage 是两回事：输出耗尽映射为 `max_tokens`，过滤/拒答保留为拒答，
failed/cancelled 的 Responses 终止事件作为错误报告，尾部 usage 不得抹掉终止原因。
交错的工具参数片段绝不能指向已关闭的 Claude content block。回归覆盖在
`tests/unit/stream-terminals.test.ts` 和 `tests/unit/native-messages.test.ts`。

### 声明 WebSearch 不再需要放弃流式

Claude WebSearch 由中继托管执行：中继通过 Copilot `/responses` 加
`web_search_preview` 执行搜索，然后把检索到的上下文再送一次模型，最后返回 Claude
的 `server_tool_use` / `web_search_tool_result` block。最后那次调用保留客户端的其他
工具，所以模型可以在同一回合里对搜到的内容采取行动。

由此带来的问题是：中继必须先知道模型是否选择了 `web_search`，才能在普通补全和桥接
路径之间做选择。以前的做法是：只要请求**声明**了这个工具，就强制 `stream: false`
—— 而 Claude Code 每一个回合都会声明它，于是几乎所有流量都付出了"先缓冲补全、再回放
成合成 SSE"的代价。

`src/claude/web-search-stream.ts` 里的 `resolveWebSearchStreamDecision` 只把决策
阶段读到"足以判定是否会发生搜索"为止，并且边读边把消费掉的 chunk 发出去：

- **没有搜索** —— 这个回合和普通流式流没有区别
- **有搜索** —— 响应被累积起来，原样交给桥接路径

**文本永远不能作为判据。** Copilot 经常在调用工具之前先写一段开场白（"我这就去
搜索。"）。把已经出现的内容当成"不会有搜索"的证据，会让随后的 `web_search` 调用逃过
拦截，以一个名为 `WebSearch` 的**客户端** `tool_use` 抵达 Claude Code —— 这是一个
畸形回合，因为客户端认为这个工具本该由服务端执行。只有具名的 tool call 或
`finish_reason` 才能作数。`tests/unit/web-search-stream.test.ts` 固定了这一点。

当开场白已经流出之后才检测到搜索时，搜索 block 会接在已打开的那条消息上，而不是另
起一条，从而得到原生顺序 `text` → `server_tool_use` → `web_search_tool_result` →
`text`。

### 原生 WebSearch 历史

`handleNativeMessages` 仍通过 Copilot Responses 检索，会话本身保持原生 Claude。
原生 bridge 搜索只支持自动选择：`validateNativeMessages` 对声明 WebSearch 时强制
`any`、显式强制搜索或无法识别的 bridge 历史，在上游操作/SSE 之前返回 HTTP 400 JSON，
流式调用也一样。每回合最多执行一次搜索；多次或重复搜索调用直接失败，不循环。
决策前 text/thinking 可以流出，工具 block 则暂存，直到 relay 判断是否需要执行服务端搜索。

发往上游的续接保留决策中的签名 block 及原始 provider 工具 ID/名称。对客户端，仅把
搜索调用替换为 `server_tool_use`，后接 `web_search_tool_result`。确定性的
`srvtoolu_relay_` 标记编码原始工具 ID/名称及 block/回合边界。`normalizeNativeHistory`
在下一请求中解码校验，重建原始决策、user 工具结果回合和可能存在的最终 assistant block。
该标记**不是 provider 签名**，不会伪造或改写 thinking 签名。搜索数据明确视为不可信。
同批客户端工具调用保留 ID，交给客户端处理，而不是由 relay 执行。

无法识别的旧 chat bridge 搜索历史在原生路径被拒绝，不会静默扁平化。切换协议不等于
透明迁移已有搜索会话。测试固定的是重建行为，不是实时缓存性能，也不能证明历史拒答原因。

## Prompt 缓存

长时间的 Claude Code 会话每次请求都会重发一大段基本不变的前缀（system prompt、工具
定义、之前的回合）。这段前缀上的 prompt 缓存命中，是输入 token 成本和延迟的主要杠杆。
应将较早的 chat/Responses 翻译路径测量，与下文 2026-09-30 的有限原生对照分开看待；
两者都不能证明所有账号或工作负载的表现。

### 用 `prompt_cache_key` 提示 `/responses` 缓存路由

Relay 发送稳定的 `prompt_cache_key` 作为缓存路由提示。此前对 GPT-5.5/5.6 系列的
Copilot `/responses` 测试观察到，省略该 key 时缓存读取会掉到 0。但这不能证明所有模型
都需要它：下面的对照测试中，Astra 在没有 key 时也产生了缓存命中。仅有 key 既不能保证
缓存命中，也不能替代稳定的 prompt 前缀。

`buildResponsesRequestPayload` 派生一个按会话的 key：

- 优先使用客户端会话 id（Claude Code 会发送稳定的 `metadata.user_id`，在
  `payload.user` 上体现）；
- 没有 user id 时，退化为 system prompt 的哈希。

key 本身是一个 SHA-256 摘要（`cr-` 加 32 位十六进制字符），所以
`prompt_cache_key` 本身不会暴露它是从哪个标识符派生出来的。

**但这并不等于整个请求做了匿名化。**
`buildResponsesRequestPayload` 在设置 `prompt_cache_key` 的同时，还会单独设置
`user: sanitizeUserIdentifier(payload.user)`。`src/copilot/chat.ts` 里的
`sanitizeUserIdentifier` 只是把字符串截断到 64 个字符 —— 它不做哈希 —— 因此
Claude Code 发来的那个标识符会原样出现在同一个请求的 `user` 字段里转发到上游。
`/chat/completions` 路径也是同样的转发方式。

实践建议：把 `metadata.user_id` 当作 GitHub Copilot 会看到的值来对待，不要在里面
放密钥或个人信息。对缓存 key 做哈希保护的是缓存路由值，不是这个标识符。

此前用 `gpt-5.5`、稳定 user id 和大前缀进行的端到端测量中，预热后的缓存读取约为
100%，不带 key 时为 0。这只是该模型及该工作负载的测量，不是普适的缓存前提。

### GPT-6 Astra 缓存验证

2026-09-05（UTC），向 Copilot `/responses` 发送了六次小规模非流式请求，使用
`gpt-6-astra`、`low` effort、合成前缀及 relay 实际的
`buildResponsesRequestPayload`。每组使用独立的前缀标记，并连续发送三次完全相同的
请求。两组都保留稳定的合成 `user`；无 key 组仅从构造后的 payload 中删除
`prompt_cache_key`。

| 请求 | 带稳定 key：缓存 / 输入 tokens | 不带 key：缓存 / 输入 tokens |
| --- | --- | --- |
| 第一次（冷缓存） | 0 / 9,789 | 0 / 9,789 |
| 第二次 | 9,786 / 9,789（99.97%） | 9,786 / 9,789（99.97%） |
| 第三次 | 9,786 / 9,789（99.97%） | 9,786 / 9,789（99.97%） |

六次请求均返回 HTTP 200 和 `OK`，每次输出 5 tokens。Relay 的 Responses 到 Claude
翻译保留了 `cache_read_input_tokens: 9786`，并在热缓存请求中报告 3 个未缓存输入 tokens。

这证实 Astra 接受现有 key，并能在带 key 的请求中返回缓存命中。无 key 对照组也命中了
缓存，因此本实验**不能**证明 Astra 必须使用该 key，也不能证明它能提高命中率。保留
稳定 key，同时测量真实工作负载：本次单账号、`low` effort 的短测试不代表 `max`、
并发、缓存过期后或接近 1M 上限时的表现。

### assistant 的 `thinking` 保留在上游历史里

缓存命中依赖前缀在多个回合之间逐字节稳定。Claude Code 会在 assistant 历史里回放
`thinking` block，中继把它们作为上游 assistant 内容转发出去。

在转发前剥掉 `thinking` 会重写这段前缀，从而**让缓存失效**。在一个超过缓存阈值的
8 回合会话上实测：转发 `thinking` 时命中率约 99%（每回合 130 个全价 token）；剥掉之
后掉到约 88%、约 1066 个全价 token。

所以 `thinking` 是被**刻意**保留在上游历史里的。它是让前缀保持稳定的一部分，不是可
以顺手削掉的开销。翻译路径保留的是扁平化 assistant 内容，不是 provider 签名原生 block。

### Opus 5.5 匹配缓存试验（2026-09-30）

一次有限的实时对照使用 `low` effort、相同的合成 720 条参考记录格式、每条路由独立的
前缀标记，并在每条路由执行三个只追加历史的会话回合。完成的那次试验报告：

| Chat 回合 | 总输入 tokens | 缓存读取 tokens | 输出 tokens |
| --- | ---: | ---: | ---: |
| 1（冷缓存） | 25,960 | 0 | 4 |
| 2 | 25,981 | 25,939 | 4 |
| 3 | 26,002 | 25,960 | 4 |

| Native 回合 | 非缓存 `input_tokens` | 缓存写入 tokens | 缓存读取 tokens | 输出 tokens |
| --- | ---: | ---: | ---: | ---: |
| 1（冷缓存） | 21 | 25,936 | 0 | 4 |
| 2 | 42 | 0 | 25,936 | 4 |
| 3 | 63 | 0 | 25,936 | 4 |

原生输入计数应相加：非缓存 `input_tokens` 加 `cache_creation_input_tokens`，再加
`cache_read_input_tokens`。Chat 总输入已包含缓存输入。不要拿原生缓存读取除以其
非缓存 `input_tokens`，也不要只比较不同 API 的这个字段。

对热回合 2–3，按 token 加权的缓存读取占比为：

- Chat：`(25,939 + 25,960) / (25,981 + 26,002)` = **99.8384%**。
- Native：`(25,936 + 25,936) / ((42 + 0 + 25,936) + (63 + 0 + 25,936))` = **99.7980%**。

在这次已完成试验中，原生占比约**低 0.04 个百分点**。第二次试验为平衡执行顺序，先跑
native；其首次冷请求返回拒答，试验随后停止。中断也是结果的一部分，不能隐去或声称
完成了重复对照。

这些小规模 `low` effort 观察只说明被测序列存在热缓存复用，不能证明跨 effort、并发、
缓存到期、长会话或接近容量上限时广泛无退化。**无法确定计费成本等价**：native 明确
报告冷缓存写入，chat 没有暴露对应类别。默认值继续保持
`claudeUpstreamApi: chat-completions`，现有证据不足以提升原生为默认。保留签名历史是
正确性要求，但仍未证明历史拒答是推理内容扁平化导致的。

### 隔离 Claude Code 检查（2026-09-30）

真实 Claude Code **2.1.285** 在原生路径上完成了两个模型回合的 `Read` → 工具结果 →
`OK`。最初两次请求因不支持 `safeguards` 字段收到 HTTP 400，随后是**客户端**自行
降低了请求能力。Relay 没有剥离 `safeguards`、新增拒答回退或绕过 provider 安全控制。
这只证明观察到的客户端/工具续接，不代表被拒字段或全部 Claude Code 功能都受支持。

预热后的第二回合以全部已报告输入类别为分母，缓存读取占比为
`3029 / (3029 + 146 + 2)` = **95.34%**。这是与合成对照不同的工作负载，不能并入其
热缓存率。

冗余内联 effort 修复后，另一次独立的真实 CLI chat 路由检查也完成了两个工具回合并
返回 `OK`。两次独立客户端运行因此分别验证了两种协议在该流程中可用，但**不是匹配的
缓存对照**。验证会话使用了计划中 20 次请求预算的 18 次，HOME 状态哈希未变化；这些
操作检查不能证明通用客户端兼容性或生产就绪。

完整的已观察原始正文已私有捕获，记录的成功及拒答案例经当前 handler 离线重放都返回
`MATCH`。匹配的拒答仍是拒答，重放也不是新的上游验证。这些均为隔离检查，**不是对
当前生产 relay 的验证**，生产端口 4142 未受影响。这里只记录汇总证据，不放私有
捕获正文或凭据。

## Token

`github_token` 是长期登录/刷新来源。

`copilot_token.json` 缓存短期 Copilot bearer token 及元数据：

```json
{
  "refreshedAt": 0,
  "refreshIn": 0,
  "token": "..."
}
```

启动时，如果缓存的 Copilot token 还有超过 60 秒有效期就复用；否则用 `github_token`
刷新。刷新定时器必须使用 `unref()`，以免让短命的命令一直活着。

刷新期限尚未到达，并不能证明上游仍接受该 token。`setupProxyAuth` 会在运行时配置上
安装非交互刷新回调。`src/copilot/client.ts` 中的 `fetchCopilot` 对 HTTP 401，以及
正文完整内容为纯文本 `forbidden` 的 HTTP 403 使用该回调（忽略大小写和首尾空白，
最多 128 字节）。结构化的模型、策略或配额拒绝保持原样。provider 保留原 base URL，
但每次尝试都读取当前 token。

定时刷新和请求触发的刷新共用一个正在进行的交换操作。通过实际发送的 token 和刷新
代数识别延迟到达的拒绝，已完成的刷新会被复用，即使替换 token 的文本完全相同。
替换值先写入私有临时文件，再原子重命名覆盖缓存，随后更新内存状态并重新安排定时器。
每个上游操作最多进行一次认证恢复，加上原有瞬时故障重试额度，总计最多三次 HTTP
尝试；chat 到 Responses 的 fallback 是独立操作，但仍受同一个调用方期限约束。

取消或超时的调用方停止等待，且不会重放；其他调用方仍可使用共享交换结果。共享交换
有独立且有限的上游超时（配置禁用超时时使用 180 秒）。只恢复明确被拒绝的 HTTP 响应，
不会重放成功响应或已开始的流。刷新失败直接报告，不触发设备登录，也不会被当作网络
故障反复重试。

Token 恢复日志只包含状态码、路由和结果，不含 bearer 凭据或响应正文。这不是对原始
捕获的保证：用户提示词或上游回显本身仍可能包含密钥。

## 生命周期：status 和 stop 问的是不同的问题

`src/lib/lifecycle.ts` 暴露两种检测策略，而**它们必须保持不同**：

| 命令 | 函数 | 策略 |
| --- | --- | --- |
| `status` | `findRelayOnPort` | 端口匹配时用 pid 文件，否则用端口监听检查。绝不做全局进程扫描。 |
| `stop` | `findRelayProcessIds` | 做全局扫描，因为清理任意端口上的残留进程正是它的目的。 |

不要把两者"统一"。给 `status` 加上全局扫描，会让它报告一个"端口上根本没人监听"的
中继（#33）；把 `stop` 收窄到单端口，则会留下残留进程。

无论 `status` 报告什么，**pid 和地址必须来自同一条记录**。把用一种方式找到的 pid 和
用另一种方式取到的地址配在一起，正是 #33 里"活的 pid 旁边打印出一个死端口"的成因。

`isRelayStartProcess` 同时识别 `start` 和长期运行的 `restart` 进程，严格检查可执行
文件/入口，而不是任意命令子串。发送信号及升级强制终止前，生命周期代码检查一致的
命令、工作目录和创建时间身份。身份无法取得不是退出证明，PID 被复用也不能授权终止
替代进程。未知/存活 PID 的记录会保留，不会当作清理成功而删除。有歧义的 POSIX 扁平
路径必须通过文件系统验证精确入口，并排除更早的可执行文件/脚本解释；这是保守证据，
不是操作系统级原子身份保证。初次发现状态未知会在有限宽限期内重试，之后失败而不发送
信号。`status` 对进程检查不确定性输出诊断并以 `2` 退出，不声称进程不存在。

对于入口不在 `copilot-relay` 或 `copilot-relay-*` 目录下的 `node <entry> start|restart`
进程，例如位于 `~/.copilot-relay/runtime/0.4.1/dist/main.js` 的发布版运行时，改由包
清单识别（#113）：`src/lib/lifecycle.ts` 的 `packagedEntryCandidate` 接受绝对路径或按
cwd 解析的 `dist/main.js` 或 `src/main.ts`，`packageEntryProof` 要求该路径是普通文件，
且其规范路径对应的 `../package.json` 中 `name` 为 `"copilot-relay"`。任何无法证明的
情况都判定为 `nonrelay`，与这些命令此前的判定相同，因此无关的
`node app/dist/main.js start` 不会收到信号，也不会阻塞 `stop`。

配置损坏时，`status` 在探测前输出不回显敏感内容的诊断并以 `2` 退出，不表示 daemon
已停止。`stop` 可不依赖配置端口提示，继续只处理身份已验证的进程。重启前应修复配置。

### 退出码是一份契约

| 退出码 | 含义 |
| --- | --- |
| `0` | 进程活着**并且**健康探测通过 |
| `1` | 没有中继在运行 |
| `2` | 不可用或无法建立状态 —— 健康/deep 探测失败，或配置不可读 |

一边打印 `FAILED` 一边以 `0` 退出，会让每一个脚本调用方把坏掉的中继当成正常
（#34）。

`--deep` 会额外经由 Copilot 发一个真实请求。它是唯一能证明中继真的可以服务 Claude
Code 的检查，因为 `/healthz` 和 `/v1/models` 都不访问上游。它是可选的，因为要花掉
一点 token。

### 关停：只调用 `server.close()` 关不掉

`server.close()` 会等待已有连接结束，而一个空闲的 Claude Code keep-alive socket 自己
永远不会结束。于是关停会一直挂着，直到 `stop` 升级为 `SIGKILL` —— 而 `SIGKILL` 会跳
过 pid 文件清理，并且照样把流切断（#35）。

处理函数必须立即调用 `closeIdleConnections()`，并在一个**短于 `stopProcess` 的 5 秒
超时**的宽限期之后调用 `closeAllConnections()`。宽限期等于或超过那个超时，就等于把
这个 bug 放回去。
服务关闭后，`startRelay` 停止配置 watcher，清理自己的 PID 记录，再等待
`flushCaptures` 与 `flushLogs`；强制终止进程不能保证同样的落盘结果。

## 捕获与离线重放

`src/lib/request-trace.ts` 的 `RequestTrace` 包装已接入的客户端正文和实际消费的
上游/下游流，不另开独立 tee。`recordedFetch` 与 `recordedRefresh` 保留有序尝试、
为重试丢弃的响应及刷新结果。Manifest 记录请求的策略/目录快照、chunk 长度、观察到的
字节数、正文状态和 handler 是否结束；等正文写入队列完成后，原子替换 `meta.json`。
私有文件 handle 保持追加目标；目录/文件身份与单链接检查拒绝已观察到的路径替换。
这不能防御同一用户下所有可能的文件系统竞争。传输/正文失败与语义上的拒答不是同一件事。

`OutcomeObserver` 在正文存储之外提取有界元数据：HTTP 状态、stop/finish/response
终止状态、拒答类别、未完成原因，以及已报告的输入/输出/缓存用量。缺失或过大的元数据
是未知，不代表成功完成或零缓存用量。普通 `info` 结果行只包含这些元数据，不含提示词
或响应文本。

`withTraceObserver` 为进程内调用者提供请求作用域的 handle，不新增 HTTP API，也不读取
捕获文件。回调只保存 handle：必须消费响应之后才能等待 `finished`。`probeModels`
限制诊断等待时间，之后调用 `diagnosticSnapshot`，而非输出整个 manifest。快照会用
全部已登记凭据（包括刷新后的 token）重新过滤允许列表中的标识符，只输出已知接口、
状态、结果和捕获状态。未知错误不能证明责任在上游。

`src/lib/model-probe-output.ts` 负责展示，`src/lib/terminal.ts` 的颜色策略不依赖模块
导入时的环境快照。Status 文字使用同一策略，但 JSON 和探测逻辑不变。深度检查启动
使用 `withoutConsoleLogging` 保留文件证据；推理和正文消费使用 `withoutLogging`
避免原始 payload 泄漏，再单独记录一条安全失败摘要。设备认证提示通过明确回调绕过
安静启动模式。

只有 debug 才生成正文文件。`safeHeaders` 使用不含认证 header 的允许列表，策略快照
省略 bearer token 和私有上游 URL 尾部。**原始正文字节刻意不脱敏**，可能包含提示词、
工具结果或上游回显中的凭据。有界异步写入队列不会让磁盘吞吐阻塞转发；过载/写入失败
会将捕获标为不完整，而不是静默截断后仍声称可以重放。操作限制、权限和安全处理见
[日志与问题排查](ZH-Logging-Troubleshooting.md)。

`cleanupCaptures` 与日志共用 `logRetentionDays`，按本地日历日期目录计龄，在启动/
重载时运行。`cleanupCapturesIfDue` 在非重放请求中增加每小时一次的检查。活动捕获和
owner 存活/未知的 pending 记录保留，只有 `ESRCH` 才证明 pending owner 已退出。
清理要求目录/manifest 身份有效，且只含已知的普通单链接文件；未知或变化中的内容
不动。`flushCaptures` 在优雅关停时等待清理与 pending 捕获，不能挽救崩溃或 SIGKILL。

`src/replay.ts` 的 `replayCapture` 在进程内调用 `createServer(config).fetch` 前校验
元数据/schema、固定正文文件名、chunk 总长、路径与大小限制。`withRecordedTransport`
只按原顺序提供记录的上游响应、错误和刷新结果。不创建监听器/socket，不执行设备认证、
token 交换，不写配置或新捕获。它比较当前 handler 实际生成的出站 JSON 与最终 JSON/SSE；
未消费或意外的操作被标为差异，不回退到网络。已校验 manifest 的请求 ID 通过内部
recorded transport 传入，以准确复现本地错误关联文本；客户端 header 无权选择此 ID。
当前错误文本变化后，旧错误记录合理地可能返回差异。

比较忽略传输 chunk 分界，仅规范化已知的新生成 bridge ID，并保护 provider ID 和字面
内容。Diff 只输出结构路径和固定原因，不输出值或来自 payload 的属性名。`MATCH` 表示
本地转换一致，不是新的模型执行、缓存基准，也不能证明历史拒答的原因。未完成/中止
捕获不能得到匹配；CLI 结果表见[日志与问题排查](ZH-Logging-Troubleshooting.md)。

## 日志不变量

单行与轮转规则来自一个涨到 9.3 GB 的日志。原始捕获文件是独立诊断通道，不是更大的普通日志条目。

### 一条日志，一行物理行

`src/lib/log.ts` 里的 `formatLogValue` **同时**需要 `compact: true` 和
`breakLength: Infinity`。

Node 文档读起来像是默认的 `compact: 3` 就够了 —— 并不够。那个数字统计的是被合并的
内层元素个数，不是阈值，所以它只会折叠嵌套深度不超过该计数的 payload。在一个真实的
4 层错误 payload 上：

| 设置 | 产生行数 |
| --- | --- |
| `compact: 3` | 10 |
| `compact: 1` | 22 |
| `compact: true` | **1** |

`tests/unit/log-format.test.ts` 固定了这一点；不要把它"简化"掉。多行 dump 还会打断
[日志与问题排查](ZH-Logging-Troubleshooting.md)里的每一条 `grep` 配方 —— 因为搜索
返回的会是某个 payload 的第一个片段，而不是匹配的那条日志。

对象检查的边界是深度 6、100 个数组元素、对象内每个字符串 4000 字符。URL 和已登记
凭据脱敏后，再转义换行并按 UTF-8 边界限制最终大小：每个渲染参数 16 KiB、每条文件
日志（含时间戳等格式）64 KiB。两端收到相同的有界 payload，最终大小截断用
`[truncated]` 标明。这些限制不截断独立的原始捕获。

### 保留策略需要轮转

当前文件是 `copilot-relay.<本地日期>.log`，每条日志在记录时解析路径，因此无需定时器即可在
本地零点轮转。

保留策略按**文件名里的日期**判断文件年龄，对没有日期戳的文件退化为按 mtime 判断。
之所以优先用文件名，是因为 mtime 会被备份、`cp` 以及编辑器碰一下文件而改写，这些都
会悄悄拉长或缩短保留窗口。

在轮转存在之前，保留策略按 mtime 给唯一一个从不轮转的文件计龄，而每一次追加都会刷新
那个 mtime，于是它一次都没有够到过删除条件。

用本地日期而不是 UTC：`logRetentionDays` 是一个"我要保留几天"的、面向人的设置；而
UTC 戳会让格林尼治以西的人在本地下午的正中间发生文件切换。

日志体量由时间限定，而不是由大小限定。这是接受的取舍（#25）。

### 一个队列，一个打开的文件

`src/lib/log.ts` 中的 `wrapFileLog` 在记录日志时就给每条日志加时间戳、选定它的带日期
文件，然后放入队列。同一时间只有一个 drain，它通过在批次之间保持打开的句柄，按调用顺序
追加队列中的日志；每次写入不超过 256 KiB，且总在日志条目边界结束：
`FileHandle.appendFile` 会把更大的缓冲区分成 512 KiB 的几段写入，另一个向同一文件追加的
进程可能插在两段之间。

只有当路径仍指向同一个只有一个链接的私有文件，且在 POSIX 上权限仍为 0600 时，句柄才会
被复用。重命名、删除、替换、第二个硬链接或放宽的权限，都会让下一批重新打开该路径并执行
完整检查：不是符号链接、只有一个链接、打开前后是同一个文件，然后 chmod 0600。目录在打开
文件时以及每次保留清理时检查。写入失败永远不会让请求失败；它丢弃这一批并关闭句柄。
`flushLogs` 等待队列中的写入完成，再关闭文件。

#141 之前，每条日志各自执行目录检查、open、stat、chmod、追加和 close，一批突发日志可能
乱序写入文件。`tests/unit/log-format.test.ts` 覆盖调用顺序、调用时的时间戳和复用检查。

### 脱敏

`src/lib/redact.ts` 是纯函数，覆盖那些可能在 path、query string 或 fragment 里携带
凭据的 URL。含密钥的网关尾部不能原样进入普通日志。`copilotBaseUrl` 校验拒绝原始引号、
尖括号、空白和控制字符，因为它们会让整条 URL 的识别出现歧义。`src/lib/log.ts` 的
`registerLogSecret` 在内存中保存已知认证凭据（包括轮换前的值），从普通日志中移除原始或
转义形式的回显。即使对象检查转义了分隔符，相邻的嵌套 URL 也会分别脱敏。这不保证移除
任意提示词/工具中的密钥；分享前仍需审查有界摘录，绝不整份上传原始捕获。见
[日志与问题排查](ZH-Logging-Troubleshooting.md)。

## 测试

```sh
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
```

### 重定向 home 目录

npm 测试脚本在 **`tsx` 及任何源码 import 之前**预载 `scripts/test-bootstrap.mjs`。
它给每个测试进程分配私有 `HOME`、`USERPROFILE` 和临时根目录，退出时只清理自己拥有
的目录。静态 import 也因此受保护；单独跑某个测试时同样使用该预载。

需要独立日志/配置 fixture 的套件仍须在模块首次 import 前重定向，因为
`src/lib/paths.ts` 只解析一次 `os.homedir()`。例如：

```ts
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { readAppConfig } = await import("../../src/lib/app-config")
```

必须**同时设置 `HOME` 和 `USERPROFILE`**。Node 在 Windows 上读 `USERPROFILE`，而 CI
会跑 `windows-latest`，所以只设 `HOME` 会让重定向在那里悄无声息地失效。不这么做的话，
测试每跑一次都会写进开发者真实的 `~/.copilot-relay/logs`。

### mock 上游

集成测试让 Hono app 跑在本地 mock 的 Copilot HTTP server 之上。它们绝不可以调用真实
服务 —— CI 上不行，本地也不行。

### 文档的结构性测试

`tests/unit/wiki-docs.test.ts` 用机器强制文档契约本身：`wiki/` 是扁平的、每个 `EN-`
页面都有对应的 `ZH-` 页面、每个相对链接都能解析，以及真正的代码感知
`scripts/publish-wiki.py` 变换不留下坏导航。它调用与 workflow 相同的脚本及 Python
fixture，不另写一份正则替代变换。套件不导入 relay 源码，Python 子进程仍隔离两个 home
变量。离线及发布后校验见[开发指南](ZH-Development.md)。
