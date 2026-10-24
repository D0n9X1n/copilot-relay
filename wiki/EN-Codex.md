# Codex CLI and the Codex app

The relay serves the OpenAI Responses API at `POST /v1/responses`, the only wire
API Codex speaks. Codex CLI, the Codex app, and the IDE extension read the same
`~/.codex/config.toml` and run the same `codex app-server`, so one provider block
sets up all three. Requests go to the GPT models Copilot serves on `/responses`.

This was checked with Codex CLI 0.164.0 against a live relay: one `codex exec`
turn and one `codex app-server` turn each created a file with `apply_patch`, ran
a shell command, and completed.

## Set up Codex

Start the relay as usual (`copilot-relay start`), then add this to
`~/.codex/config.toml`:

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

Put `model`, `model_provider` and `model_reasoning_effort` above the first table, as
TOML requires. A project's `.codex/config.toml` cannot set a provider; Codex
ignores it there with a warning.

Then run `codex`, or restart the Codex app so it reads the file.

| Key | Why |
| --- | --- |
| `base_url` | The relay's address with `/v1`. Codex appends `/responses`. Use your `host` and `port` from `config.yaml`. |
| `wire_api = "responses"` | The only value Codex accepts. |
| `requires_openai_auth = false` | Codex skips the ChatGPT sign-in and sends no OpenAI credential to the relay. |
| `supports_websockets = false` | The relay speaks HTTP and SSE only. `false` is the default for a custom provider. |
| `name` | Anything except `OpenAI`. Codex turns on OpenAI-only behavior for that name, such as remote compaction, which the relay does not serve. |

Leave `env_key`, `model_catalog_url` and the `auth` command unset. With any of them
Codex either needs an environment variable or fetches `/models` in a format the
relay does not serve.

### When the relay has an `apiKey`

Send the key in a fixed header:

```toml
[model_providers.copilot-relay]
name = "copilot-relay"
base_url = "http://127.0.0.1:4142/v1"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
http_headers = { "x-api-key" = "<the apiKey from config.yaml>" }
```

`env_key` also works in a terminal, but the Codex app is often started without
your shell's variables, and a missing `env_key` variable stops every turn.
`http_headers` keeps the key in the file, so keep `config.toml` private.

## Choose a model

Pick an ID from `copilot-relay models` that lists `/responses`. Prefer one Codex
already knows: `gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-luna`,
`gpt-5.6-sol`, `gpt-5.6-terra` or `gpt-5.6-luna`. These are the same IDs in Copilot
and in Codex's bundled model list, so Codex gives them its `apply_patch` tool, its
reasoning levels and a 272k context window, and the app's model picker shows them.

Codex knows nothing about other Copilot IDs, such as `gpt-5.3-codex`. For those it
falls back to generic settings: no `apply_patch` tool (it edits files through the
shell) and a 272k context window. Set `model_context_window` and
`model_auto_compact_token_limit` in `config.toml` if you need a different budget.

How the relay picks the Copilot model:

| Requested model | Sent to Copilot |
| --- | --- |
| an ID Copilot's catalog lists with `/responses` | that ID |
| an ID the catalog does not list, such as Codex's internal `codex-auto-review` | `gptModel` from `config.yaml` |
| a `claude-*` ID | refused with HTTP 400 `relay_unsupported_model` |
| a listed ID without `/responses` | refused with HTTP 400 `relay_unsupported_endpoint` |

Copilot serves Claude models only on Messages and Chat Completions, so Codex cannot
use them through the relay. Use Claude Code for Claude models.

## What the relay changes

The request body is forwarded as Codex sent it, including its `prompt_cache_key`,
encrypted reasoning, `apply_patch` grammar tool and `client_metadata`. Only what
Copilot answers with HTTP 400 is changed:

| Codex sends | The relay |
| --- | --- |
| `service_tier` | removes it |
| a tool of type `image_generation` | removes that tool |
| a `reasoning.effort` the model does not take, such as `ultra` | sends the highest level the model lists below it, such as `max` |

Copilot's SSE comes back unchanged. Upstream errors keep their status, body and
`retry-after`. One error is reshaped: a prompt over the model's input limit,
which Copilot reports as HTTP 400, reaches a streaming Codex request as
`response.failed` with code `context_length_exceeded`, the event Codex answers by
compacting the conversation.

`x-initiator` is `user` when the last input item is a user message and `agent`
otherwise, such as after a tool call. Codex's subagents (review, compaction,
memory consolidation, spawned agents) are always `agent`.

## Check it works

```sh
codex exec --skip-git-repo-check "Reply with the single word: ok"
```

Then look for the request in the relay log:

```sh
grep 'client=codex' ~/.copilot-relay/logs/copilot-relay.$(date +%F).log | tail -3
```

```text
info request_id=… Model request client=codex requested_model=gpt-6-astra upstream_model=gpt-6-astra upstream_api=responses requested_think_effort=medium effective_think_effort=medium initiator=user
```

`copilot-relay cache` counts Codex requests with the rest of the `/responses`
traffic. Codex closes its stream as soon as it reads `response.completed`, a moment
before Copilot ends the body, so a finished Codex request is often logged with
`body=cancelled` next to `response_status=completed terminal=true`. That pair means
the answer arrived in full.

## Limitations

- GPT models only; see "Choose a model".
- HTTP and SSE only: no WebSockets, and no `/responses/compact`. Codex compacts
  long conversations itself with ordinary requests.
- `upstreamTimeoutSeconds` caps each request, including a long streamed answer.
- No model catalog: Codex's own model list is used.
- The relay was checked with Codex CLI 0.164.0 and its app server. Later Codex
  versions can change what they send.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| HTTP 401 | The relay has an `apiKey`; add it as `http_headers`. |
| HTTP 400 `relay_unsupported_model` | A `claude-*` model; choose a GPT model. |
| HTTP 400 `relay_unsupported_endpoint` | The model has no `/responses` on Copilot; check `copilot-relay models`. |
| HTTP 400 `unsupported_value` from Copilot | Codex sent a field Copilot rejects that the relay does not yet change. The log line before it names the request. |
| HTTP 415 | The request was not sent as `application/json`. |
| HTTP 404 on `/responses` | `base_url` lacks `/v1`. |
| Codex asks you to sign in | `requires_openai_auth` is missing or `true`. |
| `Missing environment variable` | An `env_key` is set; the app cannot see it. Use `http_headers`. |
| No `apply_patch`; edits go through the shell | The model ID is not in Codex's own list; see "Choose a model". |

For log format and other failures see [Logs and troubleshooting](EN-Logging-Troubleshooting.md).
How the route works inside the relay is in [Internals](EN-Internals.md).
