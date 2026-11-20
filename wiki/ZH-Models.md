# 为每个客户端选择模型

中继向每个客户端提供一组 Copilot 模型：`gptModel`、`opusModel`，以及 `models` 键选出的模型。
默认情况下，这些是你的 Copilot 模型目录中每个厂商最新的模型，所以 Claude Code、Codex 和
Copilot CLI 可以通过同一个中继使用 GPT、Claude、MAI 和 Grok 模型。本页说明这个键、`auto`
如何选择，以及每个客户端需要怎样设置。其他配置键见[配置说明](ZH-Configuration.md)。

## `models` 键

```yaml
models: auto
```

`models` 只取一个值：

| 值 | 暴露的模型 |
| --- | --- |
| `auto`（默认） | `gptModel`、`opusModel`，以及每个厂商最新的模型；见下文“auto 如何选择”。 |
| 留空（`models:`） | 只有 `gptModel` 和 `opusModel`。 |
| 逗号分隔的 Copilot ID，例如 `gpt-6.2-astra, grok-4.7` | `gptModel`、`opusModel`，以及按你书写顺序排列的这些 ID。 |

- `config.yaml` 保留你写的值。`auto` 始终是 `auto`；中继不会把解析出的 ID 写回文件，
  所以模型目录更新后，选出的模型会随之变化，无需修改文件。
- 已有安装在首次启动带有该键的版本时，会像文件中缺少的其他键一样补上 `models: auto`。
- ID 以字母或数字开头，只包含字母、数字、`.`、`_` 和 `-`。其他值，或列表中出现 `auto`，
  都是无效值：启动会以
  `Invalid models: expected auto, empty, or comma-separated Copilot model IDs` 停止，
  热重载遇到它则保留正在运行的配置。
- 列出的 ID 如果不在 Copilot 的模型目录中，会被跳过，启动时记录一行写明该 ID。运行
  `copilot-relay models` 查看你的账号可用的 ID。
- 启动时用一行 `Exposed models: …` 记录结果，列出的是 Claude Code 看到的 ID。
- 该键对 Claude Code 路由和 `GET /v1/models` 热重载生效。Codex 的模型列表在启动时写入，
  所以要改变 Codex 显示的模型，需要重启中继。

## auto 如何选择

`auto` 检查 Copilot 模型目录中的每个模型，只保留同时满足以下条件的模型：

1. 带有 `model_picker_enabled`；
2. 类型为 `chat`；
3. 厂商不是 `Experimental`；
4. ID 中带有版本号：第一段由数字和点组成的内容，例如 `gpt-6.2-astra` 中的 `6.2`。

每个厂商保留一个模型：

1. 版本最高者，按数字元组比较，所以 `10` 比 `9` 新，`6.2` 比 `6` 新；
2. 版本相同时，选模型选择器类别更高者：`powerful`，其次 `versatile`，再次 `lightweight`；
3. 类别也相同时，选 ID 排序在前者。

没有厂商字段的目录模型不会被选中。完全没有模型目录时，`auto` 不添加任何模型，而列表中
写明的 ID 按原样保留。

以 2026-11-19 检查的模型目录为准，`auto` 选出了 `claude-opus-5.5`、`gpt-6.2-astra`、
`mai-code-2` 和 `grok-4.7`。你的模型目录取决于账号和组织策略，所以选出的模型可能不同。

## 暴露的模型列表

暴露的模型依次是 `gptModel`、`opusModel`，再是选出的模型，并去掉重复项。使用默认值
（`gptModel: gpt-6-astra`、`opusModel: claude-opus-5.5`、`models: auto`）和上面的模型
目录时，列表为 `gpt-6-astra`、`claude-opus-5.5`，然后是 `gpt-6.2-astra`、`mai-code-2` 和
`grok-4.7`；`claude-opus-5.5` 只出现一次。`GET /v1/models` 列出这些模型。

**Claude Messages 路由上的路由规则。** 请求中的模型名如果是某个暴露的模型（不区分大小写，
带不带 `[1m]` 均可），就发往该模型。其他包含 `opus` 的名称发往 `opusModel`，其余名称
（例如 Claude Code 的 `sonnet` 或 `haiku` 别名）发往 `gptModel`。未暴露的目录模型无法通过
这个路由访问。Codex 的路由（`POST /v1/responses`）不同：它转发 Copilot 模型目录列出的任何
模型；见 [Codex](ZH-Codex.md)。

**`[1m]`。** Claude Code 把模型 ID 末尾的 `[1m]` 理解为一百万 token 的 context 窗口。任何
ID（无论是否为 Claude），只要它自己在目录中的窗口至少为 1,000,000 token，中继就加上这个
后缀：这就是该模型的 1M 版本，Copilot 的模型目录中没有单独的 `-1m` ID。已知窗口更小时显示
不带后缀的 ID；窗口未知时，配置中的 ID 按原样保留。中继调用 Copilot 前会去掉 `[1m]`。2026-11-19 检查的模型
目录公布了：

| Copilot ID | 总 context | Claude Code ID |
| --- | ---: | --- |
| `gpt-6.2-astra` | 1,050,000 | `gpt-6.2-astra[1m]` |
| `gpt-6.2-sol` | 1,050,000 | `gpt-6.2-sol[1m]` |
| `gpt-6-astra` | 1,050,000 | `gpt-6-astra[1m]` |
| `mai-code-2` | 1,050,000 | `mai-code-2[1m]` |
| `claude-opus-5.5` | 1,000,000 | `claude-opus-5.5[1m]` |
| `grok-4.7` | 500,000 | `grok-4.7` |

**Effort。** 模型公布的推理等级按原样发送。其他等级改为不高于它的最高公布等级；没有更低的
公布等级时，改为最低的公布等级。`grok-4.7` 公布 `low` 到 `xhigh`，所以 `max` 以 `xhigh`
发送。不公布任何等级的模型，仍会以 HTTP 400 `relay_unsupported_effort` 拒绝明确指定的 effort。

**端点。** 有些模型在目录中列出了 `/chat/completions`，但 Copilot 在那里拒绝它们：
`mai-code-2` 会收到 `no_available_model_endpoints`。如果该模型同时列出了 `/responses`，
中继会把这样的请求在 `/responses` 上重试一次。

## Claude Code CLI

`claudeSetup` 和 `copilot-relay setup claude-code-cli` 会把中继地址、token 和预算写入
`~/.claude/settings.json`。它们不写 `modelPicker` 或 `availableModels`；模型选择器由你自己设置。

Claude Code 可以向网关查询模型（`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`），但它只保留
包含 `claude` 或 `anthropic` 的 ID，所以非 Claude 模型无法这样出现在 `/model` 中。请在用户级
`~/.claude/settings.json` 中用 `modelPicker` 添加它们（Claude Code 2.1.242 或更新版本），
并保留中继连接和其他所有设置：

```json
{
  "modelPicker": {
    "options": [
      { "model": "opus[1m]", "label": "Opus" },
      { "model": "gpt-6.2-astra[1m]", "label": "GPT-6.2 Astra", "behavesAs": "claude-sonnet-5" },
      { "model": "mai-code-2[1m]", "label": "MAI Code 2", "behavesAs": "claude-sonnet-5" },
      { "model": "grok-4.7", "label": "Grok 4.7", "behavesAs": "claude-sonnet-5" }
    ],
    "replaceBuiltInOptions": true
  },
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5.5[1m]"
  }
}
```

- `model` 按原样发送，所以请使用上表中的 Claude Code ID，中继显示 `[1m]` 的就带上 `[1m]`。
  `opus[1m]` 是 Claude Code 的 1M Opus 别名；`ANTHROPIC_DEFAULT_OPUS_MODEL` 让它指向
  `opusModel` 的 1M 版本 `claude-opus-5.5[1m]`。
- `label` 是该行的名称；一行还可以带 `description`。
- `behavesAs`（Claude Code 2.1.257 或更新版本）取你的 Claude Code 版本已经认识的模型 ID，
  例如 `claude-sonnet-5`。
- `replaceBuiltInOptions: true` 只显示这些行以及 **Default**。
- 如果也想在列表中看到 `gptModel`，再加一行 `gpt-6-astra[1m]`；它也是暴露的模型，只是这个
  示例只保留最新的 GPT 模型。
- 设置中的 `availableModels` 列表也会过滤模型选择器。如果之前的配置留下了它，请把这些 ID
  加进去，或者删除它。

然后用 `/model` 选择，或用 `claude --model 'mai-code-2[1m]'` 启动。见
[modelPicker 参考](https://code.claude.com/docs/en/settings-reference#modelpicker)
和[模型配置](https://code.claude.com/docs/en/model-config)。

Anthropic 不支持通过网关把 Claude Code 路由到非 Claude 模型；见
[LLM gateway](https://code.claude.com/docs/en/llm-gateway)。

## Claude Code app

保持不变：`copilot-relay setup claude-code-app` 把 `opusModel` 作为 app 的 Opus 档位，
把 `gptModel` 作为 Sonnet 档位，详见[命令](ZH-Commands.md)。app 中不提供额外的模型。

## Codex

`start` 时的 `codexSetup`，以及 `copilot-relay setup codex-cli codex-app`，会把每个暴露的
模型写入 `~/.copilot-relay/codex-models.json`，使用不带 `[1m]` 的 Copilot ID，`gptModel`
排在第一位作为默认。Codex 当前选择的模型如果已在列表中，会被保留。修改 `models` 后，先重启
中继，再重启 Codex。Codex 也可以指定 Copilot 模型目录列出的其他任何模型。见
[Codex](ZH-Codex.md)。

## Copilot app 与 Copilot CLI

按照 [GitHub Copilot app 与 Copilot CLI](ZH-Copilot-App.md) 的说明把中继添加为自定义提供方，
然后为每个暴露的 ID 添加一个模型条目，使用不带 `[1m]` 的 Copilot ID。对于 Copilot CLI，把
`COPILOT_MODEL` 设为任意暴露的 ID，例如 `grok-4.7`，或用 `/model` 切换。

## 固定模型

要自己决定列表，写出这些 ID：

```yaml
models: gpt-6.2-astra, grok-4.7
```

只提供 `gptModel` 和 `opusModel` 时，留空即可：

```yaml
models:
```

两种写法对 Claude Code 都会热重载。Codex 的列表需要重启中继；同时请更新 Claude Code 的
`modelPicker` 行和 Copilot 提供方中的模型条目，使它们保持一致。
