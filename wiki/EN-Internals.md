# Internals

The precise mechanics behind the boundaries drawn in
[Architecture](EN-Architecture.md). This page is written for anyone — human or
coding agent — who has to change the relay without breaking something that was
expensive to learn.

Source paths and symbol names are given so they can be located by search. Line
numbers are deliberately omitted; they go stale, names do not.

## Module map

```text
src/
  main.ts                     CLI entry (citty): auth, start, stop, restart, status
  server.ts                   Hono app, request logging, health/root endpoints
  start.ts                    startup sequence and hot-reload wiring
  stop.ts                     process discovery and shutdown escalation
  restart.ts                  stop + start
  status.ts                   detection, health probe, --deep, --json, exit codes
  auth.ts                     GitHub device login command

  routes/claude.ts            POST /v1/messages, count_tokens, GET /v1/models

  claude/
    types.ts                  the subset of Claude Messages types used
    translate.ts              non-streaming Claude <-> Copilot translation
    stream.ts                 Copilot chunks -> Claude SSE state machine
    web-search.ts             bridge-managed WebSearch execution
    web-search-stream.ts      resolveWebSearchStreamDecision
    tool-names.ts             Claude <-> Copilot tool name normalization
    utils.ts                  shared translation helpers

  copilot/
    client.ts                 authenticated HTTP client, retries, timing
    chat.ts                   chat abstraction, routing, think effort
    responses.ts              Responses API translation, prompt_cache_key
    tool-schema.ts            Responses-only tool schema compatibility
    types.ts                  upstream payload types

  lib/
    app-config.ts             readAppConfig(), write-back, hot reload
    config.ts                 config file plumbing
    defaults.ts               shipped defaults
    paths.ts                  ~/.copilot-relay layout, resolved at import time
    auth.ts                   token storage and refresh scheduling
    models.ts                 routing + thinkEffort validation
    preflight.ts              startup upstream verification
    lifecycle.ts              pid file, findRelayOnPort, findRelayProcessIds
    log.ts                    formatLogValue, rotation, retention
    redact.ts                 pure URL/secret redaction
    claude-settings.ts        ~/.claude/settings.json management
    tokenizer.ts              count_tokens heuristics
    upstream-diagnostics.ts   upstream error context capture
    error.ts                  error shaping
    state.ts                  runtime state
    version.ts                build version
```

## Config resolution, write-back, and reload

`readAppConfig()` in `src/lib/app-config.ts` resolves the config and **writes the
result back** to `~/.copilot-relay/config.yaml`. The consequence is the single
most misunderstood thing in the codebase:

> An existing install has every key materialized on disk. A `?? defaultConfig.x`
> fallback in that path is never consulted again.

So **changing a shipped default reaches fresh installs only.** That is intended.
A user's config value is theirs; do not add migration machinery to push a new
default onto existing installs. A `configVersion` mechanism existed briefly for
exactly that and was removed in #26 as unnecessary complexity.

### Hot reload vs restart

Hot-reloaded — applies to work that starts after the change:

`logLevel`, `logRetentionDays`, `thinkEffort`, `upstreamTimeoutSeconds`,
`copilotBaseUrl`, `webSearchBackend`, `gptModel`, `opusModel`

Requires restart:

`host`, `port`, `claudeSetup`

`host` and `port` cannot move because the listening socket is already bound.
`claudeSetup` is read once during startup, so toggling it changes nothing until
the relay starts again. Changing `gptModel` reroutes upstream requests
immediately but does not rewrite the model already saved in
`~/.claude/settings.json` — that is written at startup.

A reload logs what it applied:

```text
info Config reloaded: logLevel=debug thinkEffort=xhigh upstreamTimeoutSeconds=180
```

Adding a key means updating `config.default.yaml`, the README, and
[Configuration](EN-Configuration.md) in both languages.

## Request translation

`src/claude/translate.ts` handles non-streaming payloads in both directions:
Claude request -> Copilot chat request, and Copilot response -> Claude response.
It maps tool calls and thinking/text blocks between the two protocol shapes.

`src/claude/tool-names.ts` normalizes Claude tool names into Copilot-compatible
names on the way out and maps them back on the way in. Claude Code's tool names
are not always valid upstream identifiers, and a response carrying the normalized
name would not match the tool the client registered.

`src/claude/types.ts` defines only the subset of Claude Messages API types the
proxy needs. It is intentionally not a full Claude SDK — an unused type is a
maintenance cost with no test covering it.

## Chat vs Responses

`src/copilot/chat.ts` is the internal chat abstraction used by both routes and
startup preflight. It applies model routing, think effort, and request logging,
and chooses Copilot `/responses` for configured GPT-style models.

`src/copilot/responses.ts` translates between the Copilot Responses API and
chat-completion-like results. It exists because the default `gpt-6-astra`, the
previous `gpt-5.6-sol` default, and the `gpt-5.5`/`gpt-5.6` family use `/responses`
upstream, while Opus uses `/chat/completions`.

Two upstream APIs, one Claude-facing protocol. Claude Code never learns which
one served its request.

### Tool-schema compatibility

`normalizeResponsesToolSchema` in `src/copilot/tool-schema.ts` adapts function
parameters at the shared `buildResponsesRequestPayload` boundary. Copilot rejects
JSON Schema `pattern` constraints containing Unicode property escapes such as
`\p{Cc}` and `\P{L}`, and lookahead/lookbehind assertions such as `(?!...)`.
Claude Code's `Artifact` tool includes these patterns in its `field`, `database`,
and `doc_id` parameters even when the user never calls that tool. Removing only
the Unicode pattern reveals a second upstream rejection for the lookaheads.

The relay omits those patterns from the upstream copy, keeping supported patterns
and other schema fields. Escaped literals and lookaround-like text inside
character classes remain intact. It visits schema-bearing keywords, not literal
data in `default`, `const`, `enum`, or `examples`, and does not rewrite property names.
The original Claude schema and the `/chat/completions` path remain unchanged;
client-side tool validation still enforces the original constraint. The same
adaptation covers streaming, non-streaming, and WebSearch model passes that use
Responses.

## Streaming

`src/claude/stream.ts` converts streaming Copilot chat chunks into Claude SSE
events. It is a state machine because Claude requires explicit content block
start/delta/stop events in the correct order for text, thinking, and tool use —
a Copilot chunk stream carries no such framing.

### WebSearch without giving up streaming

Claude WebSearch is bridge-managed: the relay executes it through Copilot
`/responses` with `web_search_preview`, then sends the retrieved context through
a final model pass and returns Claude `server_tool_use` /
`web_search_tool_result` blocks. The final pass keeps the client's other tools
available, so the model can act on what it found in the same turn.

The problem this creates: the relay must know whether the model selected
`web_search` before it can choose between an ordinary completion and the bridge
path. That used to be settled by forcing `stream: false` on any request that
merely *advertised* the tool — and Claude Code advertises it on every turn, so
nearly all traffic paid for a buffered completion replayed as synthetic SSE.

`resolveWebSearchStreamDecision` in `src/claude/web-search-stream.ts` reads the
decision pass only as far as it takes to rule a search call in or out, emitting
each consumed chunk as it goes:

- **no search** — the turn is indistinguishable from an ordinary stream
- **search** — the response is accumulated and handed to the bridge path unchanged

**Text never settles the question.** Copilot routinely writes a preamble ("I'll
search for that now.") before calling the tool. Treating content as proof that no
search is coming lets the later `web_search` call escape unintercepted and reach
Claude Code as a *client* `tool_use` named `WebSearch` — a malformed turn, since
the client expects the server to have executed it. Only a named tool call or a
`finish_reason` settles it. `tests/unit/web-search-stream.test.ts` pins this.

When a search is detected after a preamble has already streamed, the search
blocks continue the open message rather than starting a second one, giving the
native order `text` → `server_tool_use` → `web_search_tool_result` → `text`.

## Prompt caching

Long Claude Code sessions resend a large, mostly-stable prefix (system prompt,
tool definitions, prior turns) every request. Prompt cache hits on that prefix
are the main lever for input-token cost and latency. Two relay behaviors are
load-bearing here; both were verified against live Copilot upstream.

### `/responses` cache routing with `prompt_cache_key`

The relay sends a stable `prompt_cache_key` as a cache-routing hint. Earlier
Copilot `/responses` tests with the GPT-5.5/5.6 family found cache reads dropping
to 0 without it. That does not establish that every model requires the key:
Astra also cached requests without it in the controlled check below. A key alone
neither guarantees a cache hit nor replaces a stable prompt prefix.

`buildResponsesRequestPayload` derives a per-conversation key:

- prefer the client conversation id (Claude Code sends a stable
  `metadata.user_id`, surfaced as `payload.user`);
- fall back to a hash of the system prompt when there is no user id.

The key itself is a SHA-256 digest (`cr-` plus 32 hex characters), so
`prompt_cache_key` does not expose the identifier it was derived from.

**That is not an anonymization guarantee for the request as a whole.**
`buildResponsesRequestPayload` sets `prompt_cache_key` *and*, separately,
`user: sanitizeUserIdentifier(payload.user)`. `sanitizeUserIdentifier` in
`src/copilot/chat.ts` only truncates to 64 characters — it does not hash — so
the identifier Claude Code sent is forwarded upstream in the `user` field of
the same request. The `/chat/completions` path forwards it the same way.

Operationally: treat `metadata.user_id` as a value GitHub Copilot will see.
Do not put secrets or personal data in it. Hashing the cache key protects the
cache-routing value, not the identifier.

Earlier end-to-end measurements with `gpt-5.5`, a stable user id, and a large
prefix showed ~100% warm cache reads versus 0 without the key. Treat that as a
measurement of that model and workload, not a universal cache requirement.

### GPT-6 Astra cache check

On 2026-09-05 (UTC), six small non-streaming calls to Copilot `/responses` used
`gpt-6-astra`, `low` effort, a synthetic prefix, and the relay's actual
`buildResponsesRequestPayload`. Each arm had its own prefix marker and three
identical requests. Both arms kept a stable synthetic `user`; the no-key arm
removed only `prompt_cache_key` from the constructed payload.

| Request | With stable key: cached / input tokens | Without key: cached / input tokens |
| --- | --- | --- |
| First (cold) | 0 / 9,789 | 0 / 9,789 |
| Second | 9,786 / 9,789 (99.97%) | 9,786 / 9,789 (99.97%) |
| Third | 9,786 / 9,789 (99.97%) | 9,786 / 9,789 (99.97%) |

All six returned HTTP 200 and `OK`, with 5 output tokens each. The relay's
Responses-to-Claude translation preserved `cache_read_input_tokens: 9786` and
reported 3 uncached input tokens on the warm calls.

This confirms that Astra accepts the existing key and returns cache hits with it.
The no-key control also hit cache, so the experiment does **not** prove that Astra
requires the key or that it improves hit rates. Keep the stable key, but measure
real workloads: this short single-account run at `low` effort does not establish
behavior at `max`, under concurrency, after cache expiry, or near the 1M limit.

### Assistant `thinking` stays in upstream history

Cache hits depend on the prefix being byte-stable across turns. Claude Code
replays `thinking` blocks in assistant history, and the relay forwards them as
upstream assistant content.

Stripping `thinking` before forwarding would rewrite that prefix and *invalidate*
the cache. Measured on an 8-turn session above the cache threshold: forwarding
`thinking` held ~99% hit rate (130 full-price tokens per turn); stripping it
dropped to ~88% and ~1066 full-price tokens.

So `thinking` is kept in upstream history deliberately. It is part of what keeps
the prefix stable, not overhead to trim.

## Tokens

`github_token` is the long-lived login/refresh source.

`copilot_token.json` caches the short-lived Copilot bearer token and metadata:

```json
{
  "refreshedAt": 0,
  "refreshIn": 0,
  "token": "..."
}
```

On startup, the cached Copilot token is reused if it has more than 60 seconds
remaining; otherwise it is refreshed from `github_token`. Refresh timers must use
`unref()` so they do not keep short-lived commands alive.

Token values are never logged. Lifecycle logs carry paths and scheduling only.

## Lifecycle: status and stop ask different questions

`src/lib/lifecycle.ts` exposes two detection strategies, and **they must stay
different**:

| Command | Function | Strategy |
| --- | --- | --- |
| `status` | `findRelayOnPort` | pid file when its port matches, else the port-listener check. Never the global process scan. |
| `stop` | `findRelayProcessIds` | scans globally, because cleaning up strays on any port is the point. |

Do not "unify" these. Giving `status` the global scan makes it report a relay on
a port nothing is listening on (#33); scoping `stop` would leave strays behind.

Whatever `status` reports, **pid and address must come from the same record**.
Pairing a pid found one way with an address taken from another is how #33 printed
a live pid next to a dead port.

### Exit codes are a contract

| Code | Meaning |
| --- | --- |
| `0` | a live process **and** a passing health probe |
| `1` | no relay running |
| `2` | running but not usable — health probe failed, or `--deep` was requested and failed |

Printing `FAILED` while exiting `0` makes every scripted caller treat a broken
relay as fine (#34).

`--deep` additionally sends a real request through Copilot. It is the only check
that proves the relay can actually serve Claude Code, because `/healthz` and
`/v1/models` never contact upstream. It is opt-in because it spends a few tokens.

### Shutdown: `server.close()` alone does not shut down

`server.close()` waits for existing connections, and an idle Claude Code
keep-alive socket never finishes on its own. Shutdown therefore hangs until
`stop` escalates to `SIGKILL` — which skips pid-file cleanup and severs streams
anyway (#35).

The handler must call `closeIdleConnections()` immediately and
`closeAllConnections()` after a grace period **shorter than `stopProcess`'s 5s
timeout**. A grace period at or beyond that timeout reintroduces the bug.

## Logging invariants

Both were learned from a log that reached 9.3 GB.

### One entry, one physical line

`formatLogValue` in `src/lib/log.ts` needs *both* `compact: true` and
`breakLength: Infinity`.

The Node docs read as though the default `compact: 3` suffices — it does not.
The number counts inner elements united, not a threshold, so it only collapses
payloads nesting no deeper than that count. On a real 4-level error payload:

| Setting | Lines produced |
| --- | --- |
| `compact: 3` | 10 |
| `compact: 1` | 22 |
| `compact: true` | **1** |

`tests/unit/log-format.test.ts` pins this; do not "simplify" it away. Multi-line
dumps also break every `grep` recipe in
[Logs and troubleshooting](EN-Logging-Troubleshooting.md), because a search
returns the first fragment of a payload rather than the matching entry.

Payloads are bounded at depth 6, 100 array elements, and 4000 characters per
string. A value past those limits is truncated in the log, not dropped.

### Retention needs rotation

The active file is `copilot-relay.<local-date>.log`, resolved per write so it
rotates at local midnight with no timer.

Retention ages files by the **filename date**, falling back to mtime for undated
files. The filename is preferred because mtime is rewritten by backups, `cp`, and
editors touching a file — any of which would silently extend or shorten the
window.

Before rotation existed, retention aged one never-rotated file by mtime, every
append refreshed that mtime, and it was never once eligible for deletion.

Local date, not UTC: `logRetentionDays` is a human "how many days" setting, and a
UTC stamp would roll the file over in the middle of the local afternoon for
anyone west of Greenwich.

Log volume is bounded by time, not size. Accepted (#25).

### Redaction

`src/lib/redact.ts` is pure and covers URLs that may carry credentials in a path,
query string, or fragment. The log file is the one file users are asked to paste
into an issue (#47), so a gateway path that carries a token must not survive into
it. `copilotBaseUrl` validation rejects raw quotes, angle brackets, whitespace,
and control characters for the same reason: those characters mark the end of a
URL in a log line, so a value containing one could not be recognised as a whole
URL afterwards and its tail would print unredacted.

## Testing

```sh
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
```

### Home directory redirection

Any suite that touches the log or config path **must redirect the home directory
before importing** `src/`. `src/lib/paths.ts` resolves from `os.homedir()` at
import time, so the redirect only works with a dynamic `import()` performed after
the environment is set:

```ts
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { readAppConfig } = await import("../../src/lib/app-config")
```

Set **both `HOME` and `USERPROFILE`**. Node reads `USERPROFILE` on Windows and CI
runs `windows-latest`, so setting only `HOME` leaves the redirect silently
ineffective there. Without this the suite writes into the developer's live
`~/.copilot-relay/logs` on every run.

### Mocked upstream

Integration tests run the Hono app against a local mocked Copilot HTTP server.
They must never call the real service — not from CI, not locally.

### Structural documentation tests

`tests/unit/wiki-docs.test.ts` enforces the documentation contract itself: that
`wiki/` is flat, that every `EN-` page has a `ZH-` counterpart, that every
relative link resolves, and that the publish transform in
`.github/workflows/publish-wiki.yml` leaves no broken link on the wiki tab. It
reads files from disk and imports nothing from `src/`, so it needs no home
redirect.
