# Choose models for each agent

The relay serves two Copilot models: `gptModel` and `opusModel`. Every client
request reaches one of them, so Claude Code, Codex and Copilot CLI share one
predictable pair. This page covers the rule, how to pick the two models, the 1M
context window, cost, and what to set in each client. Every other key is in
[Configuration](EN-Configuration.md).

## The two-model rule

```yaml
gptModel: gpt-6.2-astra
opusModel: claude-opus-5.5
```

| Requested model name | Reaches |
| --- | --- |
| exactly `opusModel`, in any case, with or without `[1m]` | `opusModel` |
| exactly `gptModel`, in any case, with or without `[1m]` | `gptModel` |
| any other name containing `opus`, such as `opus` or `claude-opus-4-5-20251101` | `opusModel` |
| any other name, such as `sonnet`, `haiku`, `claude-haiku-4-5-20251001` or `grok-4.7` | `gptModel` |

- A slot's own name wins over the `opus` rule, so `gptModel: gpt-opus-lab` and
  `opusModel: claude-sonnet-5` each reach their own slot.
- Clients are offered exactly these two models: `GET /v1/models` lists `gptModel`,
  then `opusModel`, and lists one entry when both name the same model.
- The rule applies to Claude Code's routes (`POST /v1/messages` and
  `/v1/messages/count_tokens`). Codex's route, `POST /v1/responses`, keeps its own
  rule; see [Codex](EN-Codex.md).
- Both keys hot-reload for Claude Code routing and `GET /v1/models`. Restart the relay
  to change what Codex lists.
- A fresh install starts with `gptModel: gpt-6.2-astra`. An existing `config.yaml`
  keeps its own value.

## Pick the two models

`copilot-relay models` lists every model your Copilot account can use, with its cost
and context window:

```text
copilot-relay models
```

Set `gptModel` and `opusModel` to IDs exactly as listed. Startup probes both and
stops if Copilot's catalog lacks either.

A config written by an earlier release may still have a `models:` line. It has no
effect and its value is not checked; you can delete it.

## 1M context

Claude Code reads `[1m]` at the end of a model ID as a one-million-token context
window. The relay adds it to a slot whose own catalog window is at least 1,000,000
tokens; nothing is configured. A smaller known window shows the plain ID, and an
unknown window leaves the configured ID as written. The relay strips `[1m]` before
calling Copilot.

| Copilot ID | Total context | Claude Code sees |
| --- | ---: | --- |
| `gpt-6.2-astra` | 1,050,000 | `gpt-6.2-astra[1m]` |
| `claude-opus-5.5` | 1,000,000 | `claude-opus-5.5[1m]` |
| `grok-4.7` | 500,000 | `grok-4.7` |

Values from the catalog checked on 2026-11-20. To check yours, run
`copilot-relay models` or read `GET /v1/models`.

## Cost

`copilot-relay models` shows each model's cost from Copilot's catalog: the input and
output price in USD per million tokens, such as `8/40` for `gpt-6.2-astra` and
`4/20` for `claude-opus-5.5`. An account that reports only a premium-request
multiplier shows it as `1×`, `0.33×` or `0×`; a model with no cost data shows `–`.

## Effort and endpoint

**Effort.** A reasoning effort the model advertises is sent as is. Any other level
becomes the highest advertised level at or below it, or the lowest advertised level
when none is below. A model that advertises no levels still rejects an explicit
effort with HTTP 400 `relay_unsupported_effort`.

**Endpoint.** Some models list `/chat/completions` in the catalog but Copilot refuses
them there with `no_available_model_endpoints`. When the model also lists
`/responses`, the relay retries such a request once on `/responses`.

## Claude Code CLI

`claudeSetup` and `copilot-relay setup claude-code-cli` write the relay's address,
token and budgets to `~/.claude/settings.json`, and set `model` to `gptModel` as
Claude Code sees it when no model is chosen yet. Claude Code's own picker aliases
then follow the rule above: Opus reaches `opusModel`, Sonnet and Haiku reach
`gptModel`.

To show both slots by their own names in `/model`, add a `modelPicker` to your user
`~/.claude/settings.json` (Claude Code 2.1.242 or newer), keeping the relay connection
and every other setting:

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

- `model` is sent verbatim, so use the ID Claude Code sees, with `[1m]` where the
  relay shows it. `ANTHROPIC_DEFAULT_OPUS_MODEL` makes `opus[1m]` name the 1M
  version of `opusModel`.
- `behavesAs` (Claude Code 2.1.257 or newer) takes the ID of a model your Claude Code
  version already knows, such as `claude-sonnet-5`.
- `replaceBuiltInOptions: true` shows only these rows plus **Default**.

See the [modelPicker reference](https://code.claude.com/docs/en/settings-reference#modelpicker)
and [model configuration](https://code.claude.com/docs/en/model-config). Anthropic
does not support routing Claude Code to non-Claude models through a gateway; see
[LLM gateway](https://code.claude.com/docs/en/llm-gateway).

## Claude Code app

`copilot-relay setup claude-code-app` gives the app `opusModel` as its Opus tier and
`gptModel` as its Sonnet tier; see [Commands](EN-Commands.md).

## Codex

`codexSetup` at `start`, and `copilot-relay setup codex-cli codex-app`, write
`~/.copilot-relay/codex-models.json` with the two slots as plain Copilot IDs without
`[1m]`, `gptModel` first as the default. A Codex model selection that is one of them
is kept; any other is replaced by `gptModel`. Codex can still name any other model
Copilot's catalog lists. See [Codex](EN-Codex.md).

## Copilot app and Copilot CLI

Add the relay as a custom provider as [GitHub Copilot app and Copilot CLI](EN-Copilot-App.md)
describes, with one model entry per slot, using the plain Copilot ID without `[1m]`.
For Copilot CLI, set `COPILOT_MODEL` to either slot, or switch with `/model`.
