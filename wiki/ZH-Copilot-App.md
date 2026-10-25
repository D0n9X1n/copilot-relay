# GitHub Copilot app 与 Copilot CLI

GitHub Copilot app 和 Copilot CLI 可以使用自定义模型提供方，GitHub 称之为 bring your own
key，目前是预览功能。把它指向中继后，它们使用的就是 Claude Code 和 Codex 所用的两个模型，
即 `gptModel` 和 `opusModel`，其用量也会出现在中继的日志和 `copilot-relay cache` 中。

app 本身已经直接连接 GitHub Copilot，模型也相同。如果你想在一个地方查看所有客户端的日志和
prompt 缓存命中率，就让它经过中继；否则内置提供方也能完成同样的工作，还少一跳。经过中继的
用量仍然占用你自己的 Copilot 席位：见[配置说明](ZH-Configuration.md)中的“仅限个人使用”。

这已用 Copilot CLI 1.0.103 对一个真实运行的中继验证，它与 app 运行同一套提供方引擎：在
GPT-6 Astra 和 Claude Opus 5.5 上，一次普通回复和一次五步工具调用会话都正常完成。

## 选择提供方设置

中继支持这些客户端所用的其中两种接口格式。选择一行：

| 提供方类型 | Base URL | 中继路由 | 结果 |
| --- | --- | --- | --- |
| OpenAI-compatible，wire API 选 **Responses** | `http://127.0.0.1:4142/v1` | `POST /v1/responses` | 两个模型都可用。推荐。 |
| **Anthropic** | `http://127.0.0.1:4142` | `POST /v1/messages` | 两个模型都可用。Copilot CLI 会提示它不知道 Anthropic 类型下 `gpt-6-astra` 的 token 倍率，所以该模型的 token 估算只是近似值。 |
| OpenAI-compatible，wire API 选 **Chat completions**（默认） | `http://127.0.0.1:4142/v1` | `POST /v1/chat/completions` | 不可用。中继不提供这个路由，会返回 `500 Unsupported Claude API route`。 |

如果 `config.yaml` 中的端口不是 `4142`，请改用你的端口。Responses 的 base URL 以 `/v1`
结尾，因为客户端会追加 `/responses`；Anthropic 的不带 `/v1`，因为客户端会追加
`/v1/messages`。

使用 Responses wire API 时，中继把 GPT 请求透传给 Copilot `/responses`，把 Claude 请求
转换为原生 Messages，与 Codex 相同；见 [Codex](ZH-Codex.md)。

## 配置 Copilot app

打开 **Settings → Model providers**，添加一个提供方并填写：

| 字段 | 值 |
| --- | --- |
| Name | `Copilot Relay (local)` |
| Type | OpenAI-compatible |
| Base URL | `http://127.0.0.1:4142/v1` |
| Wire API | Responses |
| API key | 你的中继 `apiKey` |

然后添加两个模型：

| 模型 ID | 显示名称 |
| --- | --- |
| `gpt-6-astra` | `GPT-6 Astra · Relay` |
| `claude-opus-5.5` | `Claude Opus 5.5 · Relay` |

显示名称保留 Copilot 自己的模型名，所以会排在内置模型旁边；加上 `· Relay`，模型选择器就
不会出现两个同名条目。模型 ID 请使用你的 `gptModel` 和 `opusModel`。

如果表单没有 Responses 选项，改用 Anthropic 类型，base URL 填 `http://127.0.0.1:4142`，
密钥和模型不变。

API key 是 `~/.copilot-relay/config.yaml` 中 `apiKey` 的值，app 会把它存进操作系统的安全
存储。`apiKey` 为空时中继接受任何密钥，所以表单必须填写时随便填一个占位值即可。

如果表单要求填写 token 上限：Claude Opus 5.5 填 1,000,000 prompt 和 128,000 输出 token，
GPT-6 Astra 填 1,050,000 和 128,000。中继启动时会在 `Model token limits` 行记录 Copilot
公布的上限。

`copilot-relay setup` 没有针对 app 的目标。app 把提供方存在自己的数据库中，把密钥存在操作
系统的安全存储中，两者都不是公开的接口，所以中继不会写入它们。

## 配置 Copilot CLI

Copilot CLI 从环境变量读取提供方。在 zsh 或 bash 中：

```sh
export COPILOT_PROVIDER_BASE_URL=http://127.0.0.1:4142/v1
export COPILOT_PROVIDER_TYPE=openai
export COPILOT_PROVIDER_WIRE_API=responses
export COPILOT_PROVIDER_API_KEY="<你的中继 apiKey>"
export COPILOT_MODEL=gpt-6-astra
```

在 PowerShell 中：

```powershell
$env:COPILOT_PROVIDER_BASE_URL = "http://127.0.0.1:4142/v1"
$env:COPILOT_PROVIDER_TYPE = "openai"
$env:COPILOT_PROVIDER_WIRE_API = "responses"
$env:COPILOT_PROVIDER_API_KEY = "<你的中继 apiKey>"
$env:COPILOT_MODEL = "gpt-6-astra"
```

要用 Opus，把 `COPILOT_MODEL` 设为 `claude-opus-5.5`，或在会话中用 `/model` 切换。使用
Anthropic 类型时，设置 `COPILOT_PROVIDER_TYPE=anthropic`，base URL 用
`http://127.0.0.1:4142`，并且不要设置 `COPILOT_PROVIDER_WIRE_API`。

## 验证

1. 选择 `GPT-6 Astra · Relay` 发送一条消息，再用 `Claude Opus 5.5 · Relay` 发送一条。
2. 同时查看中继日志：

   ```sh
   tail -f ~/.copilot-relay/logs/copilot-relay.$(date +%F).log | grep -E 'POST /v1/(responses|messages)'
   ```

   每条消息都会记录 `POST /v1/responses -> 200`；使用 Anthropic 类型时记录
   `POST /v1/messages -> 200`。中继把 Responses 流量标为 `client=codex`，因为它与 Codex
   使用同一个路由。
3. 几轮对话后运行 `copilot-relay cache`，查看每个模型和上游路由的命中率。会话的第一个请求
   写入缓存而不是读取缓存，所以短会话的命中率比长会话低；见
   [Prompt 缓存](ZH-Prompt-Caching.md)。

## 限制

- 自定义模型提供方在 Copilot app 和 Copilot CLI 中都是预览功能，其设置可能在版本之间变化。
- 中继不提供 `/v1/chat/completions` 路由，所以 OpenAI-compatible 默认的 wire API 不可用。
- app 仍然要求登录 GitHub。使用自定义提供方时它不要求 Copilot 订阅，正因如此，中继只能由
  运行 `copilot-relay auth` 的那个账号使用。

## 问题排查

| 现象 | 原因与解决 |
| --- | --- |
| `500 Unsupported Claude API route`，日志显示 `POST /v1/chat/completions` | wire API 是 chat completions。改选 Responses，或改用 Anthropic 类型。 |
| 其他路径上的 `500 Unsupported Claude API route`，例如 `/v1/v1/messages` 或 `/responses` | base URL 结尾不对：Responses 要以 `/v1` 结尾，Anthropic 不带。 |
| `401` 和 `authentication_error` | 密钥与 `apiKey` 不一致。从 `config.yaml` 重新复制。 |
| 连接被拒绝 | 中继没有运行，或监听在其他端口。运行 `copilot-relay status`。 |
| 模型选择器里缺少某个模型 | 手动把它添加到提供方；模型 ID 必须与 `gptModel` 和 `opusModel` 一致。 |
