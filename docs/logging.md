# Logging

`copilot-relay` writes logs to both the console and a file:

```text
~/.copilot-relay/logs/copilot-relay.log
```

Log files are cleaned according to `logRetentionDays` in `~/.copilot-relay/config.yaml`. The default is 3 days.

## Log levels

| Level | Logs |
| --- | --- |
| `error` | Startup, preflight, request, token refresh, and upstream failures |
| `info` | Errors plus startup status, preflight status, request IDs, upstream lifecycle, and local HTTP status codes |
| `debug` | Info plus model routing summaries, Copilot upstream timings, and request payloads |

Use `debug` only for local debugging. It can log prompts and tool payloads.
File logs follow the same `logLevel` filter as console logs.
Any other `logLevel` value is invalid and stops startup.

## Inspecting logs

Use the file log for local diagnosis:

```sh
tail -f ~/.copilot-relay/logs/copilot-relay.log
```

Useful searches:

```sh
grep -n "Startup preflight failed" ~/.copilot-relay/logs/copilot-relay.log
grep -n "Failed to create" ~/.copilot-relay/logs/copilot-relay.log
grep -n "request_id=" ~/.copilot-relay/logs/copilot-relay.log
grep -n "Model request" ~/.copilot-relay/logs/copilot-relay.log
grep -n "Copilot POST" ~/.copilot-relay/logs/copilot-relay.log
grep -n "Failed to refresh Copilot token" ~/.copilot-relay/logs/copilot-relay.log
```

Start with `info`. Temporarily set `logLevel: debug` only when you need model
routing, upstream timings, or request payloads.

## File log line format

Every file log line has this shape:

```text
<iso_timestamp> <level> <message...>
```

Example:

```text
2026-06-06T04:00:00.000Z info request_id=3b241101-e2bb-4255-8caf-4136c566a962 POST /v1/messages -> 200 1234ms
```

## Startup logs

At `info`, startup logs confirm the active config and startup preflight:

```text
info Log level: info
info Think effort: xhigh
info Exposed models: gpt-5.5, claude-opus-4.8
info Running upstream preflight
info Upstream models available: gpt-5.5, claude-opus-4.8
info Preflight OK: model=gpt-5.5 think_effort=xhigh
info Preflight OK: model=claude-opus-4.8 think_effort=xhigh
info copilot-relay listening on http://127.0.0.1:4142
```

If startup fails, check the last `Startup preflight failed` or token refresh error.

## HTTP request logs

Every local HTTP request gets a GUID `request_id` and logs when it is received:

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 request received method=POST path=/v1/messages
```

The same `request_id` appears on the final local status summary:

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 POST /v1/messages -> 200 1234ms
```

For streaming requests, the local HTTP response opens immediately and the relay
also logs end-to-end stream duration:

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 stream completed 1234ms
```

Fields:

- method
- path
- response status
- elapsed milliseconds
- request ID

For non-2xx responses, the same line includes a short error message when one is
available:

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 POST /v1/messages -> 400 123ms error="Invalid request"
```

## Model routing logs

At `debug`, every model request logs:

```text
debug Model request client=claude requested_model=opus upstream_model=claude-opus-4.8 requested_think_effort=high requested_thinking=type:enabled,budget:2048 effective_think_effort=xhigh
```

Fields:

- `client`: `claude` for Claude Code traffic, `generic` for internal startup preflight
- `requested_model`: model name sent by Claude Code
- `upstream_model`: actual Copilot model used
- `requested_think_effort`: `reasoning_effort` sent by Claude Code, or `none`
- `requested_thinking`: Claude Code `thinking` config, including budget when present
- `effective_think_effort`: value sent upstream after config/routing

Use this log line first when debugging "why did my request use this model/effort?"

## Upstream Copilot logs

At `info`, every Copilot upstream call made for a local request logs send and return lifecycle lines:

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 send upstream method=POST path=/responses attempt=1 upstream_request_id=5a0f91b1-e0d3-4fd3-81a3-116238688754
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 return from upstream method=POST path=/responses status=200 ms=9200 attempt=1 upstream_request_id=5a0f91b1-e0d3-4fd3-81a3-116238688754
```

Fields:

- upstream method
- upstream path
- upstream response status
- elapsed milliseconds
- retry attempt
- local `request_id`
- per-upstream-call `upstream_request_id`

At `debug`, the compact upstream timing summary is also emitted:

```text
debug request_id=3b241101-e2bb-4255-8caf-4136c566a962 Copilot POST /responses -> 200 9200ms (attempt 1) upstream_request_id=5a0f91b1-e0d3-4fd3-81a3-116238688754
```

If a transient 5xx happens, retries are logged at `error` with retry context.

When Copilot returns a non-2xx response, `info` keeps a short status summary:

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 POST /v1/messages -> 400 123ms error="Invalid request"
```

The `error` entry in the same log file keeps the full upstream context:

```text
error Failed to create responses: route=/responses model=gpt-5.5 status=400 { request: ..., response: { status: 400, headers: ..., body: ... } }
```

## Request payload logs

At `debug`, request payload diagnostics are logged for local debugging:

```text
debug Full Claude request payload { payload: ... }
debug Full request payload { payload: ... }
```

Use this only when you need to debug exact request shape. Do not share debug logs publicly without reviewing them.

## Token logs

Token values are never printed. Token lifecycle logs include paths and scheduling only:

```text
info Using cached GitHub token at ~/.copilot-relay/github_token
info Using cached Copilot token at ~/.copilot-relay/copilot_token.json
info Next Copilot token refresh in 1430s
info Refreshed Copilot token
error Failed to refresh Copilot token: ...
```

If requests suddenly fail with auth errors:

1. Check whether `github_token` exists.
2. Check whether `copilot_token.json` exists.
3. Check for `Failed to refresh Copilot token`.
4. Run `copilot-relay auth` to refresh the GitHub login token.

## Config reload logs

When `~/.copilot-relay/config.yaml` changes:

```text
info Config reloaded: logLevel=debug thinkEffort=xhigh upstreamTimeoutSeconds=180
```

Hot reload updates:

- `logLevel`
- `thinkEffort`
- `upstreamTimeoutSeconds`
- `copilotBaseUrl`
- `webSearchBackend`
- `gptModel`
- `opusModel`

Changing `host` or `port` requires restarting because the server socket is already bound.

## Common debugging flows

### Wrong model used

Search for:

```text
Model request
```

Check `requested_model` and `upstream_model`.

### Wrong think effort used

Search for:

```text
effective_think_effort
```

Compare it with `requested_think_effort` and `thinkEffort` in config.

### Startup fails

Search for:

```text
Startup preflight failed
Preflight failed
Required Copilot model
```

### Slow response

At `debug`, compare local HTTP timing with upstream Copilot timing:

```text
POST /v1/messages -> ...
Copilot POST /chat/completions -> ...
Copilot POST /responses -> ...
```
