# Codex CLI and the Codex app

The relay serves the OpenAI Responses API at `POST /v1/responses`, the only wire
API Codex speaks. Codex CLI, the Codex app, and the IDE extension read the same
`~/.codex/config.toml` and run the same `codex app-server`, so one setup covers all
three. Codex offers the same two models Claude Code does, `gptModel` and
`opusModel`, and needs no ChatGPT sign-in.

This was checked with Codex CLI 0.164.0 against a live relay: `codex exec` turns on
GPT-6 Astra and on Claude Opus 5.5 each created a file with `apply_patch`, ran a
shell command and completed, and the app server listed exactly those two models.

## Set up Codex

With `codexSetup: true`, the default, `copilot-relay start` sets Codex up when it
is installed, that is when `$CODEX_HOME` (default `~/.codex`) exists. Restart Codex,
or the Codex app, afterwards so it reads the files. `copilot-relay setup codex-app`
does the same without starting the relay, and `--force` sets Codex up before it
has run here.

`start` writes two things:

- `~/.copilot-relay/codex-models.json`: the model list Codex shows, holding only
  `gptModel` and `opusModel`, with `gptModel` first as the default.
- In `~/.codex/config.toml`:

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

`model` is changed only when it is not already one of the two models. With an
`apiKey` set, the table also gets `http_headers = { "x-api-key" = "…" }`, and the
file is published owner-only. Every other key, table and comment is left as it is.
`start` logs `codex settings updated`, `codex settings already up to date`, or
`codex setup skipped` when Codex is not installed.

| Key | Why |
| --- | --- |
| `model_catalog_json` | Codex takes this file as its whole model list, so the CLI and the app picker show only these two models. |
| `base_url` | The relay's address with `/v1`. Codex appends `/responses`. |
| `wire_api = "responses"` | The only value Codex accepts. |
| `requires_openai_auth = false` | Codex skips the ChatGPT sign-in and sends no OpenAI credential to the relay. |
| `supports_websockets = false` | The relay speaks HTTP and SSE only. |
| `name` | Anything except `OpenAI`. Codex turns on OpenAI-only behavior for that name, such as remote compaction, which the relay does not serve. |
| `http_headers` | Sends the `apiKey`. The Codex app is often started without your shell's variables, so an `env_key` would stop every turn there. |

`start` refuses to edit, and logs why, when `config.toml` defines
`model_providers.copilot-relay` outside its own table, with dotted keys or an inline
table, or when the edited file would not read back as the original with only these
values changed. A project's `.codex/config.toml` cannot set a provider; Codex ignores it there.

### Set it up by hand

With `codexSetup: false`, write the same keys yourself. Without
`model_catalog_json` Codex shows its own model list instead, and only GPT models
work.

## Models

The list holds `gptModel` and `opusModel` from `config.yaml`, as Claude Code's
picker does. Change either and restart the relay to change the list.

- A model Codex ships itself, such as `gpt-6-astra`, keeps Codex's own entry: its
  tuned instructions, `apply_patch` tool and reasoning levels.
- Any other model, such as `claude-opus-5.5`, gets an entry the relay builds: Codex's
  `apply_patch` tool and shell, the reasoning levels Copilot lists, and the
  instructions Codex uses for any model it does not know.

Every model's context window comes from Copilot's catalog, so a 1M-context model is
used as one rather than at Codex's usual 272k. `context_window`, the window Codex
works in and compacts at 90% of, is the most input Copilot accepts that still leaves
room for a full reply: `min(input limit, total window - output limit)`, for example
922k for GPT-6 Astra and 872k for Claude Opus 5.5. `max_context_window` is
Copilot's input limit; it only bounds a `model_context_window` you set in
`config.toml`. When setup cannot read Copilot's catalog, a model Codex ships keeps
Codex's own window and any other model gets none.

Both come from files copied from `openai/codex` at `rust-v0.164.0`, under its
Apache-2.0 license, in the package's `vendor/codex/`.

How the relay serves each model:

| Requested model | Sent to Copilot |
| --- | --- |
| a GPT ID Copilot lists with `/responses` | `/responses`, forwarded |
| a `claude-*` ID Copilot lists with `/v1/messages` | `/v1/messages`, translated; see "Claude models" |
| an ID the catalog does not list, such as Codex's internal `codex-auto-review` | `gptModel` from `config.yaml` |
| a `claude-*` ID Copilot does not list | refused with HTTP 400 `relay_unsupported_model` |
| a listed ID without a usable endpoint | refused with HTTP 400 `relay_unsupported_endpoint` |

## What the relay changes for GPT models

The request body is forwarded as Codex sent it, including its `prompt_cache_key`,
encrypted reasoning, `apply_patch` grammar tool and `client_metadata`. Only what
Copilot answers with HTTP 400 is changed:

| Codex sends | The relay |
| --- | --- |
| `service_tier` | removes it |
| a tool of type `image_generation` | removes that tool |
| a `reasoning.effort` the model does not take, such as `ultra` | sends the highest level the model lists below it, such as `max` |

Copilot's SSE comes back as it is sent, except that every event about one output
item names it by the same id: Copilot gives each event a new id, and the Codex app
would show the reply twice. Upstream errors keep their status, body and
`retry-after`.

## Claude models

Copilot serves Claude only on Messages and Chat Completions, so for a `claude-*`
model the relay translates each Responses request into a native Claude Messages
request, and Claude's stream back into Responses events:

- `instructions` and the leading developer messages become the system prompt.
  Function tools keep their schema; `apply_patch` becomes a tool with one string
  input, its grammar in the description. Hosted tools such as `web_search` are
  dropped.
- Text, thinking and tool calls come back as message, reasoning and
  `function_call` or `custom_tool_call` items. Claude's signed thinking travels in
  the reasoning item's `encrypted_content`, so the next turn sends it back.
- The effort Codex sends is clamped to Claude's levels and sent as adaptive thinking.
- Prompt-cache breakpoints go where Claude Code puts them, so later turns read the
  earlier ones from cache.

## Shared behavior

A prompt over the model's input limit, which Copilot reports as HTTP 400, reaches a
streaming Codex request as `response.failed` with code `context_length_exceeded`,
the event Codex answers by compacting the conversation.

`x-initiator` is `user` when the last input item is a user message and `agent`
otherwise, such as after a tool call. Codex's subagents (review, compaction,
memory consolidation, spawned agents) are always `agent`.

## Check it works

```sh
codex exec --skip-git-repo-check "Reply with the single word: ok"
codex exec --skip-git-repo-check -m claude-opus-5.5 "Reply with the single word: ok"
```

Then look for the requests in the relay log:

```sh
grep 'client=codex' ~/.copilot-relay/logs/copilot-relay.$(date +%F).log | tail -3
```

```text
info request_id=… Model request client=codex requested_model=gpt-6-astra upstream_model=gpt-6-astra upstream_api=responses requested_think_effort=medium effective_think_effort=medium initiator=user
info request_id=… Model request client=codex requested_model=claude-opus-5.5 upstream_model=claude-opus-5.5 upstream_api=messages effective_think_effort=medium initiator=user
```

`copilot-relay cache` counts Codex requests with the rest of the `/responses` and
`/v1/messages` traffic. Codex closes a GPT stream as soon as it reads
`response.completed`, a moment before Copilot ends the body, so a finished GPT
request is often logged with `body=cancelled` next to
`response_status=completed terminal=true`. That pair means the answer arrived in full.

## Limitations

- No hosted web search for Claude models through Codex.
- `--output-schema` with a Claude model is sent to Claude as an instruction, not
  enforced; check the reply if a script depends on it.
- HTTP and SSE only: no WebSockets, and no `/responses/compact`. Codex compacts
  long conversations itself with ordinary requests.
- `upstreamTimeoutSeconds` caps each request, including a long streamed answer.
- With `logLevel: debug` a Codex request is captured like any other, but
  `copilot-relay replay` accepts only Messages and count-tokens captures.
- The relay was checked with Codex CLI 0.164.0 and its app server. Later Codex
  versions can change what they send.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Codex shows its own models or asks you to sign in | `codexSetup` is `false`, Codex was not installed when the relay started, or Codex was not restarted. Check the `codex settings` line in the relay log. |
| `codex settings` line says it refused | `config.toml` defines `copilot-relay` or `model_providers` with dotted keys or an inline table, is not valid TOML, or holds something the edit would change; the line says which. Fix it, or set up Codex by hand. |
| HTTP 401 | The relay has an `apiKey` and the request lacks it; restart the relay so `start` writes it. |
| HTTP 400 `relay_unsupported_model` | A `claude-*` model Copilot does not list. |
| HTTP 400 `relay_unsupported_endpoint` | The model has no usable endpoint on Copilot; check `copilot-relay models`. |
| HTTP 400 `unsupported_value` from Copilot | Codex sent a field Copilot rejects that the relay does not yet change. The log line before it names the request. |
| HTTP 415 | The request was not sent as `application/json`. |
| HTTP 500 `Unsupported Claude API route` on `/responses` | `base_url` lacks `/v1`. |

For log format and other failures see [Logs and troubleshooting](EN-Logging-Troubleshooting.md).
How the route works inside the relay is in [Internals](EN-Internals.md).
