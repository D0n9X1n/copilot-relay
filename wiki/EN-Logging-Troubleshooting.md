# Logs and troubleshooting

Use this page when `copilot-relay` starts but Claude Code requests fail, route to
the wrong model, or feel slow — and as the reference for what every log line
means.

For what each config key does see [Configuration](EN-Configuration.md). For why
the log format is the way it is see [Internals](EN-Internals.md).

## First checks

1. Confirm the relay is listening:

   ```sh
   curl -sS http://127.0.0.1:4142/healthz
   curl -sS http://127.0.0.1:4142/v1/models
   ```

2. Follow today's log:

   ```sh
   tail -f ~/.copilot-relay/logs/copilot-relay.$(date +%F).log
   ```

3. Check config:

   ```sh
   cat ~/.copilot-relay/config.yaml
   ```

A `200` from `/healthz` or `/v1/models` proves the relay is **listening**, not
that it can serve a request. Neither contacts Copilot, so a relay whose token
expired an hour ago passes both. The check that actually proves it works is:

```sh
copilot-relay status --deep
```

`--deep` sends a real request through Copilot. It is opt-in because it spends a
few tokens. Exit codes: `0` running and reachable, `1` not running, `2` running
but not usable.

## The log file

The active file carries the **local** calendar date and rotates at local
midnight:

```text
~/.copilot-relay/logs/copilot-relay.2026-07-31.log
```

The path is resolved per write, so a relay running across midnight starts the
next day's file on its own — there is no rotation timer to drift. Local rather
than UTC on purpose: `logRetentionDays` is a human-facing "how many days do I
keep" setting, and a UTC stamp would roll the file over in the middle of the
local afternoon for anyone west of Greenwich.

### Retention

Files are deleted according to `logRetentionDays` in
`~/.copilot-relay/config.yaml`. The default is `3`.

Retention counts **local calendar days including today**, so `3` keeps today,
yesterday, and the day before. Eligibility is decided by the date in the
filename, falling back to mtime for files that carry no stamp. The filename is
preferred because mtime is rewritten by backups, `cp`, and editors touching a
file, any of which would silently extend or shorten the window.

If you upgraded from before v0.2.3, an undated `copilot-relay.log` may still be
present. It is the old single log file; it carries no filename date, so it ages
out by mtime once the relay stops appending to it. Nothing writes to it any more
and no manual cleanup is needed.

Rotation is what makes retention work at all. Before it existed, every append
refreshed the one log file's mtime, so it never aged past the cutoff and nothing
was ever deleted; one observed install reached 9.3 GB with `logRetentionDays: 3`
configured the whole time.

### One entry, one line

Every log entry — including error entries carrying full request/response
context — is written as a single physical line, with object payloads rendered at
bounded depth and no pretty-printing.

This matters for searching as much as for size. Multi-line object dumps
previously made the `grep` recipes below return the first fragment of a payload
rather than the matching entry, and accounted for roughly two thirds of log
volume by bytes.

Payloads are bounded at depth 6, 100 array elements, and 4000 characters per
string. A value past those limits is truncated in the log, not dropped.

### Line format

```text
<iso_timestamp> <level> <message...>
```

```text
2026-06-06T04:00:00.000Z info request_id=3b241101-e2bb-4255-8caf-4136c566a962 POST /v1/messages -> 200 1234ms
```

## Log levels

Only three levels are valid:

| Level | Logs |
| --- | --- |
| `error` | Startup, preflight, request, token refresh, and upstream failures. |
| `info` | Errors plus startup status, preflight status, request IDs, upstream lifecycle, and local HTTP status codes. |
| `debug` | Info plus model routing summaries, Copilot upstream timings, and request payloads. |

Invalid values such as `warn`, `trace`, or `silent` stop startup. File logs
follow the same `logLevel` filter as console logs.

Start with `info`. Set `logLevel: debug` only while you need model routing,
upstream timings, or request payloads — it can log prompts and tool payloads.

## Useful searches

The glob spans every retained day:

```sh
grep -n "Startup preflight failed" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Failed to create" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "request_id=" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Model request" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Copilot POST" ~/.copilot-relay/logs/copilot-relay.*.log
grep -n "Failed to refresh Copilot token" ~/.copilot-relay/logs/copilot-relay.*.log
```

To follow one request end to end across a day boundary:

```sh
grep -h "request_id=<id>" ~/.copilot-relay/logs/copilot-relay.*.log | sort
```

## What the entries look like

### Startup

At `info`, startup logs confirm the active config and preflight:

```text
info Log level: info
info Think effort: xhigh
info Exposed models: gpt-5.6-sol[1m], claude-opus-5
info Running upstream preflight
info Upstream models available: gpt-5.6-sol, claude-opus-5
info Preflight OK: model=gpt-5.6-sol think_effort=xhigh
info Preflight OK: model=claude-opus-5 think_effort=xhigh
info copilot-relay listening on http://127.0.0.1:4142
```

### HTTP requests

Every local HTTP request gets a GUID `request_id`, logged on receipt:

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 request received method=POST path=/v1/messages
```

The same `request_id` appears on the final status summary:

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 POST /v1/messages -> 200 1234ms
```

Fields: method, path, response status, elapsed milliseconds, request ID.

For streaming requests the local HTTP response opens immediately, so the relay
also logs end-to-end stream duration:

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 stream completed 1234ms
```

For non-2xx responses the same line includes a short error message when one is
available:

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 POST /v1/messages -> 400 123ms error="Invalid request"
```

### Model routing

At `debug`:

```text
debug Model request client=claude requested_model=opus upstream_model=claude-opus-5 requested_think_effort=high requested_thinking=type:enabled,budget:2048 effective_think_effort=xhigh
```

| Field | Meaning |
| --- | --- |
| `client` | `claude` for Claude Code traffic, `generic` for internal startup preflight |
| `requested_model` | model name sent by Claude Code |
| `upstream_model` | actual Copilot model used |
| `requested_think_effort` | `reasoning_effort` sent by Claude Code, or `none` |
| `requested_thinking` | Claude Code `thinking` config, including budget when present |
| `effective_think_effort` | value sent upstream after config/routing |

Use this line first when debugging "why did my request use this model/effort?"

### Upstream Copilot calls

At `info`, every upstream call logs send and return lifecycle lines:

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 send upstream method=POST path=/responses attempt=1 upstream_request_id=5a0f91b1-e0d3-4fd3-81a3-116238688754
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 return from upstream method=POST path=/responses status=200 ms=9200 attempt=1 upstream_request_id=5a0f91b1-e0d3-4fd3-81a3-116238688754
```

Fields: upstream method, upstream path, upstream response status, elapsed
milliseconds, retry attempt, local `request_id`, and a per-call
`upstream_request_id`.

At `debug`, a compact timing summary is also emitted:

```text
debug request_id=3b241101-e2bb-4255-8caf-4136c566a962 Copilot POST /responses -> 200 9200ms (attempt 1) upstream_request_id=5a0f91b1-e0d3-4fd3-81a3-116238688754
```

Transient 5xx retries are logged at `error` with retry context. When Copilot
returns a non-2xx, the `error` entry keeps the full upstream context on one line:

```text
error Failed to create responses: route=/responses model=gpt-5.6-sol status=400 { request: { ... }, response: { status: 400, headers: { ... }, body: { ... } } }
```

### Request payloads

At `debug` only:

```text
debug Full Claude request payload { payload: ... }
debug Full request payload { payload: ... }
```

Use this only when you need the exact request shape.

### Tokens

Token values are never printed. Lifecycle logs carry paths and scheduling only:

```text
info Using cached GitHub token at ~/.copilot-relay/github_token
info Using cached Copilot token at ~/.copilot-relay/copilot_token.json
info Next Copilot token refresh in 1430s
info Refreshed Copilot token
error Failed to refresh Copilot token: ...
```

### Config reload

```text
info Config reloaded: logLevel=debug thinkEffort=xhigh upstreamTimeoutSeconds=180
```

Hot reload updates `logLevel`, `logRetentionDays`, `thinkEffort`,
`upstreamTimeoutSeconds`, `copilotBaseUrl`, `webSearchBackend`, `gptModel`, and
`opusModel`. Changing `host`, `port`, or `claudeSetup` requires a restart.

## Startup failed

```sh
grep -n "Startup preflight failed\|Preflight failed\|Required Copilot model\|Invalid logLevel" ~/.copilot-relay/logs/copilot-relay.*.log
```

Common causes:

- `github_token` is missing or stale
- Copilot cannot mint a bearer token from the cached GitHub token
- configured `gptModel` or `opusModel` is not present in upstream `/models`
- invalid `logLevel`
- `thinkEffort` is rejected by the configured model

Fix auth and retry:

```sh
copilot-relay auth
copilot-relay start
```

## A new version did not take effect

A fix shipped in a release you installed, but nothing changed. Check which build
is actually serving:

```sh
copilot-relay status
```

```text
copilot-relay 0.3.0
  process    running (pid 30516, up 1h 58m)
  version    0.2.6 — MISMATCH, 0.3.0 is installed
```

The first line is the CLI you invoked; `version` is what the running daemon
reports about itself. `npm i -g` replaces the binary on disk and does not touch
the process already running, so the two disagree until it restarts:

```sh
copilot-relay restart
```

Under a service manager, restart through it rather than through the CLI. On macOS
with `KeepAlive`, launchd can relaunch the job out from under
`copilot-relay restart`, so the restart silently does not take — use:

```sh
launchctl kickstart -k "gui/$(id -u)/com.d0n9x1n.copilot-relay"
```

and re-check `status`. See the [macOS](EN-macOS-LaunchAgent.md),
[Linux](EN-Linux-systemd.md), or [Windows](EN-Windows-Service.md) page.

`version unknown` means the daemon predates v0.3.1 and does not report its
version at all; restarting it makes the row meaningful. A mismatch never changes
the exit code — the relay works, it is simply not the build you installed.

## Request returns 400 or 500

At `info`, local failures look like:

```text
info POST /v1/messages -> 400 123ms error="Invalid request"
```

The matching `error` line contains full upstream context in the same log file:
route, model, request payload, response status, response headers, and response
body.

```sh
grep -n "Failed to create" ~/.copilot-relay/logs/copilot-relay.*.log
```

If the response body mentions request shape, check the surrounding `request`
object in the `error` entry. If it mentions auth or model access, rerun
`copilot-relay auth` and re-check `/v1/models`.

## Wrong model used

Temporarily set:

```yaml
logLevel: debug
```

Then:

```sh
grep -n "Model request" ~/.copilot-relay/logs/copilot-relay.*.log
```

Check `requested_model` (what Claude Code sent) against `upstream_model` (what
copilot-relay sent to Copilot). Routing is intentionally simple: requests
containing `opus` use `opusModel`; everything else uses `gptModel`.

## Wrong think effort used

```sh
grep -n "effective_think_effort" ~/.copilot-relay/logs/copilot-relay.*.log
```

Compare `effective_think_effort` with `requested_think_effort` and with
`thinkEffort` in config. `thinkEffort` in `~/.copilot-relay/config.yaml` wins
over client-provided reasoning effort, so startup preflight and real traffic
exercise the same upstream behavior.

## WebSearch fails or returns no results

Claude WebSearch is executed by the relay through Copilot `/responses` with
`web_search_preview`. If search returns an error result:

```sh
grep -n "web_search_preview\|Failed to create responses\|Copilot web search" ~/.copilot-relay/logs/copilot-relay.*.log
```

By default WebSearch uses `gptModel`. To use a different Copilot Responses model:

```yaml
webSearchBackend: gpt-5.5
```

## Slow responses

Each Claude request has a configurable upstream timeout:

```yaml
upstreamTimeoutSeconds: 180
```

### 499 vs 504

These mean different things and are easy to confuse:

| Status | Meaning |
| --- | --- |
| `499` | The **client** disconnected before Copilot finished. |
| `504` | The relay's own upstream timeout fired, reported as `upstream_timeout`. |

```text
info request_id=... POST /v1/messages -> 499 60004ms error="Client request cancelled before Copilot upstream completed."
```

A `499` at about 60 seconds means the caller closed the local HTTP request long
before the 180 second upstream timeout could fire — so raising
`upstreamTimeoutSeconds` would change nothing.

### Comparing local and upstream latency

At `info`, local request latency:

```text
info request_id=... POST /v1/messages -> 200 8291ms
```

For streaming requests the relay opens the local SSE response immediately while
waiting for upstream headers, so use the `stream completed` line for end-to-end
duration:

```text
info request_id=... stream completed 8291ms
```

Compare with upstream latency at `info`:

```text
info request_id=... return from upstream method=POST path=/chat/completions status=200 ms=8287 attempt=1 upstream_request_id=...
```

Or the compact `debug` summary:

```text
debug Copilot POST /chat/completions -> 200 8287ms (attempt 1)
```

If local and upstream timings are close, the delay is upstream/model latency. If
local is much larger, inspect stream translation or client-side behavior.

## Token cache problems

```text
~/.copilot-relay/github_token
~/.copilot-relay/copilot_token.json
```

`github_token` is the long-lived login source. `copilot_token.json` is a
short-lived bearer token cache refreshed before expiry.

```sh
grep -n "Failed to refresh Copilot token\|Using cached Copilot token\|Next Copilot token refresh" ~/.copilot-relay/logs/copilot-relay.*.log
```

If requests suddenly fail with auth errors:

1. Check whether `github_token` exists.
2. Check whether `copilot_token.json` exists.
3. Check for `Failed to refresh Copilot token`.
4. Run `copilot-relay auth` to refresh the GitHub login token.

## Claude Code settings are wrong

`copilot-relay start` can update `~/.claude/settings.json` when
`claudeSetup: true`.

```sh
cat ~/.claude/settings.json
```

Expected values:

- `ANTHROPIC_BASE_URL` points at `http://127.0.0.1:4142`
- `ANTHROPIC_AUTH_TOKEN` exists; it is a dummy value for local relay use

Changing `host` or `port` requires restarting the relay, because the listening
socket cannot move during hot reload.

## Safe log sharing

Do not share full `debug` logs publicly without review — they can include prompts
and tool payloads.

Upstream URLs are redacted in logs: a `copilotBaseUrl` with a path, query string,
or fragment is written as `https://gateway.example[redacted]`, because a gateway
path can carry a token and the log file is the one thing users are asked to
attach to a bug report.

For bug reports, include:

- exact timestamp
- the `info` request summary
- the related `error` entry if present
- whether `logLevel: debug` was enabled
- relevant config with private endpoints removed
