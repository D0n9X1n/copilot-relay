# Logging

`copilot-relay` writes logs to both the console and a file:

```text
~/.copilot-relay/logs/copilot-relay.log
```

Log files are cleaned according to `logRetentionDays` in `~/.copilot-relay/config.yaml`. The default is 3 days.

## Log levels

| Level | Logs |
| --- | --- |
| `silent` | Nothing |
| `error` | Startup, preflight, request, token refresh, and upstream failures |
| `warn` | Errors plus recoverable warnings |
| `info` | Warnings plus startup status, preflight status, HTTP requests, and model routing summaries |
| `debug` | Info plus Copilot upstream timings, token refresh scheduling, and upstream error request summaries |
| `trace` | Debug plus full Claude request payloads and full upstream Copilot request payloads without redaction |

Use `trace` only for local debugging. It can log full prompts and tool payloads.

## File log line format

Every file log line has this shape:

```text
<iso_timestamp> <level> <message...>
```

Example:

```text
2026-06-06T04:00:00.000Z info Model request client=claude requested_model=opus upstream_model=claude-opus-4.8 requested_think_effort=high requested_thinking=type:enabled,budget:2048 effective_think_effort=xhigh
```

## Startup logs

Startup logs confirm the active config and startup preflight:

```text
info Log level: info
info Think effort: xhigh
info Exposed models: gpt-5.5, claude-opus-4.8
info Running upstream preflight
info Upstream models available: gpt-5.5, claude-opus-4.8
info Preflight OK: model=gpt-5.5 think_effort=xhigh
info Preflight OK: model=claude-opus-4.8 think_effort=xhigh
success copilot-relay listening on http://127.0.0.1:4142
```

If startup fails, check the last `Startup preflight failed` or token refresh error.

## HTTP request logs

Every local HTTP request logs:

```text
info POST /v1/messages -> 200 1234ms
```

Fields:

- method
- path
- response status
- elapsed milliseconds

## Model routing logs

Every model request logs:

```text
info Model request client=claude requested_model=opus upstream_model=claude-opus-4.8 requested_think_effort=high requested_thinking=type:enabled,budget:2048 effective_think_effort=xhigh
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

At `debug`, every Copilot upstream call logs:

```text
debug Copilot POST /chat/completions -> 200 850ms (attempt 1)
debug Copilot POST /responses -> 200 9200ms (attempt 1)
```

Fields:

- upstream method
- upstream path
- upstream response status
- elapsed milliseconds
- retry attempt

If a transient 5xx happens, retries are logged as warnings.

## Full payload logs

At `trace`, full request payloads are logged without redaction:

```text
trace Full Claude request payload { payload: ... }
trace Full request payload { payload: ... }
```

Use this only when you need to debug exact request shape. Do not share trace logs publicly without reviewing them.

## Token logs

Token values are never printed. Token lifecycle logs include paths and scheduling only:

```text
debug Using cached GitHub token at ~/.copilot-relay/github_token
debug Using cached Copilot token at ~/.copilot-relay/copilot_token.json
debug Next Copilot token refresh in 1430s
debug Refreshed Copilot token
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
info Config reloaded: logLevel=debug thinkEffort=xhigh
```

Hot reload updates:

- `logLevel`
- `thinkEffort`
- `copilotBaseUrl`
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
