# 为每个客户端选择模型

中继提供两个 Copilot 模型：`gptModel` 和 `opusModel`。每个 Claude 请求都会到达其中之一，所以
Claude Code 始终使用同一对可预测的模型；Codex 和 Copilot 应用也会看到这两个模型，并且还可以请求
模型目录列出的其他模型。本页说明路由规则、如何选择这两个
模型、1M context 窗口、费用，以及每个客户端需要怎样设置。其他配置键见
[配置说明](ZH-Configuration.md)。

## 两模型规则

```yaml
gptModel: gpt-6.2-astra
opusModel: claude-opus-5.5
```

| 请求中的模型名 | 到达 |
| --- | --- |
| 恰好是 `opusModel`（不区分大小写，带不带 `[1m]` 均可） | `opusModel` |
| 恰好是 `gptModel`（不区分大小写，带不带 `[1m]` 均可） | `gptModel` |
| 其他包含 `opus` 的名称，例如 `opus` 或 `claude-opus-4-5-20251101` | `opusModel` |
| 其他任何名称，例如 `sonnet`、`haiku`、`claude-haiku-4-5-20251001` 或 `grok-4.7` | `gptModel` |

- 槽位自己的名称优先于 `opus` 规则，所以 `gptModel: gpt-opus-lab` 和
  `opusModel: claude-sonnet-5` 各自到达自己的槽位。
- 客户端看到的恰好是这两个模型：`GET /v1/models` 依次列出 `gptModel` 和 `opusModel`；两者
  是同一个模型时只列一项。
- 该规则适用于 Claude Code 的路由（`POST /v1/messages` 和 `/v1/messages/count_tokens`）。
  Codex 的路由 `POST /v1/responses` 保留自己的规则；见 [Codex](ZH-Codex.md)。
- 两个键对 Claude Code 路由和 `GET /v1/models` 热重载生效。要改变 Codex 列出的模型，需要
  重启中继。
- 全新安装从 `gptModel: gpt-6.2-astra` 开始。已有的 `config.yaml` 保留它自己的值。

## 选择两个模型

`copilot-relay models` 列出你的 Copilot 账号可用的每个模型，以及它的费用和 context 窗口：

```text
copilot-relay models
```

把 `gptModel` 和 `opusModel` 设为列表中的 ID，一字不差。启动时会探测这两个模型；Copilot
模型目录缺少其中任何一个时，启动会停止。

旧版本写入的配置中可能还有一行 `models:`。它不起任何作用，也不会检查它的值；可以删除。

## 1M context

Claude Code 把模型 ID 末尾的 `[1m]` 理解为一百万 token 的 context 窗口。槽位自己在模型目录中
的窗口至少为 1,000,000 token 时，中继加上这个后缀，无需任何配置。已知窗口更小时显示不带后缀
的 ID；窗口未知时，配置中的 ID 按原样保留。中继调用 Copilot 前会去掉 `[1m]`。

| Copilot ID | 总 context | Claude Code 看到的 ID |
| --- | ---: | --- |
| `gpt-6.2-astra` | 1,050,000 | `gpt-6.2-astra[1m]` |
| `claude-opus-5.5` | 1,000,000 | `claude-opus-5.5[1m]` |
| `grok-4.7` | 500,000 | `grok-4.7` |

数值来自 2026-11-20 检查的模型目录。要查看你的情况，运行 `copilot-relay models` 或读取
`GET /v1/models`。

## 费用

`copilot-relay models` 显示 Copilot 模型目录中每个模型的费用：输入和输出价格，单位是每百万
token 的美元，例如 `gpt-6.2-astra` 为 `8/40`，`claude-opus-5.5` 为 `4/20`。只公布高级请求
倍率的账号显示为 `1×`、`0.33×` 或 `0×`；没有费用数据的模型显示 `–`。

## Effort 与端点

**Effort。** 模型公布的推理等级按原样发送。其他等级改为不高于它的最高公布等级；没有更低的
公布等级时，改为最低的公布等级。不公布任何等级的模型，仍会以 HTTP 400
`relay_unsupported_effort` 拒绝明确指定的 effort。

**端点。** 有些模型在目录中列出了 `/chat/completions`，但 Copilot 在那里以
`no_available_model_endpoints` 拒绝它们。如果该模型同时列出了 `/responses`，中继会把这样的
请求在 `/responses` 上重试一次。

## Claude Code CLI

`claudeSetup` 和 `copilot-relay setup claude-code-cli` 会把中继地址、token 和预算写入
`~/.claude/settings.json`；尚未选择模型时，还把 `model` 设为 Claude Code 看到的 `gptModel`。
Claude Code 自己的模型选择器别名随后遵循上面的规则：Opus 到达 `opusModel`，Sonnet 和 Haiku
到达 `gptModel`。

要在 `/model` 中按各自的名称显示两个槽位，请在用户级 `~/.claude/settings.json` 中添加
`modelPicker`（Claude Code 2.1.242 或更新版本），并保留中继连接和其他所有设置：

```json
{
  "modelPicker": {
    "options": [
      { "model": "opus[1m]", "label": "Opus" },
      { "model": "gpt-6.2-astra[1m]", "label": "GPT-6.2 Astra", "behavesAs": "claude-sonnet-5" }
    ],
    "replaceBuiltInOptions": true
  },
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5.5[1m]"
  }
}
```

- `model` 按原样发送，所以请使用 Claude Code 看到的 ID，中继显示 `[1m]` 的就带上 `[1m]`。
  `ANTHROPIC_DEFAULT_OPUS_MODEL` 让 `opus[1m]` 指向 `opusModel` 的 1M 版本。
- `behavesAs`（Claude Code 2.1.257 或更新版本）取你的 Claude Code 版本已经认识的模型 ID，
  例如 `claude-sonnet-5`。
- `replaceBuiltInOptions: true` 只显示这些行以及 **Default**。

见 [modelPicker 参考](https://code.claude.com/docs/en/settings-reference#modelpicker)
和[模型配置](https://code.claude.com/docs/en/model-config)。Anthropic 不支持通过网关把
Claude Code 路由到非 Claude 模型；见 [LLM gateway](https://code.claude.com/docs/en/llm-gateway)。

## Claude Code app

`copilot-relay setup claude-code-app` 把 `opusModel` 作为 app 的 Opus 档位，把 `gptModel`
作为 Sonnet 档位；见[命令](ZH-Commands.md)。

## Codex

`start` 时的 `codexSetup`，以及 `copilot-relay setup codex-cli codex-app`，会把两个槽位写入
`~/.copilot-relay/codex-models.json`，使用不带 `[1m]` 的 Copilot ID，`gptModel` 排在第一位
作为默认。Codex 当前选择的模型如果是其中之一，会被保留；否则改为 `gptModel`。Codex 仍可指定
Copilot 模型目录列出的其他任何模型。见 [Codex](ZH-Codex.md)。

## Copilot app 与 Copilot CLI

按照 [GitHub Copilot app 与 Copilot CLI](ZH-Copilot-App.md) 的说明把中继添加为自定义提供方，
为每个槽位添加一个模型条目，使用不带 `[1m]` 的 Copilot ID。对于 Copilot CLI，把
`COPILOT_MODEL` 设为任一槽位，或用 `/model` 切换。
