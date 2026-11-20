# Choose models for each agent

The relay offers each client a list of Copilot models: `gptModel`, `opusModel`, and
the models the `models` key selects. By default that is the newest model of each
vendor in your Copilot catalog, so Claude Code, Codex and Copilot CLI can reach
GPT, Claude, MAI and Grok models through one relay. This page covers the key, how
`auto` picks, and what to set in each client. Every other key is in
[Configuration](EN-Configuration.md).

## The `models` key

```yaml
models: auto
```

`models` takes one value:

| Value | Exposed models |
| --- | --- |
| `auto` (the default) | `gptModel`, `opusModel`, and the newest model of each vendor; see "How auto picks" below. |
| empty (`models:`) | `gptModel` and `opusModel` only. |
| comma-separated Copilot IDs, such as `gpt-6.2-astra, grok-4.7` | `gptModel`, `opusModel`, and those IDs in the order you wrote them. |

- `config.yaml` keeps what you wrote. `auto` stays `auto`; the relay never writes
  the IDs it resolved back to the file, so a newer catalog changes the picks without
  an edit.
- An existing install gets `models: auto` added on the first start of a version
  that has the key, like any key missing from the file.
- An ID starts with a letter or digit and holds only letters, digits, `.`, `_` and
  `-`. Any other value, or `auto` inside a list, is invalid: startup stops with
  `Invalid models: expected auto, empty, or comma-separated Copilot model IDs`, and
  a hot reload with it keeps the running config.
- A listed ID that Copilot's catalog does not list is skipped, and startup logs a
  line naming it. Run `copilot-relay models` to see the IDs your account has.
- Startup logs the result on one line, `Exposed models: …`, with the IDs Claude Code
  sees.
- The key hot-reloads for Claude Code routing and `GET /v1/models`. The Codex model
  list is written at start, so restart the relay to change what Codex shows.

## How auto picks

`auto` looks at every model in Copilot's catalog and keeps only those that:

1. have `model_picker_enabled`,
2. are of type `chat`,
3. have a vendor other than `Experimental`, and
4. have a version number in the ID: the first run of digits and dots, such as `6.2`
   in `gpt-6.2-astra`.

For each vendor it keeps one model:

1. the highest version, compared as a tuple of numbers, so `10` is newer than `9`
   and `6.2` newer than `6`;
2. on equal versions, the higher picker category: `powerful`, then `versatile`,
   then `lightweight`;
3. on equal categories, the ID that sorts first.

A catalog model without a vendor is not picked. With no catalog at all, `auto`
adds nothing, while a listed ID is kept as written.

Against the catalog checked on 2026-11-19, `auto` picked `claude-opus-5.5`,
`gpt-6.2-astra`, `mai-code-2` and `grok-4.7`. Your account and organization policy
decide what your catalog lists, so your picks can differ.

## The exposed list

The exposed models are `gptModel`, then `opusModel`, then the selected models, with
duplicates removed. With the defaults (`gptModel: gpt-6-astra`,
`opusModel: claude-opus-5.5`, `models: auto`) and the catalog above, that is
`gpt-6-astra`, `claude-opus-5.5`, then `gpt-6.2-astra`, `mai-code-2` and `grok-4.7`;
`claude-opus-5.5` appears once. `GET /v1/models` lists them.

**Routing on the Claude Messages route.** A request that names an exposed model, in
any case and with or without `[1m]`, goes to that model. Any other name containing
`opus` goes to `opusModel`, and every other name, such as Claude Code's `sonnet` or
`haiku` aliases, goes to `gptModel`. A catalog model that is not exposed is not
reached through this route. Codex's route (`POST /v1/responses`) is different: it
forwards any model Copilot's catalog lists; see [Codex](EN-Codex.md).

**`[1m]`.** Claude Code reads `[1m]` at the end of a model ID as a one-million-token
context window. The relay adds it to every ID, Claude or not, whose own catalog
window is at least 1,000,000 tokens: that is the model's 1M version, and Copilot's
catalog has no separate `-1m` IDs. A smaller known window shows the plain ID, and an
unknown window leaves the configured ID as written. The relay strips `[1m]` before
calling Copilot. The catalog
checked on 2026-11-19 reported:

| Copilot ID | Total context | Claude Code ID |
| --- | ---: | --- |
| `gpt-6.2-astra` | 1,050,000 | `gpt-6.2-astra[1m]` |
| `gpt-6.2-sol` | 1,050,000 | `gpt-6.2-sol[1m]` |
| `gpt-6-astra` | 1,050,000 | `gpt-6-astra[1m]` |
| `mai-code-2` | 1,050,000 | `mai-code-2[1m]` |
| `claude-opus-5.5` | 1,000,000 | `claude-opus-5.5[1m]` |
| `grok-4.7` | 500,000 | `grok-4.7` |

**Effort.** A reasoning effort the model advertises is sent as is. Any other level
becomes the highest advertised level at or below it, or the lowest advertised level
when none is below. `grok-4.7` advertises `low` through `xhigh`, so `max` is sent
as `xhigh`. A model that advertises no levels still rejects an explicit effort with
HTTP 400 `relay_unsupported_effort`.

**Endpoint.** Some models list `/chat/completions` in the catalog but Copilot refuses
them there: `mai-code-2` is answered with `no_available_model_endpoints`. When the
model also lists `/responses`, the relay retries such a request once on
`/responses`.

## Claude Code CLI

`claudeSetup` and `copilot-relay setup claude-code-cli` write the relay's address,
token and budgets to `~/.claude/settings.json`. They do not write `modelPicker` or
`availableModels`; the picker is yours to set.

Claude Code can ask a gateway for its models
(`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`), but it keeps only IDs containing
`claude` or `anthropic`, so the non-Claude models never reach `/model` that way. Add
them with `modelPicker` in your user `~/.claude/settings.json` (Claude Code 2.1.242
or newer), keeping the relay connection and every other setting:

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

- `model` is sent verbatim, so use the Claude Code ID from the table above, with
  `[1m]` where the relay shows it. `opus[1m]` is Claude Code's 1M Opus alias;
  `ANTHROPIC_DEFAULT_OPUS_MODEL` makes it name the 1M version of `opusModel`,
  `claude-opus-5.5[1m]`.
- `label` is the row's name; a row can also carry a `description`.
- `behavesAs` (Claude Code 2.1.257 or newer) takes the ID of a model your Claude Code
  version already knows, such as `claude-sonnet-5`.
- `replaceBuiltInOptions: true` shows only these rows plus **Default**.
- Add a row for `gpt-6-astra[1m]` too if you want `gptModel` in the list; it is
  exposed, but this example keeps the newest GPT model only.
- An `availableModels` list in your settings also filters the picker. If an earlier
  setup left one, add these IDs to it or remove it.

Then pick with `/model`, or start with `claude --model 'mai-code-2[1m]'`. See the
[modelPicker reference](https://code.claude.com/docs/en/settings-reference#modelpicker)
and [model configuration](https://code.claude.com/docs/en/model-config).

Anthropic does not support routing Claude Code to non-Claude models through a
gateway; see [LLM gateway](https://code.claude.com/docs/en/llm-gateway).

## Claude Code app

Unchanged: `copilot-relay setup claude-code-app` gives the app `opusModel` as its
Opus tier and `gptModel` as its Sonnet tier, as described in
[Commands](EN-Commands.md). The extra models are not offered in the app.

## Codex

`codexSetup` at `start`, and `copilot-relay setup codex-cli codex-app`, write
`~/.copilot-relay/codex-models.json` with every exposed model, as plain Copilot IDs
without `[1m]`, `gptModel` first as the default. A Codex model selection that is
already in the list is kept. Restart the relay, then Codex, after changing `models`.
Codex can also name any other model Copilot's catalog lists. See
[Codex](EN-Codex.md).

## Copilot app and Copilot CLI

Add the relay as a custom provider as [GitHub Copilot app and Copilot CLI](EN-Copilot-App.md)
describes, then add one model entry per exposed ID, using the plain Copilot ID
without `[1m]`. For Copilot CLI, set `COPILOT_MODEL` to any exposed ID, such as
`grok-4.7`, or switch with `/model`.

## Pin models

To choose the list yourself, write the IDs:

```yaml
models: gpt-6.2-astra, grok-4.7
```

To offer only `gptModel` and `opusModel`, leave it empty:

```yaml
models:
```

Both hot-reload for Claude Code. Restart the relay for Codex's list, and update
your Claude Code `modelPicker` rows and Copilot provider entries to match.
