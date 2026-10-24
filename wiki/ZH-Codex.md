# Codex CLI 与 Codex app

中继在 `POST /v1/responses` 提供 OpenAI Responses API，这是 Codex 唯一使用的接口。
Codex CLI、Codex app 和 IDE 扩展读取同一个 `~/.codex/config.toml`，运行同一个
`codex app-server`，所以一个 provider 配置块就能同时配好这三者。请求会发往 Copilot
在 `/responses` 上提供的 GPT 模型。

这已用 Codex CLI 0.164.0 对一个真实运行的中继验证：一次 `codex exec` 和一次
`codex app-server` 的对话，各自用 `apply_patch` 创建了文件、执行了 shell 命令并正常结束。

## 配置 Codex

照常启动中继（`copilot-relay start`），然后在 `~/.codex/config.toml` 中加入：

```toml
model = "gpt-6-astra"
model_provider = "copilot-relay"
model_reasoning_effort = "medium"

[model_providers.copilot-relay]
name = "copilot-relay"
base_url = "http://127.0.0.1:4142/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
```

按 TOML 的规则，`model`、`model_provider` 和 `model_reasoning_effort` 要写在第一个表之前。
项目内的 `.codex/config.toml` 不能设置 provider，Codex 会忽略并给出警告。

然后运行 `codex`，或重启 Codex app 让它重新读取该文件。

| 键 | 原因 |
| --- | --- |
| `base_url` | 中继地址加 `/v1`，Codex 会再拼上 `/responses`。请使用 `config.yaml` 中的 `host` 和 `port`。 |
| `wire_api = "responses"` | Codex 只接受这个值。 |
| `requires_openai_auth = false` | Codex 跳过 ChatGPT 登录，也不会把 OpenAI 凭据发给中继。 |
| `supports_websockets = false` | 中继只支持 HTTP 和 SSE。自定义 provider 的默认值就是 `false`。 |
| `name` | 任意名称，但不要用 `OpenAI`。这个名称会让 Codex 打开仅限 OpenAI 的行为，例如中继不提供的远程压缩。 |

不要设置 `env_key`、`model_catalog_url` 和 `auth` 命令。设置其中任何一个，Codex 要么需要
环境变量，要么会以中继不提供的格式请求 `/models`。

### 中继设置了 `apiKey` 时

用固定的请求头发送密钥：

```toml
[model_providers.copilot-relay]
name = "copilot-relay"
base_url = "http://127.0.0.1:4142/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
http_headers = { "x-api-key" = "<config.yaml 中的 apiKey>" }
```

在终端里用 `env_key` 也可以，但 Codex app 启动时常常拿不到 shell 中的变量，而
`env_key` 指定的变量缺失会让每一轮对话都失败。`http_headers` 把密钥写在文件里，
所以请保持 `config.toml` 私密。

## 选择模型

从 `copilot-relay models` 中选一个列出 `/responses` 的 ID。优先选择 Codex 已经认识的：
`gpt-6-astra`、`gpt-6-sol`、`gpt-6.1-sol`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra`
或 `gpt-5.6-luna`。这些 ID 在 Copilot 和 Codex 自带的模型列表中完全相同，因此 Codex 会为它们
提供 `apply_patch` 工具、推理等级和 272k 上下文窗口，app 的模型选择器也会显示它们。

Codex 不认识其他 Copilot ID，例如 `gpt-5.3-codex`。对这些模型它使用通用设置：没有
`apply_patch` 工具（改为通过 shell 编辑文件），上下文窗口为 272k。如果需要不同的预算，
请在 `config.toml` 中设置 `model_context_window` 和 `model_auto_compact_token_limit`。

中继选择 Copilot 模型的方式：

| 请求的模型 | 发往 Copilot |
| --- | --- |
| Copilot 目录中列出且带 `/responses` 的 ID | 原样使用该 ID |
| 目录中没有的 ID，例如 Codex 内部的 `codex-auto-review` | `config.yaml` 中的 `gptModel` |
| `claude-*` ID | 返回 HTTP 400 `relay_unsupported_model` |
| 目录中有但没有 `/responses` 的 ID | 返回 HTTP 400 `relay_unsupported_endpoint` |

Copilot 只在 Messages 和 Chat Completions 上提供 Claude 模型，所以 Codex 无法通过中继使用它们。
Claude 模型请使用 Claude Code。

## 中继做了哪些改动

请求体按 Codex 发出的样子转发，包括它的 `prompt_cache_key`、加密推理内容、`apply_patch`
语法工具和 `client_metadata`。只改动 Copilot 会返回 HTTP 400 的部分：

| Codex 发送 | 中继的处理 |
| --- | --- |
| `service_tier` | 删除 |
| 类型为 `image_generation` 的工具 | 删除该工具 |
| 模型不支持的 `reasoning.effort`，例如 `ultra` | 改为模型列出的、低于它的最高等级，例如 `max` |

Copilot 的 SSE 原样返回。上游错误保留状态码、正文和 `retry-after`。只有一种错误会被改写：
prompt 超过模型输入上限时，Copilot 返回 HTTP 400；对流式的 Codex 请求，中继改为发送
code 为 `context_length_exceeded` 的 `response.failed`，Codex 收到这个事件后会压缩对话。

最后一个输入项是用户消息时，`x-initiator` 为 `user`，否则为 `agent`，例如工具调用之后。
Codex 的 subagent（review、压缩、记忆整理、派生的 agent）始终为 `agent`。

## 验证

```sh
codex exec --skip-git-repo-check "Reply with the single word: ok"
```

然后在中继日志中查找这次请求：

```sh
grep 'client=codex' ~/.copilot-relay/logs/copilot-relay.$(date +%F).log | tail -3
```

```text
info request_id=… Model request client=codex requested_model=gpt-6-astra upstream_model=gpt-6-astra upstream_api=responses requested_think_effort=medium effective_think_effort=medium initiator=user
```

`copilot-relay cache` 会把 Codex 请求和其他 `/responses` 流量一起统计。Codex 一读到
`response.completed` 就关闭流，比 Copilot 结束响应体略早，所以一个已完成的 Codex 请求
常被记录为 `body=cancelled`，同时带有 `response_status=completed terminal=true`。
这两者同时出现表示回答已完整送达。

## 限制

- 只支持 GPT 模型，见“选择模型”。
- 只支持 HTTP 和 SSE：没有 WebSocket，也没有 `/responses/compact`。Codex 会用普通请求
  自行压缩长对话。
- `upstreamTimeoutSeconds` 限制每个请求的时长，包括较长的流式回答。
- 不提供模型目录：使用 Codex 自带的模型列表。
- 中继已用 Codex CLI 0.164.0 及其 app server 验证。之后的 Codex 版本可能改变发送的内容。

## 问题排查

| 现象 | 原因 |
| --- | --- |
| HTTP 401 | 中继设置了 `apiKey`；请用 `http_headers` 加上它。 |
| HTTP 400 `relay_unsupported_model` | 选了 `claude-*` 模型；请选择 GPT 模型。 |
| HTTP 400 `relay_unsupported_endpoint` | 该模型在 Copilot 上没有 `/responses`；请查看 `copilot-relay models`。 |
| Copilot 返回 HTTP 400 `unsupported_value` | Codex 发送了一个 Copilot 拒绝、而中继尚未改写的字段。它前面的日志行标出了该请求。 |
| HTTP 415 | 请求没有以 `application/json` 发送。 |
| `/responses` 返回 HTTP 404 | `base_url` 缺少 `/v1`。 |
| Codex 要求登录 | `requires_openai_auth` 缺失或为 `true`。 |
| `Missing environment variable` | 设置了 `env_key`，而 app 看不到该变量。请改用 `http_headers`。 |
| 没有 `apply_patch`，改由 shell 编辑文件 | 该模型 ID 不在 Codex 自带的列表中，见“选择模型”。 |

日志格式和其他故障见 [日志与问题排查](ZH-Logging-Troubleshooting.md)。
该路由在中继内部的工作方式见 [内部实现](ZH-Internals.md)。
