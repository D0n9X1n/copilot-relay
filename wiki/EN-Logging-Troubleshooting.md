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
few tokens. Exit codes: `0` running and reachable, `1` not running, `2` unusable
or status could not be established because config is invalid/unreadable.

The diagnostic keeps a 16-token output budget, shared by reasoning and visible
text. A successful assistant message with `stop_reason: max_tokens` and positive
`usage.output_tokens` proves the upstream round trip even if `content` is empty.
In that case text output and JSON `deep.detail` say `output budget exhausted before
visible text`; exit code `0` means reachability, not a completed answer. Empty
completed responses, missing exhaustion evidence, and HTTP errors still fail.
For a visible answer, send a manual request with a larger output budget rather
than re-authenticating solely because reasoning used the probe's budget.

## Triage an Opus API error

Start with the **failing turn's evidence**, not a guess that every API error is an
authentication problem. A refusal, bad request, transport interruption and relay
translation failure require different next steps.

1. Copy the short error, local time, model and effort. Relay-generated stream and
   internal errors include `(request_id=<uuid>)`; HTTP responses also carry
   `x-copilot-relay-request-id`. The relay generates this ID, ignoring client-supplied
   values. Correlate it with that request's local logs, not another session's failure.
2. For a fresh availability check of that exact model, run:

   ```sh
   copilot-relay models --deep --model claude-opus-5.5 --details
   ```

   This consumes real Copilot usage. It probes an isolated short request, not your
   running daemon or the historical long conversation. A PASS does not reproduce
   a long-context, streaming, tool or prompt-specific error. `status --deep` tests
   the daemon's configured GPT route instead; cheap health/models probes do not
   reach upstream at all.
3. Review `client_http`, `upstream_http`, actual `route`, response state and semantic
   `outcome` separately. HTTP 200 plus `content_filter`/`refusal` is a refusal, not
   success. A complete body/capture can still contain an error. `terminal=observed`
   only reports a terminal marker, not a successful answer. Unreported evidence
   remains `unknown`; it is not proof of a network or provider failure.
4. Use the generated local/upstream request IDs and known provider/message IDs to
   correlate attempts. A discarded failed attempt followed by success is different
   from a final failure. Refresh results are shown without token values.
5. If a complete debug capture exists, details show `capture=complete` and an
   **offline** `copilot-relay replay <request-id>` command. `capture=off` means debug
   was off; `capture=incomplete`, `pending` or `failed` means no complete recording
   is available. Replay never resends to Copilot. `MATCH` means the current handler
   reproduces the recorded behavior, including a refusal/error—not that the model
   is healthy or the provider's refusal reason is known. Older captures may give
   DIFF when a newer handler adds request-ID text to an error message.

For route skips, compare `planned_route`, `route_source`, `advertised_endpoints`
and `sent` in `--details`. These reflect the provider's `supported_endpoints`;
unknown endpoint strings are counted but never printed. An advertised
`/responses`-only model is no longer sent to `/chat/completions` merely because
its name is new. `SKIPPED` means no inference was sent, not that the account or
model is unavailable. A HTTP 400 after a sent request is a separate failure and
requires its own evidence. For `reasoning_effort: false` or an empty tier list,
`effort=omitted` is intentional; an explicit control instead returns
`relay_unsupported_effort`. Full selection rules live in
[Configuration](EN-Configuration.md).

| Observation | Next step |
| --- | --- |
| No advertised route / Unsupported route | Check known endpoint metadata and unknown-endpoint count; there is no compatible advertised adapter to test. |
| Protocol policy conflict | Review `claudeUpstreamApi`; do not change an existing signed/native conversation's route blindly. |
| 401 or token refresh failure | Check authentication; use `copilot-relay auth` before another probe. |
| 403 | Check account/model entitlement and gateway policy; do not assume token expiry. |
| 429 | Wait before another request; retries/probes consume usage. |
| Timeout or interrupted body | Check connectivity and the effective deadline; do not treat partial text as completion. |
| Invalid tool input / local validation | Inspect the exact route and request ID; retain a private capture for offline diagnosis. |
| Refusal or incomplete generation | Inspect stop/finish reason and output budget; do not bypass safety controls or silently switch APIs. |
| Unknown API error | Keep it unknown until correlated logs or a complete recording establish more. |

For long sessions, start with the **800K** auto-compact recommendation and its
headroom caveats in [Configuration](EN-Configuration.md); a context-limit failure
is only one possible cause, not a diagnosis of a generic API error. Use `NO_COLOR=1`
when copying console output. The colored `status` view keeps textual labels and
unchanged exit codes; `status --json` stays uncolored.

If the error repeats, use a short intentional debug window or a separate-port,
isolated diagnostic instance as described below. Do not restart an active relay
just to reproduce it, enable debug globally without considering concurrent
requests, or upload an entire capture. Raw prompts/tool results can contain
sensitive data; share only reviewed status/ID fields and structural replay results.

## The log file

The active file carries the **local** calendar date and rotates at local
midnight:

```text
~/.copilot-relay/logs/copilot-relay.2026-07-31.log
```

The path is resolved for each entry when it is logged, so a relay running across
midnight starts the next day's file on its own — there is no rotation timer to
drift. Local rather than UTC on purpose: `logRetentionDays` is a human-facing
"how many days do I keep" setting, and a UTC stamp would roll the file over in
the middle of the local afternoon for anyone west of Greenwich.

The relay keeps the active file open while it writes and closes it a second after
the last entry. If you move or delete the file while the relay runs, the next
entry creates a new file at the dated path; nothing more is written to the moved
file. On Windows, renaming or moving the logs folder fails with an access-denied
error while the file is open: wait a second after the last entry, or stop the
relay first.

### Retention

Normal relay logs and debug captures share `logRetentionDays` in
`~/.copilot-relay/config.yaml` (default `3`). It is a calendar retention window,
not a byte quota.

Retention counts **local calendar days including today**, so `3` keeps today,
yesterday, and the day before. Eligibility is decided by the date in the
filename, falling back to mtime for files that carry no stamp. The filename is
preferred because mtime is rewritten by backups, `cp`, and editors touching a
file, any of which would silently extend or shorten the window. Only the relay's
dated/legacy log filenames are swept; service-manager stderr files and unrelated
diagnostics are not owned by this cleanup.

Capture age comes from the enclosing local-date directory. Cleanup runs at startup,
on config reload and, throttled to hourly checks, when admitted POST requests
arrive; offline replay never triggers it. Active captures are protected, including
pending captures whose owner is live or cannot be established. Abandoned pending
captures are eligible only when the recorded owner is known to have exited.
Symlinks, unexpected files and unknown/changing records are retained, not recursively
removed. Thus some unsafe/unknown leftovers can outlive the window; inspect them
rather than treating retention as a guarantee that every directory is gone.
Graceful shutdown waits for capture/log writes after closing the server; a crash,
SIGKILL or disk failure can still leave an incomplete capture.

If you upgraded from before v0.2.3, an undated `copilot-relay.log` may still be
present. It is the old single log file; it carries no filename date, so it ages
out by mtime once the relay stops appending to it. Nothing writes to it any more
and no manual cleanup is needed.

Rotation is what makes retention work at all. Before it existed, every append
refreshed the one log file's mtime, so it never aged past the cutoff and nothing
was ever deleted; one observed install reached 9.3 GB with `logRetentionDays: 3`
configured the whole time.

### One entry, one line

Every normal log entry — including errors carrying request/response context —
is one physical line, with object payloads rendered at bounded depth and no
pretty-printing. Embedded line separators are escaped after URL redaction.

This matters for searching as much as for size. Multi-line object dumps
previously made the `grep` recipes below return the first fragment of a payload
rather than the matching entry, and accounted for roughly two thirds of log
volume by bytes.

Object inspection is bounded at depth 6, 100 array elements and 4000 characters
per contained string. Final rendered arguments are capped at 16 KiB and each file
entry at 64 KiB, with `[truncated]` marking that cap. URL and known credential
redaction happens before the final limits, in both sinks. These entries are not
byte-exact captures; separate debug body files are not subject to these limits.

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
| `info` | Errors plus startup/preflight status, request IDs, model/effort summaries, upstream lifecycle, HTTP codes, and completion/refusal/cache metadata. |
| `debug` | Info plus detailed timing/capture-path logs and automatic raw full-body capture for admitted Messages/count-token POSTs; no routine full-payload log dumps. |

Invalid values such as `warn`, `trace`, or `silent` stop startup. File logs
follow the same `logLevel` filter as console logs.

Start with `info`. Enable `logLevel: debug` only for a short, intentional capture
window, then restore `info`. It captures **all admitted Messages/count-token POSTs
during that window**, not just the request you are investigating. It does not
retroactively recover prior traffic. GET/static probes and requests rejected by
Host/Origin/content-type admission are not full-body captures.

## Debug captures and offline replay

### What is stored

Debug automatically writes raw, full **observed** client request, upstream request/
response, and downstream response bytes under:

```text
~/.copilot-relay/captures/<local-date>/<request-id>/
  meta.json
  client-request.bin
  client-response.bin
  upstream-<order>-request.bin
  upstream-<order>-response.bin
```

Use the local `request_id` in logs (also returned as
`x-copilot-relay-request-id`) to find a capture. `meta.json` carries HTTP status,
body/chunk state, ordered transport attempts/refresh outcomes, policy/catalog
snapshot and bounded completion metadata. `<order>` includes refresh steps, so
upstream filenames need not have consecutive numbers. Empty bodies need not have
a `.bin` file. Files are created with mode 0600 and directories with 0700; POSIX
permissions are enforced, while Windows access still depends on account ACLs.

The header allowlist is limited to `content-type`, `accept`, `anthropic-version`,
`anthropic-beta`, `claude-beta`, `x-request-id`, `x-github-request-id`,
`x-copilot-service-request-id`, and `retry-after`. Authentication headers and bearer
state are excluded. **This is not payload redaction.** Body files contain exact
observed prompt/tool/response data, including any secrets or private URLs in that
data. Do not archive, paste or upload a capture wholesale; review selected
metadata/excerpts locally before sharing anything.

### Completeness and limits

The writer has a maximum **8 MiB queued bytes per request** and **100,000 recorded
chunks per body**. Disk writes are asynchronous; forwarding is not stalled to
keep a capture complete. Overload, write/initialization/finalization failure,
cancellation or a still-pending body leaves explicit incomplete/pending state,
not a success claim. Replay reports `INCOMPLETE` for unfinished captures. Read the
`captureState`, `captureError` and body states in `meta.json`; an initialization
failure may leave only the normal error log and no usable capture directory.

These are queue/metadata bounds, not a total disk quota. A sustained debug window
can write large bodies. Raw streams contain only bytes the handler/client path
actually consumed; a cancelled/discarded transport is not secretly drained for
diagnostics. A complete byte recording may still contain a semantic refusal,
truncated generation or error. Capture completeness does **not** mean answer success.

### Replay locally

```sh
copilot-relay replay <request-id>
copilot-relay replay /absolute/path/to/capture-directory
```

Both forms are `copilot-relay replay <request-id|directory>`. An ID searches the
local date directories; an explicit directory can be outside the default home.
Replay runs the **actual current in-process handler** using recorded ordered
upstream/refresh transport, with no sockets, real authentication, token/config
writes or new capture. It compares actual outgoing requests and final JSON/SSE,
not just two saved files. Output includes each exchange's status, known completion
reason and numeric token/cache usage, plus client block types and tool-call count;
it does not print tool arguments or response text. Do not use `auth`, restart the
daemon or make a new Copilot call merely to replay a capture.

| Verdict | Exit | Meaning |
| --- | ---: | --- |
| `MATCH` | `0` | Current transformations and ordered operations agree with the recording. Not proof of live upstream health, answer correctness or cache efficiency. |
| `DIFF` | `2` | Outgoing/downstream structure or transport sequence differs. Diff output contains paths and fixed reasons, **no payload text**. |
| `INCOMPLETE` | `2` | Capture did not settle completely; no match is claimed. |
| `MISSING` / `MALFORMED` | `1` | Capture absent, ambiguous, unsafe, invalid or beyond replay limits. |

Replay accepts at most **16 MiB metadata** and **256 MiB combined body bytes**.
It validates fixed filenames, directory/file safety, schema and chunk sizes;
unsafe links are refused. A valid recording larger than the replay envelope is
not replayable merely because disk capture succeeded. Interrupted recordings
cannot be upgraded to `MATCH` by treating partial bytes as a full response.

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
info Default think effort: xhigh
info Running upstream preflight
info Upstream models available: gpt-6-astra, claude-opus-5
info Preflight OK: model=gpt-6-astra think_effort=xhigh
info Preflight OK: model=claude-opus-5 think_effort=xhigh
info Exposed models: gpt-6-astra[1m], claude-opus-5
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

`stream completed` means the handler ended, not that the model answered
successfully. Separate `request outcome` and upstream `completion` entries report
`http_status`, body state, `stop_reason`/`finish_reason`, response status, terminal
evidence, refusal category, incomplete reason and reported cache/input/output
usage. Missing terminal fields are `unknown`; do not infer zero cache usage from
an absent field. An HTTP 200 may carry refusal, `max_tokens`, a tool-result error
or a broken SSE stream. Inspect those outcomes, not just the transport status.

For non-2xx responses the same line includes a short error message when one is
available:

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 POST /v1/messages -> 400 123ms error="Invalid request"
```

### Model routing

At `info` (also included at `debug`):

```text
info Model request client=claude requested_model=opus upstream_model=claude-opus-5 requested_think_effort=high requested_thinking=type:enabled,budget:2048 effective_think_effort=high
```

| Field | Meaning |
| --- | --- |
| `client` | `claude` for Claude Code traffic, `generic` for internal startup preflight |
| `requested_model` | model name sent by Claude Code |
| `upstream_model` | actual Copilot model used |
| `requested_think_effort` | Claude Code's `output_config.effort`, legacy `reasoning_effort`, or `unset` when absent |
| `requested_thinking` | Claude Code `thinking` config, including budget when present |
| `effective_think_effort` | request effort when supplied; otherwise the configured default sent upstream, or `omitted` when the model advertises no effort support and none was requested |

Use this line first when debugging "why did my request use this model/effort?"
`requested_think_effort=unset` means the request supplied no effort; the effective
value is then the configured fallback, or `omitted` when the model advertises no
effort support. An explicit request for `none` is logged as `none`, not confused
with an absent field. The summary contains metadata, not the normal prompt/tool
payload dump, and strips terminal controls to stay on one line.
The native route has a narrower summary with `upstream_api=messages`, the routed
model and effective effort. The full original model/control fields remain in a
debug capture, not in a guarantee that both summary formats are identical.

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

Transient 5xx retries are logged at `error` with retry context. On translated
non-2xx failures, an `error` entry retains bounded upstream context on one line:

```text
error Failed to create responses: route=/responses model=gpt-6-astra status=400 { request: { ... }, response: { status: 400, headers: { ... }, body: { ... } } }
```

### Request captures

At `debug`, capture initialization reports the local request ID and directory
(example path):

```text
debug request_id=<request-id> capture=/home/<user>/.copilot-relay/captures/<local-date>/<request-id> privacy=full-bodies
```

Raw observed payloads live in `client-request.bin`, `client-response.bin`, and
`upstream-<order>-request.bin` / `upstream-<order>-response.bin`, with completeness
recorded in `meta.json`. Routine debug logs do not emit full payload objects;
remaining request/response context in ordinary logs is bounded error diagnostics.
Use the capture's completeness and privacy rules above, not a log excerpt, when
checking exact observed bytes.

### Tokens

Authentication lifecycle logs do not print bearer values; they carry paths and
scheduling only. Raw body captures may still contain secrets supplied in prompts
or echoed by upstream, which is a separate privacy boundary:

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
`upstreamTimeoutSeconds`, `copilotBaseUrl`, `webSearchBackend`, `claudeUpstreamApi`,
`gptModel`, and `opusModel`. Changing `host`, `port`, or `claudeSetup` requires a
restart. The watcher never rewrites the file: invalid, empty, or partial saves
retain the last valid settings until every materialized key is present again.
Active requests retain their admission-time policy while using refreshed credentials.

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

## Broken config and stopping safely

A bad edit need not stop a daemon already serving its last valid policy. `status`
exits `2` with a safe config diagnostic rather than guessing health or rewriting
invalid values. Fix the file and restore every key for hot reload; see
[Configuration](EN-Configuration.md).

If you need to stop it first, `copilot-relay stop` continues best-effort without a
config port hint and can identify both `start` and long-running `restart`
processes. It signals only verified relay identities, rechecks before escalation,
and preserves unknown/live PID records. A failed process query is not proof that
a process exited: unknown discovery retries for a bounded interval, then reports
that stop was not confirmed. `status` reports unknown inspection with exit `2`.
“No existing instance found” is not emitted to hide an unknown candidate. Do not
blindly kill an unverified PID; inspect it or use the owning service manager.

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

Translated upstream failures can include route/model and bounded request/response
context in the matching `error` entry. Do not mistake that rendered excerpt for
a full capture. Native failures retain their upstream error rather than silently
switching APIs; correlate the request ID and completion metadata first.

```sh
grep -n "Failed to create" ~/.copilot-relay/logs/copilot-relay.*.log
```

If the response body mentions request shape, inspect a reviewed bounded excerpt
or a complete local capture. The translated path permits an inline system
`output_config` only when its sole key is `effort`, that value is one of the five
configured effort levels, and it exactly matches the current resolved request
effort. System text and order stay intact. Different historical efforts,
additional/unknown keys, `clear_at`, unknown roles or malformed system text return
HTTP 400 JSON before upstream work or SSE. Native forced bridge-search choices
and unrecognized old bridge history do too. Do not silently rewrite controls or
strip signed history to hide these errors; see [Internals](EN-Internals.md).

Host/Origin rejection is `403`; a nonempty inference/token-count POST without
`application/json` is `415`. These are local admission errors, not Copilot auth
failures, and do not make a non-loopback listener authenticated.

An upstream HTTP 400 can also be a client/provider capability mismatch. In the
isolated 2026-09-30 Claude Code 2.1.285 native check, the first two requests were
rejected for unsupported `safeguards`; the client subsequently downgraded its own
request and completed the two-turn `Read`/tool-result exchange. The relay did not
strip that field or bypass safety controls. That observation is not a recommendation
to remove safeguards, nor validation of the production listener on port 4142.
The scoped evidence and limitations are in [Internals](EN-Internals.md).

If it mentions auth or model access, refresh the login and then verify with a
check that actually reaches Copilot:

```sh
copilot-relay auth
copilot-relay restart      # if the relay was already running
copilot-relay status --deep
```

**Do not use `/v1/models` to confirm this.** It lists the model IDs your
config names and never contacts Copilot, so an expired token or a model your
subscription cannot access passes it unchanged. Only `POST /v1/messages`
exercises token refresh and real upstream model access — which is what
`status --deep` sends, and what a real Claude Code request does.

## Wrong model used

With `logLevel: info` or `debug`:

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
`thinkEffort` in config. Request effort takes precedence; the configured value is
used only when no request effort is supplied and the model does not explicitly
exclude effort. Startup preflight checks that default, or logs `omitted` for a
no-effort model; it does not test every possible request override. The precedence rules and distinction
from a thinking-token budget are in [Configuration](EN-Configuration.md).
`thinkEffort: none` and malformed defaults now fail startup with valid choices;
an invalid hot reload logs an error and leaves the previous runtime settings active.

## WebSearch fails or returns no results

Claude WebSearch is executed by the relay through Copilot `/responses` with
`web_search_preview`, even when the conversation uses native Claude Messages.
Native bridge search requires automatic selection; forced `any` or an explicitly
forced search is rejected before retrieval. Multiple/repeated search calls are
not supported. Old chat-bridge search history is not transparently accepted on
native; keep the original route or start a new conversation. See
[Internals](EN-Internals.md) for signed-history reconstruction.

If search returns an error result:

```sh
grep -n "web_search_preview\|Failed to create responses\|Copilot web search" ~/.copilot-relay/logs/copilot-relay.*.log
```

Failed upstream HTTP requests keep the `unavailable` tool-result error code, but
the accompanying text reports the actual upstream status and backend model:

```text
Copilot web search upstream service unavailable (HTTP 503; model gpt-6-astra).
```

A 503 means service unavailability; other 5xx responses mean server failure, 429
means rate limiting, 401 means authentication was rejected, and 403 means access
was denied. These do not establish missing model/tool support or token expiry.
Other statuses report a generic request failure. The outer Claude response can
still be HTTP 200, including an already-open SSE stream; inspect the tool result
and upstream `return from upstream ... status=...` log entry, not only the outer
status. A successful HTTP response is classified separately before any partial
results are accepted:

| Responses body | Diagnostic / behavior |
| --- | --- |
| `incomplete` | `response incomplete (max_output_tokens)` or `content_filter`; unknown reasons are omitted as `unknown`, absent reasons as `unreported`. Partial links are not accepted. |
| `failed` / `cancelled` | `response failed` / `response cancelled`, even if partial text contains URLs. |
| `queued` / `in_progress` / unknown status | `response not complete (...)`; no automatic retry. |
| Explicit unsuccessful/nonterminal search call | `search call did not complete`; no partial results. |
| `completed`, no text or usable structured sources | `completed without extractable text or sources`. |
| Text without usable URLs or structured sources | `returned text without usable source URLs`. |
| Missing status and no usable results | `returned no usable results (response status unreported; no extractable text or sources)`. Missing metadata is not proof of successful execution. |
| Malformed JSON/body | `returned a malformed response`; no raw body is included. |

These remain `web_search_tool_result_error` with `error_code: unavailable`.
Reported input/output usage and a valid upstream response ID survive 2xx failures,
rather than being replaced by zero usage and an unrelated synthetic ID. Invalid or
missing token counts use zero only where the Claude protocol requires a number;
the diagnostic summary reports them as `unknown`.

At `info`, `Copilot web search completion` records bounded single-line metadata:
`request_id`, `upstream_response_id`, configured backend model, requested/effective
effort, output cap, response status, recognized incomplete reason, output-item
counts, search-call status counts, input/output/reasoning token counts, source
format, provenance, and outcome. A second `Copilot web search tool result` entry
correlates those IDs with the returned `tool_use_id`. IDs with unsupported shapes
are omitted, and unknown status/type values become fixed markers; neither entry
logs queries, prompts, response text, reasoning text, headers, or arbitrary errors.

Structured citation/source URLs are preferred when available; otherwise the
existing text-URL fallback remains supported. Missing citations or search-call
metadata do not prove the model lacks search support. Only a reported completed
`web_search_call` is treated as execution evidence; other results are explicitly
unverified in the final-answer context, and source content remains untrusted.

The inherited effort and existing search output cap (at most 1200 tokens) are
unchanged. `incomplete_reason=max_output_tokens` with reported reasoning/output
usage is evidence of budget exhaustion for that request, not proof of the cause
of historical empty results. Do not fix an unknown cause by increasing the global
timeout, changing the conversation model/effort, or repeatedly retrying empty
responses.

When available, an upstream error message or code is included after sanitization,
capped at 240 characters. Recognized credential/request echoes and unrecognized
structured bodies are omitted; no raw response headers or request payloads are added to logs.
Retry policy and model selection are unchanged. This is diagnostic handling, not
proof of search execution: links in generated text alone do not prove a search ran.

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

A cached bearer can be rejected before its advertised deadline. The relay tries
one non-interactive refresh for HTTP 401 or a plain `forbidden` HTTP 403, both
during preflight and normal requests. Concurrent failures share the refresh;
explicit policy/model/quota denials do not trigger it. A 403 alone does not prove
expiry or loss of account access.

```sh
grep -n "authentication rejected\|token refresh completed\|token recovery failed" ~/.copilot-relay/logs/copilot-relay.*.log
```

`token refresh completed; retrying` means an exchange completed or a newer token
was reused, not that inference succeeded. Inspect the retry's upstream status;
persistent rejection remains visible. A failed exchange does not launch device
authorization. Cancelled requests and already-started streams are never replayed.

If auth errors persist:

1. Check whether `github_token` and `copilot_token.json` exist without printing their contents.
2. Check refresh/recovery failure logs and the final upstream status.
3. Investigate explicit permission or quota errors separately from rejected credentials.
4. Run `copilot-relay auth` only when GitHub login needs renewal; deleting the cache or reauthorizing is not the normal recovery path.

After recovery, `copilot-relay status --deep` tests inference; local health and
model-list endpoints alone do not prove upstream access.

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

**Never share raw captures wholesale.** Prompts, tool arguments/results, signed
thinking, responses and echoed URLs can contain private data or secrets even
though auth headers were excluded. Do not upload an entire capture to an issue,
chat or diagnostic service. Review a minimal excerpt locally first.

Normal log URL tails are redacted (for example
`https://gateway.example[redacted]`), but this does not sanitize arbitrary payload
secrets. Review even an `error` excerpt; bounded is not the same as safe to publish.

For bug reports, include only reviewed, necessary information:

- exact timestamp and local request ID
- the `info` request/outcome summary, distinguishing HTTP status from completion
- a sanitized related `error` excerpt if needed
- replay verdict and structural diff paths, not body files
- whether debug was enabled and whether the capture was complete
- relevant config with private endpoints and values removed

A captured refusal establishes that refusal was observed, not why the provider
made it. Reasoning flattening is still not proven to have caused the historical
refusal. The bounded 2026-09-30 native/chat cache trial and separate real-client
check are recorded in [Internals](EN-Internals.md), including the interrupted
counterbalanced trial's native cold refusal. They do not establish broad cache
non-regression, billing-cost equivalence or current production readiness;
`chat-completions` remains the default. Recorded success and refusal cases both
replayed as `MATCH`: that verifies local reproduction, not approval of the answer
or a new successful upstream call. Port 4142 was untouched by those isolated checks.
