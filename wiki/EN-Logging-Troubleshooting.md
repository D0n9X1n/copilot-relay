# Logs and troubleshooting

The active log file carries the local date and rotates at local midnight:

```text
~/.copilot-relay/logs/copilot-relay.2026-07-25.log
```

Files older than `logRetentionDays` (default 3) are deleted automatically.

Follow today's log:

```sh
tail -f ~/.copilot-relay/logs/copilot-relay.$(date +%F).log
```

Search every retained day with the glob:

```sh
grep -n "request_id=" ~/.copilot-relay/logs/copilot-relay.*.log
```

Every entry is a single line, including error entries carrying full
request/response context — so `grep` returns the whole entry rather than a
fragment of it.

If you upgraded from before v0.2.3, an undated `copilot-relay.log` may still be
present. It is the old single log file; it ages out on its own and nothing writes
to it any more.

## Log levels

Only three levels are valid:

| Level | Use |
| --- | --- |
| `error` | Startup failures, request failures, token refresh failures, upstream 400/500 details. |
| `info` | Startup status, preflight success, token lifecycle, local HTTP status summaries. |
| `debug` | Model routing, upstream timings, full request payload diagnostics. |

Invalid values such as `warn`, `trace`, or `silent` fail startup.

## Useful searches

```sh
grep -n "Startup preflight failed" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Failed to create" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Failed to refresh Copilot token" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Model request" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Copilot POST" ~/.copilot-relay/logs/copilot-relay.*.log
```

## Startup failed

Look for:

```text
Startup preflight failed
Preflight failed
Required Copilot model
Invalid logLevel
```

Common causes:

- stale `github_token`
- missing or expired `copilot_token.json`
- configured `gptModel` or `opusModel` not present upstream
- invalid `logLevel`
- invalid/rejected `thinkEffort`

Fix auth:

```sh
copilot-relay auth
copilot-relay start
```

## Request returned 400/500

At `info`, you see a short summary:

```text
info POST /v1/messages -> 400 123ms error="Invalid request"
```

The matching `error` line includes full context in the same log file:

- upstream route
- model
- request payload
- response status
- response headers
- response body

Search:

```sh
grep -n "Failed to create" ~/.copilot-relay/logs/copilot-relay.*.log
```

## Wrong model or effort

Set:

```yaml
logLevel: debug
```

Search:

```sh
grep -n "Model request" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "effective_think_effort" ~/.copilot-relay/logs/copilot-relay.*.log
```

Check:

- `requested_model`
- `upstream_model`
- `requested_think_effort`
- `effective_think_effort`

## Slow response

Compare local request time:

```text
info POST /v1/messages -> 200 8291ms
```

with upstream time at `debug`:

```text
debug Copilot POST /chat/completions -> 200 8287ms (attempt 1)
```

If the numbers are close, the delay is upstream/model latency.

## Token problems

Check:

```sh
grep -n "Using cached Copilot token\|Next Copilot token refresh\|Failed to refresh Copilot token" ~/.copilot-relay/logs/copilot-relay.*.log
```

If refresh repeatedly fails, run:

```sh
copilot-relay auth
```

## Safe sharing

Do not share full `debug` logs publicly without review. Debug logs can contain
prompts and tool payloads.

For bug reports, include:

- exact timestamp
- relevant `info` request summary
- matching `error` block if present
- whether `debug` was enabled
- sanitized `~/.copilot-relay/config.yaml`

