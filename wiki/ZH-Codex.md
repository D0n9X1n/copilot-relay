# Codex CLI 与 Codex app

中继在 `POST /v1/responses` 提供 OpenAI Responses API，这是 Codex 唯一使用的接口。
Codex CLI、Codex app 和 IDE 扩展读取同一个 `~/.codex/config.toml`，运行同一个
`codex app-server`，所以一次配置就覆盖这三者。Codex 提供的模型与 Claude Code 相同，
即 `gptModel` 和 `opusModel`，并且不需要登录 ChatGPT。

这已用 Codex CLI 0.164.0 对一个真实运行的中继验证：在 GPT-6 Astra 和 Claude Opus 5.5 上的
`codex exec` 对话，各自用 `apply_patch` 创建了文件、执行了 shell 命令并正常结束；app server
列出的模型正是这两个。

## 配置 Codex

`codexSetup: true`（默认）时，如果 Codex 已安装，即 `$CODEX_HOME`（默认 `~/.codex`）存在，
`copilot-relay start` 会为它完成配置。之后请重启 Codex 或 Codex app，让它重新读取文件。`copilot-relay setup codex-app` 无需启动中继
即可完成同样的配置，`--force` 可在 Codex 尚未运行过时配置。

`start` 会写入两处：

- `~/.copilot-relay/codex-models.json`：Codex 显示的模型列表，只包含 `gptModel` 和
  `opusModel`，`gptModel` 排在第一位作为默认。
- `~/.codex/config.toml` 中的：

```toml
model_provider = "copilot-relay"
model_catalog_json = "/Users/you/.copilot-relay/codex-models.json"
model = "gpt-6-astra"

[model_providers.copilot-relay]
# Written by copilot-relay start (codexSetup); edits in this table are replaced on the next start.
name = "copilot-relay"
base_url = "http://127.0.0.1:4142/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

只有当 `model` 不是这两个模型之一时才会被改写。设置了 `apiKey` 时，表中还会加上
`http_headers = { "x-api-key" = "…" }`，文件也会以仅所有者可读的方式发布。其他键、表和注释
都保持不变。`start` 会记录 `codex settings updated`、`codex settings already up to date`，
或在 Codex 未安装时记录 `codex setup skipped`。

| 键 | 原因 |
| --- | --- |
| `model_catalog_json` | Codex 把这个文件当作完整的模型列表，所以 CLI 和 app 的模型选择器只显示这两个模型。 |
| `base_url` | 中继地址加 `/v1`，Codex 会再拼上 `/responses`。 |
| `wire_api = "responses"` | Codex 只接受这个值。 |
| `requires_openai_auth = false` | Codex 跳过 ChatGPT 登录，也不会把 OpenAI 凭据发给中继。 |
| `supports_websockets = false` | 中继只支持 HTTP 和 SSE。 |
| `name` | 任意名称，但不要用 `OpenAI`。这个名称会让 Codex 打开仅限 OpenAI 的行为，例如中继不提供的远程压缩。 |
| `http_headers` | 发送 `apiKey`。Codex app 启动时常常拿不到 shell 中的变量，所以用 `env_key` 会让那里的每一轮对话都失败。 |

如果 `config.toml` 在自己的表之外，用点分键或内联表定义了 `model_providers.copilot-relay`，
或修改后的文件读出来不只是这些值发生变化，`start` 会拒绝修改并记录原因。项目内的 `.codex/config.toml` 不能设置 provider，Codex 会忽略。

### 手动配置

`codexSetup: false` 时，请自己写入上面这些键。没有 `model_catalog_json` 时，Codex 会显示它
自带的模型列表，并且只有 GPT 模型可用。

## 模型

列表包含 `config.yaml` 中的 `gptModel` 和 `opusModel`，与 Claude Code 的模型选择器一致。
修改其中任何一个后重启中继，列表就会随之改变。

- Codex 自带的模型（例如 `gpt-6-astra`）保留 Codex 自己的条目：它调校过的指令、`apply_patch`
  工具和推理等级。
- 其他模型（例如 `claude-opus-5.5`）使用中继生成的条目：Codex 的 `apply_patch` 工具和 shell、
  Copilot 列出的推理等级，以及 Codex 用于任何未知模型的指令。

每个模型的上下文窗口都取自 Copilot 的模型目录，所以 1M 上下文的模型按 1M 使用，而不是 Codex
常用的 272k。`context_window` 是 Codex 工作所用、并在其 90% 处压缩对话的窗口，取 Copilot 接受的、
仍能留出一次完整回复空间的最大输入：`min(输入上限, 总窗口 - 输出上限)`，例如 GPT-6 Astra 为
922k，Claude Opus 5.5 为 872k；一次完整回复就能占满总窗口时，取整个输入上限。`max_context_window` 是 Copilot 的输入上限，只限制你在
`config.toml` 中设置的 `model_context_window`。setup 读不到 Copilot 的模型目录时，Codex 自带的
模型保留 Codex 自己的窗口，其他模型不带窗口。

这两者都来自从 `openai/codex` 的 `rust-v0.164.0` 复制的文件，遵循其 Apache-2.0 许可证，
位于包中的 `vendor/codex/`。

中继处理每种模型的方式：

| 请求的模型 | 发往 Copilot |
| --- | --- |
| Copilot 列出且带 `/responses` 的 GPT ID | `/responses`，直接转发 |
| Copilot 列出且带 `/v1/messages` 的 `claude-*` ID | `/v1/messages`，经过翻译；见“Claude 模型” |
| 目录中没有的 ID，例如 Codex 内部的 `codex-auto-review` | `config.yaml` 中的 `gptModel` |
| Copilot 未列出的 `claude-*` ID | 返回 HTTP 400 `relay_unsupported_model` |
| 目录中有但没有可用端点的 ID | 返回 HTTP 400 `relay_unsupported_endpoint` |

## GPT 模型：中继做了哪些改动

请求体按 Codex 发出的样子转发，包括它的 `prompt_cache_key`、加密推理内容、`apply_patch`
语法工具和 `client_metadata`。只改动 Copilot 会返回 HTTP 400 的部分：

| Codex 发送 | 中继的处理 |
| --- | --- |
| `service_tier` | 删除 |
| 类型为 `image_generation` 的工具 | 删除该工具 |
| 模型不支持的 `reasoning.effort`，例如 `ultra` | 改为模型列出的、低于它的最高等级，例如 `max` |

Copilot 的 SSE 按原样返回，只是同一个输出项的所有事件使用同一个 id：Copilot 给每个事件一个新
id，Codex app 会因此把回答显示两次。上游错误保留状态码、正文和 `retry-after`。

## Claude 模型

Copilot 只在 Messages 和 Chat Completions 上提供 Claude，所以对 `claude-*` 模型，中继把每个
Responses 请求翻译成原生 Claude Messages 请求，再把 Claude 的流翻译回 Responses 事件：

- `instructions` 和开头的 developer 消息成为系统提示。函数工具保留其 schema；`apply_patch`
  成为只有一个字符串输入的工具，其语法写在描述中。`web_search` 等托管工具会被丢弃。
- 文本、思考和工具调用分别以 message、reasoning 以及 `function_call` 或 `custom_tool_call`
  项返回。Claude 带签名的思考放在 reasoning 项的 `encrypted_content` 中，所以下一轮会把它发回。
- Codex 发送的 effort 会限制到 Claude 的等级内，并以 adaptive thinking 发送。
- prompt 缓存断点放在 Claude Code 放置的位置，所以后续轮次会从缓存读取前面的内容。

## 共同行为

prompt 超过模型输入上限时，Copilot 返回 HTTP 400；对流式的 Codex 请求，中继改为发送 code 为
`context_length_exceeded` 的 `response.failed`，Codex 收到这个事件后会压缩对话。

最后一个输入项是用户消息时，`x-initiator` 为 `user`，否则为 `agent`，例如工具调用之后。
Codex 的 subagent（review、压缩、记忆整理、派生的 agent）始终为 `agent`。

## 验证

```sh
codex exec --skip-git-repo-check "Reply with the single word: ok"
codex exec --skip-git-repo-check -m claude-opus-5.5 "Reply with the single word: ok"
```

然后在中继日志中查找这些请求：

```sh
grep 'client=codex' ~/.copilot-relay/logs/copilot-relay.$(date +%F).log | tail -3
```

```text
info request_id=… Model request client=codex requested_model=gpt-6-astra upstream_model=gpt-6-astra upstream_api=responses requested_think_effort=medium effective_think_effort=medium initiator=user
info request_id=… Model request client=codex requested_model=claude-opus-5.5 upstream_model=claude-opus-5.5 upstream_api=messages effective_think_effort=medium initiator=user
```

`copilot-relay cache` 会把 Codex 请求和其他 `/responses`、`/v1/messages` 流量一起统计。
Codex 一读到 `response.completed` 就关闭 GPT 的流，比 Copilot 结束响应体略早，所以一个已完成的
GPT 请求常被记录为 `body=cancelled`，同时带有 `response_status=completed terminal=true`。
这两者同时出现表示回答已完整送达。

## 限制

- 通过 Codex 使用 Claude 模型时没有托管的网页搜索。
- Claude 模型的 `--output-schema` 作为指令发给 Claude，不会强制执行；脚本依赖它时请检查回复。
- 只支持 HTTP 和 SSE：没有 WebSocket，也没有 `/responses/compact`。Codex 会用普通请求
  自行压缩长对话。
- `upstreamTimeoutSeconds` 限制每个请求的时长，包括较长的流式回答。
- 在 `logLevel: debug` 下，Codex 请求和其他请求一样会被捕获，但
  `copilot-relay replay` 只接受 Messages 和 token 计数的捕获。
- 中继已用 Codex CLI 0.164.0 及其 app server 验证。之后的 Codex 版本可能改变发送的内容。

## 问题排查

| 现象 | 原因 |
| --- | --- |
| Codex 显示它自带的模型，或要求登录 | `codexSetup` 为 `false`、中继启动时 Codex 尚未安装，或 Codex 没有重启。请查看中继日志中的 `codex settings` 行。 |
| `codex settings` 行显示拒绝修改 | `config.toml` 用点分键或内联表定义了 `copilot-relay` 或 `model_providers`、不是合法 TOML，或含有会被这次修改改变的内容；日志行会说明是哪一种。请修正，或手动配置 Codex。 |
| HTTP 401 | 中继设置了 `apiKey` 而请求没有携带；重启中继让 `start` 写入它。 |
| HTTP 400 `relay_unsupported_model` | Copilot 未列出的 `claude-*` 模型。 |
| HTTP 400 `relay_unsupported_endpoint` | 该模型在 Copilot 上没有可用端点；请查看 `copilot-relay models`。 |
| Copilot 返回 HTTP 400 `unsupported_value` | Codex 发送了一个 Copilot 拒绝、而中继尚未改写的字段。它前面的日志行标出了该请求。 |
| HTTP 415 | 请求没有以 `application/json` 发送。 |
| `/responses` 返回 HTTP 500 `Unsupported Claude API route` | `base_url` 缺少 `/v1`。 |

日志格式和其他故障见 [日志与问题排查](ZH-Logging-Troubleshooting.md)。
该路由在中继内部的工作方式见 [内部实现](ZH-Internals.md)。
