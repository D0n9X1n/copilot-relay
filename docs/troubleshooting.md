# Troubleshooting

Use this page when `copilot-relay` starts but Claude Code requests fail, route
to the wrong model, or feel slow.

## First checks

1. Confirm the relay is listening:

   ```sh
   curl -sS http://127.0.0.1:4142/healthz
   curl -sS http://127.0.0.1:4142/v1/models
   ```

2. Follow the log:

   ```sh
   tail -f ~/.copilot-relay/logs/copilot-relay.$(date +%F).log
   ```

3. Check config:

   ```sh
   cat ~/.copilot-relay/config.yaml
   ```

Only `error`, `info`, and `debug` are valid `logLevel` values. Any other value
is a configuration error and stops startup.

## Startup fails

Search for:

```sh
grep -n "Startup preflight failed\\|Preflight failed\\|Required Copilot model" ~/.copilot-relay/logs/copilot-relay.*.log
```

Common causes:

- `github_token` is missing or stale.
- Copilot cannot mint a bearer token from the cached GitHub token.
- `gptModel` or `opusModel` is not present in upstream `/models`.
- `thinkEffort` is rejected by the configured model.

Run:

```sh
copilot-relay auth
copilot-relay start
```

## A new version does not seem to have taken effect

Symptom: a fix shipped in a release you installed, but the behavior is
unchanged.

Check which build is actually serving:

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
the process already running, so the two disagree until it restarts.

```sh
copilot-relay restart
```

Under a service manager, restart through it rather than through the CLI. On
macOS with `KeepAlive`, launchd can relaunch the job out from under
`copilot-relay restart`, so the restart silently does not take — use
`launchctl kickstart -k "gui/$(id -u)/com.d0n9x1n.copilot-relay"` and re-check
`status`.

`version unknown` means the daemon predates v0.3.1 and does not report its
version at all; restarting it makes the row meaningful. A mismatch never changes
the exit code — the relay works, it is simply not the build you installed.

## Request returns 400 or 500

At `info`, local failures look like:

```text
info POST /v1/messages -> 400 123ms error="Invalid request"
```

The matching `error` line contains full upstream context in the same log file,
including route, model, request payload, response status, response headers, and
response body.

Search for:

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

Then search:

```sh
grep -n "Model request" ~/.copilot-relay/logs/copilot-relay.*.log
```

Check:

- `requested_model`: what Claude Code sent
- `upstream_model`: what copilot-relay sent to Copilot
- `effective_think_effort`: the configured effort sent upstream

Routing is intentionally simple: requests containing `opus` use `opusModel`;
everything else uses `gptModel`.

## Wrong think effort used

Search at `debug`:

```sh
grep -n "effective_think_effort" ~/.copilot-relay/logs/copilot-relay.*.log
```

`thinkEffort` in `~/.copilot-relay/config.yaml` wins over client-provided
reasoning effort so startup preflight and real traffic exercise the same
upstream behavior.

## WebSearch fails or returns no results

Claude WebSearch is executed by the relay through Copilot `/responses` with
`web_search_preview`. If search returns an error result, check:

```sh
grep -n "web_search_preview\\|Failed to create responses\\|Copilot web search" ~/.copilot-relay/logs/copilot-relay.*.log
```

By default, WebSearch uses `gptModel`. To use a different Copilot Responses model,
set:

```yaml
webSearchBackend: gpt-5.5
```

## Slow responses

Each Claude request has a configurable upstream timeout. The default is:

```yaml
upstreamTimeoutSeconds: 180
```

If a request fails with `499`, the client disconnected first. For example:

```text
info request_id=... POST /v1/messages -> 499 60004ms error="Client request cancelled before Copilot upstream completed."
```

That is different from the relay's upstream timeout, which returns `504` with
`upstream_timeout`. A `499` at about 60 seconds means the caller closed the local
HTTP request before the 180 second upstream timeout could fire.

At `info`, check local request latency:

```text
info request_id=... POST /v1/messages -> 200 8291ms
```

For streaming requests, the relay opens the local SSE response immediately while
waiting for upstream response headers. Use the `stream completed` line for
end-to-end stream duration:

```text
info request_id=... stream completed 8291ms
```

At `info`, compare that with upstream latency:

```text
info request_id=... return from upstream method=POST path=/chat/completions status=200 ms=8287 attempt=1 upstream_request_id=...
```

If local and upstream timings are close, the delay is upstream/model latency. If
local is much larger, inspect stream translation or client-side behavior.

## Claude Code settings are wrong

`copilot-relay start` can update `~/.claude/settings.json` when
`claudeSetup: true`.

Check:

```sh
cat ~/.claude/settings.json
```

Expected values:

- `ANTHROPIC_BASE_URL` points at `http://127.0.0.1:4142`
- `ANTHROPIC_AUTH_TOKEN` exists; it is a dummy value for local relay use

Changing `host` or `port` requires restarting the relay because the listening
socket cannot move during hot reload.

## Token cache problems

Runtime files:

```text
~/.copilot-relay/github_token
~/.copilot-relay/copilot_token.json
```

`github_token` is the long-lived login source. `copilot_token.json` is a
short-lived bearer token cache refreshed before expiry.

Search for:

```sh
grep -n "Failed to refresh Copilot token\\|Using cached Copilot token\\|Next Copilot token refresh" ~/.copilot-relay/logs/copilot-relay.*.log
```

If refresh fails repeatedly, rerun:

```sh
copilot-relay auth
```

## Safe log sharing

Do not share full `debug` logs publicly without review. Debug logs can include
prompts and tool payloads. For bug reports, include:

- exact timestamp
- `info` request summary
- related `error` entry if present
- whether `logLevel: debug` was enabled
- relevant config with private endpoints removed
