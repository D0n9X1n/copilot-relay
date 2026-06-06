# Architecture

`copilot-relay` is just another relay for Claude Code to use a GitHub Copilot subscription. It exposes Claude-compatible endpoints locally and translates those requests into GitHub Copilot upstream calls.

## Request flow

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

## Public API

Only Claude Code-facing endpoints are public:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /healthz`

The proxy calls Copilot `/chat/completions` and `/responses` internally, but it does not expose public OpenAI-compatible routes.

## Main modules

### `src/server.ts`

Creates the Hono server, attaches request logging, registers Claude routes, and exposes health/root endpoints.

### `src/routes/claude.ts`

Owns the local Claude Code API surface. It parses Claude requests, logs requested/effective model routing, calls the Claude translator, handles streaming/non-streaming responses, and implements `count_tokens`.

### `src/claude/types.ts`

Defines only the subset of Claude Messages API types that the proxy needs. This is intentionally not a full Claude SDK.

### `src/claude/translate.ts`

Translates non-streaming payloads:

- Claude request -> Copilot chat request
- Copilot response -> Claude response

It also maps tool calls and thinking/text blocks between protocol shapes.

### `src/claude/stream.ts`

Converts streaming Copilot chat chunks into Claude SSE events. It keeps state because Claude requires explicit content block start/delta/stop events.

### `src/claude/tool-names.ts`

Normalizes Claude tool names into Copilot-compatible names and maps them back in responses.

### `src/copilot/client.ts`

Low-level Copilot HTTP client. It adds required GitHub Copilot headers, sends bearer tokens, logs timing, and retries transient 5xx failures.

### `src/copilot/chat.ts`

Internal chat abstraction used by routes and startup preflight. It applies model routing, think effort, request logging, and chooses Copilot `/responses` for configured GPT-style models when needed.

### `src/copilot/responses.ts`

Internal translation between Copilot Responses API and chat-completion-like results. This exists because `gpt-5.5` uses Copilot `/responses` upstream.

### `src/lib/app-config.ts`

Loads and writes `~/.copilot-relay/config.yaml`. The file is hot-reloaded while the proxy is running. Missing user config is created from `config.default.yaml`.

### `src/lib/models.ts`

Config-driven model routing:

- requested model containing `opus` -> `opusModel`
- all other requested models -> `gptModel`

It also validates the allowed `thinkEffort` values.

### `src/lib/auth.ts`

Handles GitHub device login, stores `github_token`, stores `copilot_token.json`, and refreshes Copilot bearer tokens before expiry.

### `src/lib/preflight.ts`

Runs at startup before binding the server. It verifies configured upstream models exist and that configured `thinkEffort` can be used.

## Runtime files

```text
~/.copilot-relay/
  config.yaml
  github_token
  copilot_token.json
  logs/
    copilot-relay.log
```

## Configuration model

The project follows a configuration-first rule: if behavior is likely to vary per user, put it in `config.yaml` rather than hardcoding it.

Current config keys:

```yaml
host: 127.0.0.1
port: 4142
copilotBaseUrl: https://api.githubcopilot.com
claudeSetup: true
logLevel: info
logRetentionDays: 3
thinkEffort: xhigh
gptModel: gpt-5.5
opusModel: claude-opus-4.8
```

`host` and `port` require restart to affect the listening socket. Other values are hot-reloaded.

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

## Logging

Logs go to both console and `~/.copilot-relay/logs/copilot-relay.log`.
Operational debugging workflows live in [`logging.md`](logging.md) and
[`troubleshooting.md`](troubleshooting.md).

At `debug`, every model request logs:

- client
- requested model
- upstream model
- requested think effort
- requested thinking budget
- effective think effort

At `debug`, the proxy logs Claude and upstream request diagnostics without redaction.

## Testing strategy

Unit tests cover pure routing behavior, config validation, and protocol
translation edge cases that should not require a mocked upstream.

Integration tests run the Hono app against a local mocked Copilot upstream. CI must never call real GitHub Copilot services.
