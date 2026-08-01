# Architecture

`copilot-relay` is just another relay for Claude Code to use a GitHub Copilot
subscription. It exposes Claude-compatible endpoints on localhost and translates
those requests into GitHub Copilot upstream calls.

This page is the map: what the pieces are, how a request moves through them, and
where the boundaries sit. For the precise mechanics behind each boundary — module
names, invariants, and the reasoning that pins them — see [Internals](EN-Internals.md).
For day-to-day operation see [Configuration](EN-Configuration.md) and
[Logs and troubleshooting](EN-Logging-Troubleshooting.md).

## The shape of it

Claude Code thinks it is talking to the Anthropic Messages API. It is talking to
a local Hono server that speaks the same protocol and answers using a GitHub
Copilot subscription.

```text
Claude Code
  |
  |  Anthropic-style HTTP requests
  v
src/server.ts
  |
  |  Hono routes
  v
src/routes/claude.ts
  |
  |  Claude payload + tool name mapping
  v
src/claude/*
  |
  |  Copilot chat/responses payload
  v
src/copilot/*
  |
  |  GitHub Copilot authenticated requests
  v
GitHub Copilot API
```

Everything above `src/copilot/*` speaks Claude. Everything below it speaks
Copilot. The translation layer in between is the whole product.

## Public API

Only Claude Code-facing endpoints are public:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /healthz`
- `GET|HEAD /api/hello`

The proxy calls Copilot `/chat/completions` and `/responses` internally, but it
does not expose public OpenAI-compatible routes. Unknown routes return `500` and
log method, path, selected headers, and the request payload, so a future
compatibility gap arrives with the evidence needed to close it.

### What the cheap endpoints do and do not prove

`/api/hello` is a static reachability probe Claude Code sends on startup and
around real traffic. It is answered by `src/server.ts` directly and never
contacts Copilot.

`/healthz` returns `{ok: true, version}`. It is process-local — it never contacts
Copilot either.

Both answer `200` from a relay whose Copilot token expired an hour ago. A `200`
means the relay is listening, not that it can serve a request. Only
`POST /v1/messages` exercises token refresh and a real Copilot call, which is why
`copilot-relay status --deep` exists and why the cheap checks are not enough on
their own.

The `version` in `/healthz` is the build of the process *answering* — the running
daemon, not whichever CLI asked. It is the only surface that reports this, and it
is what lets `copilot-relay status` tell you an upgrade is installed but not yet
restarted.

## Model routing

Routing is deliberately simple and entirely config-driven:

| Requested model | Upstream model |
| --- | --- |
| contains `opus` | `opusModel` |
| anything else | `gptModel` |

Shipped defaults:

```yaml
gptModel: gpt-5.6-sol
opusModel: claude-opus-5
```

`src/lib/models.ts` owns this mapping and also validates the allowed
`thinkEffort` values: `none`, `low`, `medium`, `high`, `xhigh`, `max`.

Which upstream *API* a model uses is a separate question from which model runs.
`gpt-5.6-sol` and the rest of the `gpt-5.5`/`gpt-5.6` family go through Copilot
`/responses`; Opus currently uses `/chat/completions`. Claude Code never sees the
difference — both paths return Claude Messages-style responses. The consequences
of that split are in [Internals](EN-Internals.md).

## Main modules

| Module | Responsibility |
| --- | --- |
| `src/server.ts` | Creates the Hono server, attaches request logging, registers Claude routes, exposes health/root endpoints. |
| `src/routes/claude.ts` | Owns the local Claude API surface: parses requests, logs model routing, calls the translator, handles streaming and non-streaming responses, implements `count_tokens`. |
| `src/claude/types.ts` | Only the subset of Claude Messages API types the proxy needs. Intentionally not a full Claude SDK. |
| `src/claude/translate.ts` | Non-streaming translation both ways, including tool calls and thinking/text blocks. |
| `src/claude/stream.ts` | Converts streaming Copilot chunks into Claude SSE events. Stateful, because Claude requires explicit block start/delta/stop. |
| `src/claude/web-search-stream.ts` | Lets a turn that advertises WebSearch still stream. |
| `src/claude/tool-names.ts` | Normalizes Claude tool names into Copilot-compatible names and maps them back. |
| `src/copilot/client.ts` | Low-level Copilot HTTP client: required headers, bearer tokens, timing logs, transient 5xx retries. |
| `src/copilot/chat.ts` | Internal chat abstraction used by routes and startup preflight. Applies model routing and think effort. |
| `src/copilot/responses.ts` | Translates between the Copilot Responses API and chat-completion-like results. |
| `src/lib/app-config.ts` | Loads and writes `~/.copilot-relay/config.yaml`. Hot-reloads while running. |
| `src/lib/models.ts` | Config-driven model routing and `thinkEffort` validation. |
| `src/lib/auth.ts` | GitHub device login, token storage, Copilot bearer refresh before expiry. |
| `src/lib/preflight.ts` | Runs at startup before binding: verifies configured models exist and the configured effort is usable. |

## Startup flow

```text
start command
  |
  | read ~/.copilot-relay/config.yaml
  | create config from config.default.yaml if missing
  v
apply runtime config
  |
  | load/sync github_token
  | load/refresh copilot_token.json
  v
preflight upstream models and think effort
  |
  | optionally write Claude Code settings
  v
start HTTP server
  |
  | watch config.yaml for hot reload
  v
serve Claude Code requests
```

Preflight runs *before* the socket binds. A relay that cannot reach its
configured models fails to start rather than accepting traffic it cannot serve.

## Runtime files

```text
~/.copilot-relay/
  config.yaml
  github_token
  copilot_token.json
  copilot-relay.pid
  logs/
    copilot-relay.2026-07-31.log   <- active, local date
    copilot-relay.2026-07-30.log
    copilot-relay.2026-07-29.log
```

`github_token` is the long-lived login/refresh source. `copilot_token.json`
caches the short-lived Copilot bearer token with its refresh metadata.

`copilot-relay.pid` holds `{host, pid, port, startedAt, version}`, written by the
daemon at startup — so `version` is the build actually serving. It is the second
of the two daemon-version sources: `/healthz` is preferred because a live process
cannot report a stale answer, and the pid file covers the window where the daemon
is up but not yet healthy. Both absent means a daemon older than v0.3.1, reported
as `unknown` rather than silently filled in with the CLI's own version (#43).

## Configuration model

The project follows a configuration-first rule: if behavior is likely to vary per
user, it goes in `config.yaml` rather than being hardcoded.

```yaml
host: 127.0.0.1
port: 4142
copilotBaseUrl: https://api.githubcopilot.com
claudeSetup: true
logLevel: info
logRetentionDays: 3
thinkEffort: max
upstreamTimeoutSeconds: 180
webSearchBackend:
gptModel: gpt-5.6-sol
opusModel: claude-opus-5
```

`host`, `port`, and `claudeSetup` are read once at startup. The other eight
hot-reload, applying to work that starts after the change. Empty
`webSearchBackend` uses `gptModel`. `upstreamTimeoutSeconds` caps the total
upstream wait budget for a single Claude request.

`readAppConfig()` writes the resolved config back to disk, so an existing install
has every key materialized and a `?? defaultConfig.x` fallback is never consulted
again. A shipped default therefore reaches fresh installs only. That is
deliberate: copilot-relay does not rewrite a value your config already holds, so
a deliberate pin survives every upgrade.

Per-key meaning, validation rules, and the hot-reload/restart split live in
[Configuration](EN-Configuration.md).

## Logging

Logs go to both the console and
`~/.copilot-relay/logs/copilot-relay.<local-date>.log`. The active file is
resolved per write, so it rotates at local midnight without a timer, and
retention deletes files older than `logRetentionDays` local calendar days.

Each entry is one physical line with bounded payload rendering. Both properties
are load-bearing rather than cosmetic; the reasoning is in
[Internals](EN-Internals.md), and the operational recipes are in
[Logs and troubleshooting](EN-Logging-Troubleshooting.md).

At `debug`, every model request logs client, requested model, upstream model,
requested think effort, requested thinking budget, and effective think effort.
Also at `debug`, Claude and upstream request diagnostics are logged without
redaction — which is why debug logs are not safe to share unreviewed.

## Testing strategy

Unit tests cover pure routing behavior, config validation, and protocol
translation edge cases that should not require a mocked upstream.

Integration tests run the Hono app against a local mocked Copilot upstream. CI
must never call real GitHub Copilot services.

Commands, the CI matrix, and the release gate are in
[Development](EN-Development.md).
