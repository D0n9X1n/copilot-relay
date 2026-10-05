# Prompt 缓存

Claude Code 的每个请求都会重发整段对话：system prompt、工具定义和之前的每个回合。其中大部分与
上一个请求相同。Copilot 从 prompt 缓存提供这段重复的前缀时，这些输入 token 从缓存读取，不再
重新处理。在长会话中，这是输入 token 成本和延迟的主要杠杆。

本页说明谁在缓存、Claude Code 标记了什么、中继在每条上游路由上发送什么、什么让对话前缀保持稳定，
以及如何测量命中率。精确的机制与实测数据见[内部实现](ZH-Internals.md)中的“Prompt 缓存”。

## 谁在缓存

Copilot。中继自己不保存 prompt 缓存，也无法让 Copilot 缓存某个请求或保留某个条目。它只决定转发
什么：在部分路由上传递 Claude Code 的缓存标记，在 `/responses` 上发送缓存 key，在其余路由上不发送
任何缓存提示。它只能从 Copilot 为每次调用报告的用量得知有多少输入从缓存读取。这些都不保证缓存
命中。

## Claude Code 标记了什么

Claude Code 用内容块上的 `cache_control` 标记它希望缓存的每段前缀的结尾。在
`tests/unit/chat-route-cache.test.ts` 记录的 Claude Code 2.1.288 请求形态中，有三个块带有它：
system prompt 中的两个，以及 Claude Code 作为每个请求最后一条消息发送的 token 提醒，即一条对话
中途的 `role: "system"` 消息。更早的提醒以不带标记的纯字符串重放，工具定义不带标记。其他版本的
Claude Code 可能标记别的块。

## 中继在每条路由上发送什么

请求走哪条路由取决于模型、它的目录条目和 `claudeUpstreamApi`；见[配置说明](ZH-Configuration.md)
中的 `claudeUpstreamApi`。

| 路由 | 中继发送的缓存提示 | 对话中途的 system 消息 |
| --- | --- | --- |
| `/v1/messages` | Claude Code 的 `cache_control`，原样转发 | 保持 `role: "system"` |
| `/chat/completions`，请求无法回退到 `/responses` 的 Claude 模型 | 在每条容纳带标记块的消息上设置 `copilot_cache_control` | 作为包含 `<system-reminder>` 的 `role: "user"` 回合，留在原位置 |
| `/chat/completions`，可以回退的请求，或不是 Claude 的模型 | 无 | 保持 `role: "system"` |
| `/responses` | 有来源时发送 `prompt_cache_key` | 保持 `role: "system"` |

在每条路由上，中继都会先从顶层 system prompt 中删除 Claude Code 的计费归属行。只含这一行的块会被
丢弃；其他块保留各自的 `cache_control`。见[内部实现](ZH-Internals.md)中的“Claude Code 的计费行”。

### `/chat/completions`

Chat Completions 没有 `cache_control`。对请求无法回退到 `/responses` 的 Claude 模型，中继在容纳
每个带标记块的翻译后消息上设置 `copilot_cache_control: { "type": "ephemeral" }`。合并进同一条
消息的块共用该消息的标记，所以较早块上的标记会移到该消息末尾。

在同一路由上，对话中途的 system 消息作为包含 `<system-reminder>…</system-reminder>` 的
`role: "user"` 回合发送，留在原位置。用 claude-opus-5.5 测量时，每个请求都带一条新的
`role: "system"` 消息，会把缓存读取限制在工具加最初的 system prompt；user 回合不会。见
[内部实现](ZH-Internals.md)中的“Chat 路由：system 回合与缓存断点”。代价是权威：之后的运维指令
以 user 回合的权威到达。这些测量覆盖的是缓存，不是模型如何看待这条指令。
`claudeUpstreamApi: messages` 保留 system 角色。

Claude 请求只有在 `auto` 模式下才能回退：模型在目录中没有端点元数据，或其目录条目列出了
`/chat/completions` 和 `/responses` 但没有 `/v1/messages`。Copilot 对 `/chat/completions` 回答
`unsupported_api_for_model` 时，中继把同一份翻译后的载荷发给 `/responses`，所以这份载荷保持
`role: "system"`，也不带缓存标记。不是 Claude 的模型也按同样方式翻译。在默认的
`claudeUpstreamApi: chat-completions` 下，Claude 模型从不回退。

### `/responses`

中继不向 `/responses` 发送缓存标记。它发送 `prompt_cache_key`，一个用 SHA-256 派生的缓存路由提示：

- 来自请求的 `user` 标识符时，为 `cr-` 加 32 位十六进制字符；中继从 Claude Code 的
  `metadata.user_id` 取得该标识符；
- 没有 `user` 标识符时，来自 system prompt 文本，为 `cr-sys-` 加 32 位十六进制字符；
- 两者都没有时，不发送 key。

这个 key 不保证缓存命中。此前对 GPT-5.5/5.6 系列的 Copilot 测试发现，省略它时缓存读取会降到 0；
而 GPT-6 Astra 在没有它时也命中了缓存。

对 key 做哈希并不能隐藏标识符：中继还会在请求的 `user` 字段中发送标识符本身，截断到 64 个字符，
`/responses` 和 `/chat/completions` 都是如此。请把 `metadata.user_id` 当作 Copilot 能看到的值。

## 缓存输入如何报告

Claude Code 以 Messages API 的形式接收用量：`input_tokens` 表示未缓存的输入，另有
`cache_read_input_tokens` 和 `cache_creation_input_tokens`。Copilot 在不同路由上报告用量的方式
不同，由中继映射：

| 路由 | Copilot 报告 | Claude Code 收到 |
| --- | --- | --- |
| `/v1/messages` | Messages API 用量 | 相同的字段 |
| `/chat/completions` | `prompt_tokens`（已包含缓存输入）和 `prompt_tokens_details.cached_tokens` | `input_tokens` = `prompt_tokens` 减去 `cached_tokens`；`cache_read_input_tokens` = `cached_tokens` |
| `/responses` | `input_tokens`（已包含缓存输入）和 `input_tokens_details.cached_tokens` | `input_tokens` = `input_tokens` 减去 `cached_tokens`；`cache_read_input_tokens` = `cached_tokens` |

只有 `/v1/messages` 报告缓存写入。Copilot 没有报告缓存数量时，中继省略
`cache_read_input_tokens`，而不是发送 `0`。例外是由中继自己执行 WebSearch 的 `/v1/messages`
请求：中继把该请求各轮的用量相加，并总是发送两个缓存字段，缺少的值按 `0` 计算。中继自己的日志按 Copilot 报告的原样保留各路由的计数，
所以日志中的 `input_tokens` 在 `/chat/completions` 和 `/responses` 上包含缓存输入，在
`/v1/messages` 上不包含；`copilot-relay cache` 会处理这一点，见下文“统计口径”。

## 什么让前缀保持稳定

缓存命中要求请求的开头与之前某个请求发送的内容逐字节一致。在中继这一侧，以下几点让它保持稳定：

- assistant 的 `thinking` 保留在上游历史里。Claude Code 会重放它，转发前删掉它会改写前缀，使缓存
  失效；见[内部实现](ZH-Internals.md)中的“assistant 的 `thinking` 保留在上游历史里”。
- 在 `/chat/completions` 上，对无法回退的 Claude 模型，提醒作为 user 回合留在原位置，而不是在每个
  请求中变成一条新的 system 消息。
- `tests/unit/chat-route-cache.test.ts` 重放 Claude Code 的请求形态。翻译后的请求在 prompt 开始之后
  带有 system 回合，或者去掉缓存标记后，某个请求的消息不再是下一个请求消息的前缀时，测试失败。
- 在 `/responses` 上，只要 `user` 标识符（没有标识符时为 system prompt）不变，key 就不变。

任何改变请求较早部分的东西，都会从那一点开始一个新的前缀：不同的 system prompt、变化的工具列表，
或被编辑、被压缩的历史。缓存什么、条目何时过期由 Copilot 决定，所以稳定的前缀让命中成为可能，
而不是必然。

## 测量命中率

`copilot-relay cache` 按上游路由报告每个模型的输入中有多少由 prompt 缓存提供。它只读中继的日志
文件：既不联系中继，也不联系 Copilot，也不写入任何东西。它的选项与退出码见
[命令](ZH-Commands.md)中的 `cache`。要找到命中率变化的那个小时，或在大量请求中反复出现的同一个
缓存读取大小，见[日志与问题排查](ZH-Logging-Troubleshooting.md)中的“定位退化”。

```sh
copilot-relay cache                      # 最近 24 小时，每个模型与路由一行
copilot-relay cache --hourly             # 最近 24 小时的按小时趋势
copilot-relay cache --daily              # 所有保留日志的按天趋势
copilot-relay cache --since 6h           # 一段时长，或 ISO 日期或时间
copilot-relay cache --model opus         # 名称包含 "opus" 的模型，不区分大小写
copilot-relay cache --goal 97.5          # 低于 97.5% 的命中率显示为红色（默认 95）
copilot-relay cache --json               # 行数组，供脚本使用
```

```text
Prompt-cache hit rate since 2026-10-02 17:30 local time, goal 95%

  MODEL               ROUTE              REQUESTS  HIT RATE
  claude-opus-5-5     /v1/messages              1    98.36%
  claude-opus-5.5     /chat/completions         2    98.38%
  gpt-5.5-2026-04-23  /responses                1    92.86%

HIT RATE leaves out 1 call that logged no cache_read_input_tokens.
```

| 列 | 含义 |
| --- | --- |
| `MODEL`、`ROUTE` | 上游报告的模型（条目中没有时为 `unknown`）和上游路径。同一模型在不同路由上可能以不同名称报告，例如 `claude-opus-5.5` 与 `claude-opus-5-5`。 |
| `REQUESTS` | 返回 HTTP 200 并记录了 `input_tokens` 的上游调用，包括用量到达后才被中断的调用，以及缓存情况未知的调用。 |
| `HIT RATE` | 由 prompt 缓存提供的输入 token 除以总输入，截断到两位小数。在彩色终端中，达到 `--goal` 时为绿色，低于时为红色。该行没有调用报告缓存情况时为灰色的 `-`。 |

条目中没有 `cache_read_input_tokens` 的调用，缓存情况是未知，不是零。它计入 `REQUESTS`，
但不计入 `HIT RATE`；表格下方一行说明这样的调用有多少，没有时不显示这一行。
命中率所依据的 token 计数（总输入、缓存读取、未缓存与缓存写入），
以及缓存情况未知和缓存读取为 0 的调用数，都在 `--json` 中。

`HIT RATE` 的颜色是表格中未达到目标的唯一标记。没有颜色时（`NO_COLOR`，或输出到管道），
请把命中率与标题中的目标比较，或读取 `--json` 中的 `belowGoal`。`HIT RATE` 截断而不是
四舍五入，所以低于目标的命中率永远不会显示成目标值本身。`--goal` 最多两位小数；打印出的
`HIT RATE` 低于目标时，它才显示为红色，且一定显示为红色。

`--hourly` 和 `--daily` 会增加一列本地时间的 `HOUR` 或 `DAY`，与日志文件名中的日期一致。
时钟回拨时，重复出现的本地小时按每个真实小时各占一行，并以各自的 UTC 偏移量结尾，例如
`2026-11-01 01:00 UTC-04:00` 和 `2026-11-01 01:00 UTC-05:00`。不加 `--since` 时，汇总和
按小时趋势覆盖最近 24 小时，按天趋势覆盖每个保留的日期。时长从现在往回计算；日期，或没有
`Z` 和偏移量的时间，按本地时间解释。

`--json` 为每一行打印一个对象，包含 `bucket`、`model`、`route`、`requests`、
`unknownCacheRequests`、`zeroCacheReadRequests`、`totalInputTokens`、
`cacheReadTokens`、`uncachedInputTokens`、`cacheWriteTokens`、`hitRate` 和
`belowGoal`。`hitRate` 是 0 到 1 之间的小数，或 `null`；汇总中 `bucket` 为 `null`，
该行没有调用报告缓存写入时 `cacheWriteTokens` 为 `null`。没有数据时打印 `[]`。

### 统计口径

命令读取中继为每次上游调用在 `info` 级别记录的 `completion` 条目，来源是
`~/.copilot-relay/logs/` 下按日期命名的文件。只有 `http_status=200`、`input_tokens` 为
数字，且路由是 `/chat/completions`、`/responses` 或 `/v1/messages` 的条目才会计入。条目的
`body` 和 `terminal` 取值不影响计入，所以用量到达后才被中断的调用，仍会显示它从缓存读取了
多少。`request outcome` 条目会为客户端请求再次报告用量（两种条目见[日志与问题排查](ZH-Logging-Troubleshooting.md)中的“HTTP 请求”），
因此从不读取它：计入它会把调用算两次。格式错误的行，以及中继仍在写入的最后一行，都会被
跳过。

`input_tokens` 在不同路由上含义不同，因此 `HIT RATE` 所除的总输入（`--json` 中的
`totalInputTokens`）需要归一化：

| 路由 | 总输入 |
| --- | --- |
| `/chat/completions`、`/responses` | `input_tokens`，已包含缓存输入 |
| `/v1/messages` | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` |

在 `/v1/messages` 上，缺少 `cache_creation_input_tokens` 时按 0 计算。小时和日期都是
本地时间。

命令能回看多远取决于 `logRetentionDays`（默认 `3`）。`completion` 条目在 `info` 级别
写入，所以以 `logLevel: error` 运行的中继不会留下可读的数据，此时命令会说明没有找到
数据，而不是打印一张空表。
