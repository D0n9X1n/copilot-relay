# How copilot-relay works

`copilot-relay` is a local Claude Messages API relay backed by GitHub Copilot.

Claude Code talks to:

```text
http://127.0.0.1:4142/v1/messages
```

`copilot-relay` translates the request and sends it to GitHub Copilot upstream.

## Runtime flow

```text
Claude Code
  -> local Hono server
  -> /v1/messages route
  -> Claude-to-Copilot translation
  -> model routing
  -> GitHub Copilot /chat/completions or /responses
  -> Copilot-to-Claude translation
  -> Claude Code
```

## Startup flow

```text
copilot-relay start
  -> read ~/.copilot-relay/config.yaml
  -> load github_token
  -> load or refresh copilot_token.json
  -> validate configured models with upstream preflight
  -> optionally update ~/.claude/settings.json
  -> listen on host/port
  -> watch config.yaml for hot reload
```

## Public API surface

Only Claude Code-compatible endpoints are public:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /healthz`
- `GET|HEAD /api/hello`

`/api/hello` is a reachability probe Claude Code sends on startup and around
real traffic. Like `/healthz`, it is answered locally and never contacts
Copilot, so a `200` means the relay is listening — not that it can serve a
request. Use `copilot-relay status --deep` for that.

`/healthz` answers `{"ok": true, "version": "..."}`, where `version` is the
build of the process answering — the running relay, not whichever CLI asked.
That is what lets `copilot-relay status` tell you an upgrade has been installed
but not restarted.

OpenAI-compatible routes are intentionally not public.

## Model routing

Routing is simple by design:

| Requested model | Upstream model |
| --- | --- |
| contains `opus` | `opusModel` |
| anything else | `gptModel` |

Default upstream models:

```yaml
gptModel: gpt-5.5
opusModel: claude-opus-4.8
```

## Copilot API surface

Internally, Copilot may require either:

- `/chat/completions`
- `/responses`

`gpt-5.5` uses `/responses`. Opus currently uses `/chat/completions`.

The relay hides this from Claude Code and always exposes Claude Messages-style
responses.

## Auth and tokens

`github_token` is the long-lived token created by device login.

`copilot_token.json` stores a short-lived Copilot bearer token:

```json
{
  "refreshedAt": 0,
  "refreshIn": 0,
  "token": "..."
}
```

On startup, the relay reuses the cached Copilot token if it has more than 60
seconds left. Otherwise it refreshes from `github_token`.

## Streaming

Copilot streams OpenAI-style chat chunks. Claude Code expects Claude SSE events.
The relay maintains a small state machine to open, delta, and close Claude
content blocks in the correct order for text, thinking, and tool use.

