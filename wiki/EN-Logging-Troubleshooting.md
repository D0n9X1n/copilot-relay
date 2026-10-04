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

   With `apiKey` set, `/v1/models` answers `401` unless the request carries the
   key, for example `-H "x-api-key: <key>"`. `/healthz` needs no key.

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
info Model request client=claude requested_model=opus upstream_model=claude-opus-5 requested_think_effort=high requested_thinking=type:enabled,budget:2048 effective_think_effort=high initiator=user
```

| Field | Meaning |
| --- | --- |
| `client` | `claude` for Claude Code traffic, `generic` for internal startup preflight |
| `requested_model` | model name sent by Claude Code |
| `upstream_model` | actual Copilot model used |
| `requested_think_effort` | Claude Code's `output_config.effort`, legacy `reasoning_effort`, or `unset` when absent |
| `requested_thinking` | Claude Code `thinking` config, including budget when present |
| `effective_think_effort` | request effort when supplied; otherwise the configured default sent upstream, or `omitted` when the model advertises no effort support and none was requested |
| `initiator` | `x-initiator` sent to Copilot: `user` for a prompt a person typed; `agent` for tool continuations, subagents, compaction and the relay's own requests |

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
non-2xx failures, an `error` entry retains bounded upstream context on one line. The upstream
`response` comes before the `request`, so a long request cannot push the upstream body out of
the bounded entry:

```text
error Failed to create responses: route=/responses model=gpt-6-astra status=400 { response: { status: 400, headers: { ... }, body: { ... } }, request: { ... } }
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
`gptModel`, and `opusModel`. Changing `host`, `port`, `claudeSetup`, or
`upstreamProxy` requires a restart. The watcher never rewrites the file: invalid,
empty, or partial saves retain the last valid settings until every materialized
key is present again. Active requests retain their admission-time policy while
using refreshed credentials.

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
- the network reaches the internet only through a proxy, and `upstreamProxy` is
  empty

For that last cause, the relay logs a line that names the fix when `HTTPS_PROXY`
or `HTTP_PROXY` is set:

```sh
grep -n "upstreamProxy is empty" ~/.copilot-relay/logs/copilot-relay.*.log
```

Set `upstreamProxy` as described in [Configuration](EN-Configuration.md).

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
failures, and do not make a non-loopback listener authenticated. With `apiKey`
set, a request without that key, or with a different one, is `401`
`authentication_error`, also from the relay before any Copilot call; see
[Claude Code settings are wrong](#claude-code-settings-are-wrong).

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

## Prompt is too long

Copilot rejects a prompt over the model's `max_prompt_tokens` with HTTP 400 and
`model_max_prompt_tokens_exceeded`. The relay reports it in the shape and wording
Anthropic's API uses, which is how Claude Code recognizes a prompt that is too
long. A JSON request gets this body with HTTP 400, and its request summary keeps
the upstream wording:

```json
{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 131008 tokens > 128000 maximum"}}
```

```text
info request_id=3b241101-e2bb-4255-8caf-4136c566a962 POST /v1/messages -> 400 123ms error="prompt token count of 131008 exceeds the limit of 128000"
```

A streaming request already has HTTP 200, so its summary shows `-> 200`; the
error arrives as the SSE `error` event, with ` (request_id=<id>)` appended to the
message. [Internals](EN-Internals.md) explains why the stream opens before
Copilot answers.

```sh
grep -n "prompt is too long\|prompt token count of" ~/.copilot-relay/logs/copilot-relay.*.log
```

On `/chat/completions` and `/responses`, the `Failed to create ...` entry keeps
Copilot's response body. A streaming request also logs
`Error during Claude stream request:` with the mapped error.

The relay never shortens a prompt. Compact the conversation (`/compact` in Claude
Code), start a new one, or choose a model with a higher limit. `GET /v1/models`
lists each configured model's `max_input_tokens` when the cached Copilot catalog
reports it.

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

## Prompt-cache hit rate

`copilot-relay cache` reports how much of each model's input the prompt cache
served, per upstream route. It reads only the local log files: it contacts
neither the relay nor Copilot, and writes nothing.

```sh
copilot-relay cache                      # last 24 hours, one row per model and route
copilot-relay cache --hourly             # hourly trend over the last 24 hours
copilot-relay cache --daily              # daily trend across the retained logs
copilot-relay cache --since 6h           # a duration, or an ISO date or time
copilot-relay cache --model opus         # names containing "opus", ignoring case
copilot-relay cache --goal 97.5          # rates below 97.5% in red (default 95)
copilot-relay cache --json               # an array of rows, for scripts
```

```text
Prompt-cache hit rate since 2026-10-02 17:30 local time, goal 95%

  MODEL               ROUTE              REQUESTS  HIT RATE
  claude-opus-5-5     /v1/messages              1    98.36%
  claude-opus-5.5     /chat/completions         2    98.38%
  gpt-5.5-2026-04-23  /responses                1    92.86%

HIT RATE leaves out 1 call that logged no cache_read_input_tokens.
```

| Column | Meaning |
| --- | --- |
| `MODEL`, `ROUTE` | The model the upstream reported, or `unknown` when the entry has none, and the upstream path. One model can be reported under different names on different routes, such as `claude-opus-5.5` and `claude-opus-5-5`. |
| `REQUESTS` | Upstream calls that answered HTTP 200 and logged `input_tokens`, including calls cut off after their usage arrived and calls whose caching is unknown. |
| `HIT RATE` | Input tokens read from the prompt cache, divided by total input, truncated to two decimals. On a color terminal it is green at or above `--goal` and red below it. It is `-`, in gray, when no call in the row reported its caching. |

A call whose entry carried no `cache_read_input_tokens` has unknown caching, not
zero. It counts in `REQUESTS` but not in `HIT RATE`, and the line under the table
says how many such calls there are; with none, the line is left out. The token
counts behind the rate (total input, cache read, uncached and cache write), and
the counts of calls with unknown caching and with a cache read of 0, are in
`--json`.

The color of `HIT RATE` is the table's only mark of a missed goal. Without color
(`NO_COLOR`, or output to a pipe), compare the rate with the goal in the title, or
read `belowGoal` in `--json`. `HIT RATE` is truncated rather than rounded, so a rate
below the goal never prints as the goal. `--goal` takes at most two decimals, and a
rate is red exactly when the printed `HIT RATE` is below the goal.

`--hourly` and `--daily` add an `HOUR` or `DAY` column in local time, matching
the dates in the log file names. When clocks go back, a local hour that happens
twice gets one row per real hour, each ending in its UTC offset, such as
`2026-11-01 01:00 UTC-04:00` and `2026-11-01 01:00 UTC-05:00`. Without `--since`,
the summary and the hourly trend cover the last 24 hours and the daily trend
covers every retained day. A duration counts back from now; a date, or a time
without `Z` or an offset, is local.

`--json` prints one object per row with `bucket`, `model`, `route`, `requests`,
`unknownCacheRequests`, `zeroCacheReadRequests`, `totalInputTokens`,
`cacheReadTokens`, `uncachedInputTokens`, `cacheWriteTokens`, `hitRate` and
`belowGoal`. `hitRate` is a fraction from 0 to 1, or `null`; `bucket` is `null`
in the summary, and `cacheWriteTokens` is `null` when no call in the row reported
it. With no data it prints `[]`.

An unusable flag, or a logs directory that cannot be read, prints the reason on
stderr and exits `1`. Any report, an empty one included, exits `0`.

### What is counted

The command reads the `completion` entry the relay logs at `info` for each
upstream call, from the dated files in `~/.copilot-relay/logs/`. An entry counts
only with `http_status=200`, a numeric `input_tokens`, and a route of
`/chat/completions`, `/responses` or `/v1/messages`. Its `body` and `terminal`
values do not matter, so a call cut off after its usage arrived still shows what
it read from cache. The `request outcome` entry reports usage again, for the
client request (both entries are described under HTTP requests above), so it is
never read: counting it would count calls twice. Malformed lines, and a last line
the relay is still writing, are skipped.

`input_tokens` means different things per route, so the total input that `HIT RATE`
divides by (`totalInputTokens` in `--json`) is normalized:

| Route | Total input |
| --- | --- |
| `/chat/completions`, `/responses` | `input_tokens`, which already includes cached input |
| `/v1/messages` | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` |

On `/v1/messages`, an absent `cache_creation_input_tokens` counts as 0. Hours and
days are local time.

How far back the command can see depends on `logRetentionDays` (default `3`).
`completion` entries are written at `info`, so a relay running with
`logLevel: error` leaves nothing to read, and the command says it found no data
rather than printing an empty table.

### Finding a regression

`--hourly` shows the hour a hit rate changed. A fixed-prefix cap, like the one
in #143, shows up as one cache-read size repeated across many requests. To list
the most common read sizes for one model:

```sh
grep -h " completion path=" ~/.copilot-relay/logs/copilot-relay.*.log \
  | grep -F "model=claude-opus-5.5 " \
  | grep -o "cache_read_input_tokens=[0-9]*" \
  | sort | uniq -c | sort -rn | head
```

## Copilot plan and quota

`copilot-relay usage` shows the Copilot plan of the account behind the stored
GitHub token, and how much of each quota is left. It asks GitHub's
`copilot_internal/user` endpoint with the token in `~/.copilot-relay/github_token`,
so no relay needs to run. The request goes through `upstreamProxy`, which it reads
from `config.yaml` without writing the file; without a `config.yaml` it connects
directly. It exchanges no Copilot token and writes nothing, the log file included.

```sh
copilot-relay usage                      # plan, SKU, reset date, then one line per quota
copilot-relay usage --json               # the same fields as one object, for scripts
```

```text
Plan         <copilot_plan>
SKU          <access_type_sku>
Quota reset  <quota_reset_date>

chat                  unlimited; overage not permitted, overage count <overage_count>
completions           unlimited; overage not permitted, overage count <overage_count>
premium_interactions  <remaining> of <entitlement> remaining (<percent_remaining>%); overage permitted, overage count <overage_count>
```

Each quota line is built from that quota's entry in `quota_snapshots`:

| Text | Fields |
| --- | --- |
| `unlimited` | `unlimited` is `true` |
| `<remaining> of <entitlement> remaining (<percent_remaining>%)` | `remaining`, `entitlement` and `percent_remaining` |
| `overage permitted`, `overage not permitted` | `overage_permitted` |
| `overage count <n>` | `overage_count` |
| `credits used <n>`, only when the entry has it | `credits_used` |

Every number is printed as GitHub sent it. The command rounds nothing and works
nothing out; the percentage is GitHub's `percent_remaining`. A field that is
missing, or not of the type GitHub sends, prints as `?`; `credits_used` is then
left out. A missing plan, SKU, reset date or quota prints as `not reported`.
`chat`, `completions` and `premium_interactions` are always listed first; any
other quota in the answer follows them.

`--json` prints one object with `copilot_plan`, `access_type_sku`,
`quota_reset_date` and `quota_snapshots`. Each of the first three is always
present, and is `null` when GitHub did not report it or sent it with another
type. `quota_snapshots` maps each quota id to its snapshot. `chat`, `completions`
and `premium_interactions` are always present; a snapshot that is absent, or is
not a JSON object, is `null`. A snapshot object always has all eight keys:
`unlimited`, `entitlement`, `remaining`, `percent_remaining`, `overage_permitted`,
`overage_count`, `token_based_billing` and `credits_used`. A field that is
missing, or sent with another type, is `null`. The rest of GitHub's answer, such
as the login and organization lists, is never printed.

Each failure prints one line on stderr and exits `1`; a report exits `0`. The
request headers are never printed. GitHub's answer, and a network error's reason,
are checked for the stored token before anything is printed. The check finds the
token written exactly, written with other characters between its letters and
digits, or, in an answer, spread over the plan, SKU, reset date and quota ids in
the order `--json` prints them. The last two forms are searched for only when the
token has at least 16 letters and digits; a GitHub token has far more. An exact
copy in a network error's reason prints as `[redacted]`; any other match prints
the fixed line from the table instead. A token written any other way, such as in
another case or encoding, is not found.

| Case | Message |
| --- | --- |
| No stored token | `No GitHub token is stored at <path>. Sign in with copilot-relay auth.` |
| The token file cannot be read | `Could not read the GitHub token at <path>: <code>.` |
| `config.yaml` cannot be read or is invalid | `Could not read the config at <path>; fix it, then run copilot-relay usage again.` |
| `upstreamProxy: env` with a malformed `HTTPS_PROXY` or `HTTP_PROXY` | `Invalid HTTPS_PROXY or HTTP_PROXY: with upstreamProxy: env, each one that is set must be an absolute http(s) proxy URL` |
| HTTP 401 or 403 | `GitHub rejected the stored token (HTTP <status>). Sign in again with copilot-relay auth.` |
| Any other HTTP status | `GitHub answered the usage request with HTTP <status>.` |
| The answer is not a JSON object | `GitHub's answer to the usage request was not a JSON object.` |
| The plan, SKU, reset date or quota ids show the stored token | `GitHub's answer to the usage request contains the stored token, so none of it is printed.` |
| A network error | `Could not reach GitHub: <reason>` |
| A network error whose reason shows the stored token with other characters inside it | `Could not reach GitHub.` |
| No answer within 30 seconds | `GitHub did not answer within 30 seconds.` |

The `config.yaml` line names no reason, because that file can hold credentials,
such as an `upstreamProxy` password. [Configuration](EN-Configuration.md) lists
the rules.

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
`claudeSetup: true`. With `apiKey` set, that file holds the key as
`ANTHROPIC_AUTH_TOKEN`, so do not print the file or share it whole. This check
prints the origin of `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_AUTO_MODE_SERVER` only as
`0`, `1`, unset or another value, whether a token is set, and how the relay at
that address answers the token. It replaces the token wherever it would appear in
what it prints:

```sh
node - <<'EOF'
const file = require("node:path").join(require("node:os").homedir(), ".claude", "settings.json")
let env
try {
  env = JSON.parse(require("node:fs").readFileSync(file, "utf8")).env || {}
} catch {
  console.log(`${file}: missing or not valid JSON`)
}
if (env) {
  const token = typeof env.ANTHROPIC_AUTH_TOKEN === "string" ? env.ANTHROPIC_AUTH_TOKEN : ""
  // Every printed line passes through hide, which replaces the token wherever it appears.
  const secret = token && new RegExp(token.replace(/\W/g, "\\$&"), "gi")
  const hide = (text) => secret ? text.replace(secret, "[redacted]") : text
  let url
  try {
    url = new URL(env.ANTHROPIC_BASE_URL)
  } catch {
    url = undefined
  }
  if (url && !/^https?:$/.test(url.protocol)) {
    url = undefined
  }
  // The origin only: a path, query or user name can hold anything.
  let base = env.ANTHROPIC_BASE_URL === undefined ? "(unset)" : "(not an http or https URL)"
  if (url) {
    const extra = url.username || url.password || url.search || url.hash || url.pathname !== "/"
    base = url.origin + (extra ? " (path, query or credentials hidden)" : "")
  }
  const mode = env.CLAUDE_CODE_AUTO_MODE_SERVER
  let autoMode = "(set to another value)"
  if (mode === undefined) {
    autoMode = "(unset)"
  } else if (mode === "0" || mode === "1") {
    autoMode = mode
  }
  console.log(hide(`ANTHROPIC_BASE_URL: ${base}`))
  console.log(hide(`CLAUDE_CODE_AUTO_MODE_SERVER: ${autoMode}`))
  console.log(hide(`ANTHROPIC_AUTH_TOKEN: ${token ? "set" : "missing"}`))
  if (url) {
    fetch(`${env.ANTHROPIC_BASE_URL}/v1/models`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
      .then(async (response) => {
        await response.arrayBuffer()
        console.log(hide(`The relay answers with HTTP ${response.status}.`))
      })
      .catch(() => console.log(hide(`No relay answered at ${base}.`)))
  }
}
EOF
```

In PowerShell, pipe the same script as a here-string: replace the first line with
`@'` and the last line with `'@ | node -`.

`200` means the relay accepts the token: it matches the relay's `apiKey`, or no
`apiKey` is set. `401` means the token is missing or differs from the key the
relay is running with; see below.

Expected values:

- `ANTHROPIC_BASE_URL` points at `http://127.0.0.1:4142`
- `ANTHROPIC_AUTH_TOKEN` is set. With `apiKey` set, startup writes the key there.
  Without one, startup keeps an existing token, even a key an earlier `apiKey`
  wrote, and sets `dummy` only when the token is missing or empty; the relay then
  accepts any token
- `CLAUDE_CODE_AUTO_MODE_SERVER` is `0`, unless you set another value
- With `apiKey` set, only you can read the file on Linux and macOS:
  `ls -lL ~/.claude/settings.json` shows `-rw-------`

Changing `host` or `port` requires restarting the relay, because the listening
socket cannot move during hot reload.

With `apiKey` set, a client whose token differs from it gets `401`, and the relay
logs `error="Missing or invalid API key: ..."`:

```sh
grep -n "Missing or invalid API key" ~/.copilot-relay/logs/copilot-relay.*.log
```

The settings writer runs only at startup, and a running client keeps the token it
loaded. After changing `apiKey`, restart the relay, or set the token yourself, and
then restart Claude Code. See [Configuration](EN-Configuration.md).

## Claude Code says the session isn't eligible for auto mode

Claude Code can print a notice like this, in the terminal or, with `claude -p`,
on stderr:

```text
We're changing auto mode to no longer charge for classifier requests in Claude Code. However, this session isn't eligible because your requests go through 127.0.0.1:4142, which isn't compatible with this update. Nothing breaks: auto mode keeps working, and its classifier requests are billed as before.
```

It is expected through the relay: auto mode's server checks do not reach Claude
Code, so it makes its own classifier requests. `CLAUDE_CODE_AUTO_MODE_SERVER=0` in
Claude Code's environment stops the server check and the notice. With
`claudeSetup: true`, `copilot-relay start` writes it when it is absent; see
[Configuration](EN-Configuration.md).

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
