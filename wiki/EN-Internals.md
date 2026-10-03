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
  main.ts                     CLI entry (citty): auth, start, stop, restart, status, models, replay
  server.ts                   Hono app, request logging, health/root endpoints
  start.ts                    startup sequence and hot-reload wiring
  stop.ts                     process discovery and shutdown escalation
  restart.ts                  stop + start
  status.ts                   detection, health probe, --deep, --json, exit codes
  auth.ts                     GitHub device login command
  replay.ts                   replayCapture: validated offline current-handler replay

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
    models.ts                 provider-scoped model catalog and token limits
    endpoint.ts               catalog-driven endpoint choice and protocol policy
    responses.ts              Responses API translation, prompt_cache_key
    native.ts                 native Claude transport and signed WebSearch history
    stream.ts                 shared accumulation and complete-stream validation
    tool-schema.ts            Responses-only tool schema compatibility
    types.ts                  upstream payload types

  lib/
    app-config.ts             readAppConfig(), write-back, hot reload
    config.ts                 runtime proxy config and request policy snapshots
    atomic-file.ts            checked file snapshots and atomic replacement
    address.ts                listener/client URL normalization
    request-trace.ts          RequestTrace, ordered transport capture and outcomes
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
    upstream-dispatcher.ts    one undici dispatcher for Copilot and GitHub calls, upstreamProxy
    error.ts                  error shaping
    state.ts                  runtime state
    version.ts                build version
```

## Config resolution, write-back, and reload

`readAppConfig()` in `src/lib/app-config.ts` validates a flat scalar document,
resolves runtime values, then `materializeMissingKeys` appends **only absent keys**
to the original text. Comments, unknown scalar keys, ordering, quote spelling and
existing line endings survive. Duplicate canonical keys/aliases, unsupported YAML
and invalid known values fail before write-back; an empty required value is not
a missing key. Fresh/missing files use the package template (or legacy config).

`readFileSnapshot` / `writeFileSnapshot` in `src/lib/atomic-file.ts` resolve symlinks
without replacing them, retain file mode, write a private temporary file and
publish complete bytes atomically. Identity, target and content checks reject
observed concurrent edits; an initially absent file is published exclusively.
Cooperative writers serialize in process. This is **not an OS-wide compare-and-swap
rename**: an external writer can still race the final check and replacement.
`applyClaudeConfig` shares this boundary, preserves unrelated settings and refuses
malformed or already-empty JSON rather than overwriting it.
A read whose only inconsistent identity field is `ctime` may be reacquired
immediately, with at most three total attempts. Each retry must reproduce the
first read's bytes, target, mode and other identity fields; other changes and
persistent inconsistency fail closed. Publication checks may reacquire a read,
but still compare its full identity (including `ctime`) against the caller's
original snapshot. Stale writes are never retried.

> Once a key is materialized, its saved value wins over a new shipped default.

No default migration is added. A user's pin belongs to the user; the old
`configVersion` migration machinery was removed in #26 for that reason.

### Hot reload vs restart

Hot-reloaded — applies to work that starts after the change:

`logLevel`, `logRetentionDays`, `thinkEffort`, `upstreamTimeoutSeconds`,
`copilotBaseUrl`, `webSearchBackend`, `claudeUpstreamApi`, `gptModel`, `opusModel`

Requires restart:

`host`, `port`, `claudeSetup`, `upstreamProxy`

`host` and `port` cannot move because the listening socket is already bound.
`claudeSetup` is read once during startup, so toggling it changes nothing until
the relay starts again. `upstreamProxy` builds the upstream dispatcher once,
before the first upstream call, and a reload never rebuilds it (see
[Outbound proxy](#outbound-proxy)). Changing `gptModel` reroutes upstream requests
immediately but does not rewrite the model already saved in
`~/.claude/settings.json` — that is written at startup.

A reload logs what it applied:

```text
info Config reloaded: logLevel=debug thinkEffort=xhigh upstreamTimeoutSeconds=180
```

`ConfiguredReasoningEffort` and `configurableReasoningEfforts` keep the allowed
fallback choices separate from request-level `ReasoningEffort`. `normalizeThinkEffort`
rejects `none` and malformed explicit defaults before config write-back or auth;
`startRelay` also validates programmatically supplied defaults. Missing keys alone
use the shipped default. Invalid reloads log their reason once and retain active
settings. Validation messages name a key, a line or a rule and never repeat a
value, because a value typed under the wrong key can be a credential.

`watchAppConfig` is read-only: every known materialized key, even the optional
empty search backend, must be present. Empty/partial saves do not reinstate
defaults. It verifies a second snapshot before application and does not mark a
failed read/application as accepted, so correction can be retried. Each tick
retries, but a failure is logged once per pair of file snapshot and reason
(`isSameFailure`). A successful reload, or a clean read of the applied file,
clears that record. A save that lands while the file is read or verified is not
a failure (`readConfigSnapshot`): the next tick reads the newer file. A path
that is not a regular file (`NotRegularFileError`) is a failure like any other,
and so is any error thrown while applying a reload.

Adding a key means updating `config.default.yaml`, the README, and
[Configuration](EN-Configuration.md) in both languages.

## Request translation

### Admission and request policy

`src/server.ts` checks Host/authority, supplied Origin, the optional `apiKey`, and
JSON content type before inference, in that order. Host/authority, Origin and
content type are browser-origin/local request checks, **not authentication**;
without `apiKey`, a reachable non-loopback listener is not protected by the dummy
Claude token.

`apiKey` is read from the live `ProxyConfig` on every request, so a hot reload
applies to the next one. `isOpenProbe` exempts `GET /healthz` and
`GET`/`HEAD /api/hello`; every other route, unknown ones included, needs the key.
`presentsApiKey` hashes the configured key and each presented value, `x-api-key`
and the `Authorization: Bearer` token, with SHA-256 and compares the fixed-length
digests with `timingSafeEqual`, which never stops at the first byte that differs. A
refusal is HTTP `401` `authentication_error` with `WWW-Authenticate: Bearer`,
returned before the body is read and before the unknown-route handler can log a
payload; it never echoes the presented value. `applyRuntimeConfig` in
`src/start.ts` registers the key with `registerLogSecret` at startup and on every
reload, and `status` and `models` register it before they use it. `RequestTrace`
keeps it out of the headers a capture records, whichever header carried it, but
captured body files are unredacted by design, so a key that a client puts in a
prompt is stored there. `toStatusConfig` shows the key as `[redacted]`. In
`copilot-relay models`, `printable` in `src/models.ts` replaces the key in every
model, config and search string before a row is shortened or padded, `safeId` in
`src/lib/model-probe.ts` keeps an ID that holds it from being probed or printed,
and both paths scrub each printed line again. While Claude Code's settings hold
the key, `applyClaudeConfig` publishes them owner-only through the `ownerOnly`
option of `writeFileSnapshot`.

Before consuming a POST body, `snapshotProxyConfig` in `src/lib/config.ts` and
`snapshotRuntimeState` / `withRuntimeState` in `src/lib/state.ts` freeze routing,
base URL, timeout, protocol mode, search backend, effort and catalog view for the
request. Subsequent async passes use that request scope rather than mutable
process globals. Token and generation getters deliberately stay live so retries
see refreshed credentials. Discovery needed for that snapshot's provider can
update its own catalog without switching the turn to newly reloaded policy.
After admission discovery, `pinCopilotModelCatalog` fixes that catalog reference
for all passes, even if the target was absent from discovery. Output bounding
cannot rediscover and change capabilities after SSE starts; token counting remains
local and never pins or refreshes the inference catalog.

### Claude Code's billing line

Claude Code puts a billing attribution line first in the top-level system prompt:

```text
x-anthropic-billing-header: cc_version=2.1.288.976; cc_entrypoint=sdk-cli;
```

It is metadata for Anthropic's API, not an instruction to the model.
`removeBillingLine` in `src/claude/billing-line.ts` removes it when `POST /v1/messages`
and `POST /v1/messages/count_tokens` parse the body, so every route and the local
token count see the same system prompt. It removes only a line that opens a system
block, or a string `system`, with `x-anthropic-billing-header:`, and the blank lines
after it. A block with no other text is dropped; the other blocks keep their
`cache_control` and the rest of their text. A later mention of the header is ordinary
text. The relay never logs the line.

Before #157, the chat route joined the line into the one system message that
`handleSystemPrompt` builds. With `claude-haiku-4.5` and `claude-opus-5.5`, Copilot's
`/chat/completions` returned HTTP 200, but the model did not return a secret word from
that message, and the token counts were consistent with Copilot omitting the whole
message, Claude Code's instructions included. On a relay without this fix,
`CLAUDE_CODE_ATTRIBUTION_HEADER=0` in Claude Code's environment stops Claude Code from
sending the line.

### Translated history

`src/claude/translate.ts` handles non-streaming payloads in both directions:
Claude request -> Copilot chat request, and Copilot response -> Claude response.
It maps tool calls and thinking/text blocks between the two protocol shapes.
In-message system text keeps its original position, including after tool results; it
must not become assistant speech or acquire an assistant continuation prompt. It stays
`role: system`, except when the resolved upstream model is a Claude model sent to
`/chat/completions` with no `/responses` fallback: there it becomes a `role: user` turn holding
`<system-reminder>…</system-reminder>`, because a changing system turn stops Copilot's chat
route from caching the history after it (see "Chat route: system turns and cache
breakpoints" under Prompt caching). `validateClaudeMessages` accepts translated system controls
only when `output_config` has exactly one key, `effort`, with a value of `low`,
`medium`, `high`, `xhigh`, or `max`. Different historical values are valid.
`isEffortOnlyControl` in `src/claude/utils.ts` is shared by validation and effort
selection so accepted switches cannot silently disappear.

Upstream tool-call `arguments` become Claude `tool_use.input` through
`parseUpstreamToolInput` in `src/claude/utils.ts`, shared by `translateToClaude`
and the streaming `translateChunkToClaudeEvents`. Copilot sends an empty string,
not `{}`, for tools that take no parameters, so blank or whitespace-only text is
the empty object; the stream then emits `partial_json: "{}"`, because clients
parse the accumulated text and `""` is not a JSON object. Non-empty text that is
not a JSON object raises `UpstreamToolInputError`: HTTP 502 `api_error` on the
non-streaming path, and the same message in the SSE `error` event when streaming.
The message names the tool and never echoes the argument text, which can carry
user data. Other streaming failures keep the generic error message, except a
prompt over the model's input limit (see "Prompt over the input limit" below).

`getClaudeTurnEffort` first validates the initial top-level request effort, then
walks messages without mutation. A valid system effort marker is pending until a
subsequent `role: user` message, including a tool-result-only message, activates
it. The last active value wins; a marker after the latest user stays pending.
Translation retains system text and order, consumes empty effort-only messages
without inserting empty system prompts, and maps the current effort into the
upstream request field. Appending a switch does not rewrite the translated prefix
or insert a control between a tool call and its result.

Additional/unknown keys, null/array controls, inline `none`, and any `clear_at`
remain rejected on translated paths. Unknown roles and malformed system text
are rejected too. Admission validates before inference or SSE, returning HTTP 400
JSON even with `stream: true`; `translateToOpenAI` repeats validation for direct
callers and token counting. Native messages retain their initial setting and
per-message controls for upstream to evaluate. The helper ignores controls it
cannot interpret on that path rather than rewriting them for diagnostics.

`src/claude/tool-names.ts` normalizes Claude tool names into Copilot-compatible
names on the way out and maps them back on the way in. Claude Code's tool names
are not always valid upstream identifiers, and a response carrying the normalized
name would not match the tool the client registered.

`getRequestReasoningEffort` and `resolveReasoningEffort` in `src/lib/models.ts`
retain their initial-field precedence and configured fallback. The Claude-specific
helper resolves active inline controls before translation freezes effort in the
chat payload. Chat/Responses, requested/effective logs, and WebSearch retrieval use
that current value; the translated final-answer payload inherits it. Request-scoped
runtime snapshots prevent config reload from changing a pass's fallback.
Native requests keep their original controls; diagnostics and search retrieval use
normalized outgoing history, including restored user tool-result turns. A native
follow-up can activate a pending marker by appending a user tool result. Invalid initial effort
still fails even when a later marker is valid. See [Configuration](EN-Configuration.md).

Stable translated text prefixes and Responses cache keys are regression invariants,
not a guarantee of unchanged cache hit rates: translated APIs express effort at
request level, which can reset upstream caching. Native per-message controls are
left intact for the provider's cache-preserving semantics.

`src/claude/types.ts` defines only the subset of Claude Messages API types the
proxy needs. It is intentionally not a full Claude SDK — an unused type is a
maintenance cost with no test covering it.

## Native Messages, chat and Responses

`src/copilot/chat.ts` sends already-resolved upstream IDs for routes and startup
preflight. `selectCopilotEndpoint` in `src/copilot/endpoint.ts` reads the current
provider's `supported_endpoints` through `getCachedCopilotModel`; probes and normal
requests share it. The frozen legacy preference breaks ties and handles missing
metadata, not an expanding allowlist. Its one later entry is `gpt-5.4` (not
`gpt-5.4-mini`): Copilot's `/chat/completions` answers its tool-bearing requests with
HTTP 400, while `/responses` accepts them. `requireCopilotEndpoint` turns fixed
unsupported reasons into local errors at admission before SSE. Claude's explicit
protocol policy takes precedence; the selection includes whether the narrowly
coded `/chat/completions` to `/responses` recovery is allowed. Failed recovered
bodies are marked discarded and cancelled so capture/replay records the same
exchange order.

`resolveModelReasoningEffort` in `src/copilot/models.ts` distinguishes an explicit
request from a configured default. `translateToOpenAI` carries
`getClaudeTurnEffort().requested`; the adapter resolves once, and neither the Chat
nor Responses builder reinstates a deliberately omitted value. In
`parseReasoningEfforts`, catalog `reasoning_effort: false` and a `supports` object
without the key both become `reasoningEfforts: []`; a missing `supports` object and
malformed endpoint/tier arrays stay unknown instead of being filtered into
authoritative empty arrays.
These existing array fields round-trip through capture/replay without a new format.
The probe's `route_source` and allowlisted endpoint details expose this decision
without printing raw metadata. See [Configuration](EN-Configuration.md) for policy.

`src/copilot/responses.ts` translates between the Copilot Responses API and
chat-completion-like results for any selected compatible model. Retrieval remains
a distinct Responses `web_search_preview` operation; decision/final passes use
the shared adapters, but a chat-only search backend produces a structured failed
search instead of ordinary chat masquerading as retrieval. Missing capabilities
remain unverified, not proof of built-in search support.

### Native Claude boundary

`shouldUseNativeMessages` in `src/copilot/native.ts` applies only to routed IDs
starting with `claude-`. `auto` requires advertised `/v1/messages` support from
the current provider's catalog, `messages` forces native, and `chat-completions`
pins Chat translation. The last is still the default; non-Claude models use the
catalog-driven translated selector regardless of this Claude-only setting.

`createNativeMessages` preserves message/block structure, signed thinking and
redacted-thinking blocks, cache markers, in-place system roles/controls and native
response metadata instead of flattening them through chat. It still routes the
model, bounds output, resolves effort, and adapts the relay's WebSearch declaration.
Protocol headers are explicit (`anthropic-version`, optional `anthropic-beta`);
upstream authentication uses the shared Copilot client, not client auth headers.
Above a native non-streaming ceiling it requests SSE and collects a JSON result.
`nativeEvents` / `collectNative` retain signatures and trailing usage and require
a stop reason plus `message_stop` for SSE. An error or premature EOF cannot become
success. Native errors/refusals are not retried on another API to bypass them.

`probeModels` in `src/lib/model-probe.ts` compares the returned model with
the exact catalog selection through `reportsSelectedModel`. Beyond existing GPT
context-suffix normalization, it accepts only these observed provider behaviors:

- Native spelling: endpoint `/v1/messages`, selected `claude-opus-5.5`, reported
  `claude-opus-5-5`.
- Priority tier: endpoint `/responses`, selected `gpt-5.6-sol-fast`, reported
  `gpt-5.6-sol`. The catalog names that entry "GPT-5.6 Sol Fast", and a live reply
  reported `model: gpt-5.6-sol` with `service_tier: priority`.
- Dated snapshot: an undated selected ID reported with one `-YYYY-MM-DD` date
  appended, as live replies reported `gpt-5.5-2026-04-23` for `gpt-5.5` and
  `gpt-4o-2024-11-20` for `gpt-4o`. A dated selection must match exactly.

None is general punctuation normalization, `-fast` or suffix stripping, or a new
catalog alias. `claude-opus-5-5-preview`, `claude-opus-5`, `gpt-6-sol-fast`
reported as `gpt-6-sol`, `gpt-5.5-preview`, and aliases that upstream serves with
another model (`gpt-4` and `gpt-4o-2024-05-13` both reported `gpt-4.1-2025-04-14`)
still fail. Config and discovery keep the catalog ID, while `SENT/REPORTED` retains
both actual spellings. Acceptance still requires the usual completed-text/terminal
checks; a refusal cannot become `PASS` merely because the model matches.

An upstream HTTP 400 with code `model_not_supported` becomes its own
`Model not supported` result, apart from payload rejections. `trajectory-compaction`
is listed in the catalog yet answers that way.

The implicit probe effort is the lowest advertised tier above `none`. `none` is
probed only when it is the sole advertised tier: the relay never sends it on its
own, and `gpt-6.1-sol` advertises it yet rejects it with HTTP 400
`invalid_request_body`. An explicit `--effort none` is still sent as asked.

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
Responses. Normalization is copy-on-write: a schema that needs no change is sent
as the same object, and an omitted pattern copies only the objects on its path, so
a long tool list is not rebuilt for every request.

`translateTools` in `src/copilot/responses.ts` also sets `strict: false` on every
Responses function tool. Omitting it lets upstream normalize compatible schemas
into strict mode, which can make optional properties required. Explicit non-strict
mode preserves optional `Agent.isolation`, `Read.pages`, and nested properties
without injecting nulls or defaults. Returned arguments are not stripped or
rewritten. This setting does not apply to built-in `web_search_preview` or to
`/chat/completions` tools.

### Images in tool results

Claude Code returns an image from a tool, such as `Read` opening a PNG, as an `image`
block inside a `tool_result`. `mapContent` and `handleUserMessage` in
`src/claude/translate.ts` turn it into a `role: "tool"` message whose content holds
`image_url` parts. Each route then puts the image where its models read it (#150):

- **`/responses`.** gpt-6-astra, gpt-5.4 and gpt-5.5 read a tool's image as an
  `input_image` item inside `function_call_output.output`. `stringifyToolOutput` keeps
  only the text parts, or sends the whole result as JSON text when it has none: the image
  is dropped, or arrives as base64 text. `translateToolOutput` in
  `src/copilot/responses.ts` therefore sends a tool message that holds an image as an
  array of `input_text` and `input_image` items, in their original order.
  `translateToolOutputPart` leaves out an empty text part and gives an `input_image`
  item no `detail`: a Claude image block has none, and the shape verified in #150 had
  none. caozhiyuan/copilot-api issues 361 and 362 report that Copilot rejects, in tool
  output, a `detail` other than `low` or `high`, and an empty text part. Every other
  tool message keeps the plain `stringifyToolOutput` string, so an existing history
  sends the same bytes and keeps its prompt-cache prefix. The
  `unsupported_api_for_model` retry from `/chat/completions` resends the unadapted
  payload and takes the same path.
- **`/chat/completions`, non-Claude models.** Copilot accepts `image_url` parts in a tool
  message, but in #150 gpt-5-mini replied `NO IMAGE` and gemini-3.8-flash named colors
  it never saw. Both read the same image when it followed in a user message.
  `moveToolImagesToUserMessages` in `src/copilot/chat.ts` runs before
  `normalizeFinalAssistantPrefill`. In each run of consecutive tool messages, a tool
  message that holds images keeps only its text parts, joined with blank lines like
  text-only tool content, or the fixed note
  `Image output follows in the next user message.` when it has none. Its images move to
  the start of the user message that follows the run, or to a new user message inserted
  after the run, each call's images led by `Image output of tool call <id>:`. A tool
  message without an image is left as it is. A payload with no tool-message images is
  returned unchanged.
- **`/chat/completions`, Claude models.** When `isClaudeModelId` matches the upstream
  model, the payload keeps its shape: claude-opus-5.5 read the image inside the tool
  message in #150, and the `copilot_cache_control` marks described in "Chat route:
  system turns and cache breakpoints" under Prompt caching are placed on that shape.

`messagesIncludeImage` in `src/copilot/chat.ts` inspects the payload actually sent, so a
request whose images moved still carries `copilot-vision-request: true`; the
`/responses` retry checks the payload it resends. The native `/v1/messages` route sends
Claude's own blocks and uses none of these adapters.

### Upstream connections

`fetchCopilot` in `src/copilot/client.ts` and the GitHub calls in `src/lib/auth.ts`
send every upstream request through `fetchUpstream` in
`src/lib/upstream-dispatcher.ts`, which uses the process's one upstream undici
dispatcher, limited to HTTP/1.1. Copilot sends no `Keep-Alive` hint, so undici's
4-second default closed every connection idle for longer, and the next request
paid for a new TCP and TLS handshake. In #141 Copilot reused a connection idle for
60 seconds and had closed one idle for 120 seconds; the dispatcher keeps idle
connections for 50 seconds, through a proxy too.

`package.json` requires undici 7.30 or later. undici 7.28 checked an idle socket
with an unref'd zero-delay timer before reusing it, and on Windows that timer can
wait for the next system timer tick. `tests/unit/copilot-client.test.ts` covers
both.

Keeping idle connections longer has a cost. Before undici writes a request to an
idle connection, it processes any FIN or RST already received on it, so a
connection Copilot closed is not reused. A connection that a NAT or proxy between
the relay and Copilot drops without sending either still looks open. If the
request written to it gets a reset back, `fetchCopilot` retries it once, as it
retries any failed fetch that was not aborted. If nothing comes back, the request
fails when the operating system gives up on the connection, which is also retried
once, or when the `upstreamTimeoutSeconds` deadline passes first, which fails with
a 504 that is not retried. With the 4-second default, only a NAT or proxy that
drops connections idle for less than 4 seconds could cause this; now one that
drops them within 50 seconds can.

### Prompt over the input limit

Copilot answers a prompt over the model's `max_prompt_tokens` with HTTP 400 on
both `/chat/completions` and `/responses`:

```json
{"error":{"message":"prompt token count of 131008 exceeds the limit of 128000","code":"model_max_prompt_tokens_exceeded"}}
```

On `/v1/messages`, Copilot also answered with HTTP 400, but with Anthropic's
envelope and wording plus its own code. `>` arrived escaped as `\u003e`; the
request id here is a placeholder:

```json
{"error":{"code":"model_max_prompt_tokens_exceeded","message":"prompt is too long: 230024 tokens \u003e 200000 maximum","type":"invalid_request_error"},"request_id":"req_placeholder","type":"error"}
```

For `claude-haiku-4.5`, Copilot named a limit of 200000 on `/v1/messages`, while
`/chat/completions` enforced the catalog's 136000.

Claude Code 2.1.288 recognizes an overflow by the text `prompt is too long` or
`input is too long for requested model`, and reads the two counts with
`prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)`. The wording on
`/chat/completions` and `/responses` matches neither.

`toPromptTooLongError` in `src/copilot/client.ts` recognizes the rejection where a
failed upstream response becomes an error: `logUpstreamError` in
`src/copilot/chat.ts` for `/chat/completions` and `/responses`, and
`createNativeMessages` in `src/copilot/native.ts` for `/v1/messages`. It requires
HTTP 400 and a JSON body whose `error.code` is `model_max_prompt_tokens_exceeded`,
or Anthropic's own `invalid_request_error` envelope whose message starts with
`prompt is too long`. It reads only the two counts, with anchored patterns, and
returns `PromptTooLongError` from `src/lib/error.ts`: an `HTTPError` whose body is
what Anthropic's API sends.

```json
{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 131008 tokens > 128000 maximum"}}
```

When the counts cannot be read, the message is `prompt is too long`. No other
upstream text reaches the client, so a recognized native body is rebuilt rather
than passed on; the upstream wording stays in the error's `detail`, which only the
logs show.

A JSON request gets that body with HTTP 400. A streaming request already has
HTTP 200: after admission and any catalog lookup, the inference call runs inside
the open SSE response, so a slow upstream cannot hold back the response headers
(the delayed-upstream streaming test in `tests/integration/claude-routes.test.ts`
pins this). `translateErrorToClaudeErrorEvent` in `src/claude/stream.ts` sends the
same type and message as the SSE `error` event; the route appends
` (request_id=<id>)`, which the count pattern does not read. Claude Code 2.1.288
acts on the message, not the HTTP status: its SDK turns an SSE `error` event into
an error whose message is the event's JSON, and its overflow check reads only that
message. A turn it retries without streaming gets the HTTP 400 above.

Every other upstream error keeps its handling: a JSON request gets the upstream
body and status, and a stream gets the generic message or
`UpstreamToolInputError`'s own. An `error` event inside a native stream that has
already started is not inspected. Coverage lives in
`tests/unit/prompt-too-long.test.ts` and the #158 tests in
`tests/integration/claude-routes.test.ts`.

### Outbound proxy

`buildUpstreamDispatcher` turns the resolved `upstreamProxy` into one of three
undici dispatchers, all with the same HTTP/1.1 and keep-alive options:

| `upstreamProxy` | Dispatcher |
| --- | --- |
| empty | `Agent`: direct, as in every release before #153 |
| `env` | `EnvHttpProxyAgent`: `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` |
| a URL | `ProxyAgent` for that proxy |

`configureUpstreamDispatcher` builds it once per process, after the config is read
and before the first upstream call: in `startRelay`, and in the `auth`, `models`
and `usage` commands. `applyRuntimeConfig` never calls it, which is why
`upstreamProxy`, like `host` and `port`, takes effect on restart. It is never
undici's global dispatcher. The `status` probes call the relay's own listener
through `relayListener` in `src/status.ts`: undici's `fetch` with a direct `Agent`
of their own, neither this dispatcher nor the global one. With
`NODE_USE_ENV_PROXY=1`, Node's own `fetch` sends even a request to localhost
through `HTTP_PROXY` unless `NO_PROXY` exempts it, and through a proxy that
refuses, `status` would report a healthy relay as unusable.

`usage` writes no file, so `loadCopilotUsage` in `src/lib/usage.ts` reads the
config with `readExistingAppConfig` rather than `readAppConfig`, which creates or
completes `config.yaml`. It resolves an existing file without rewriting it and
returns nothing when there is none, so the request then connects directly. The
command runs under `withoutLogging`, so a line the request would log never reaches
the log file.

`EnvHttpProxyAgent` reads the proxy variables when it is built, the lower-case
spelling first, and uses `HTTP_PROXY` for HTTPS targets when `HTTPS_PROXY` is
unset. It checks `NO_PROXY` on each request. For a malformed variable undici
throws an error that repeats the value, so `buildUpstreamDispatcher` replaces it
with one that names the variables and the rule.

`ProxyAgent` tunnels with `CONNECT`, for HTTP targets too, and sends a `Basic`
`Proxy-Authorization` only when the URL has both a user name and a password. It
rejects a proxy URL with a path, query or fragment, and a credential with a
malformed percent-escape fails when it is decoded. `normalizeUpstreamProxy` in
`src/lib/app-config.ts` applies those rules to the URL in `config.yaml` when the
config is read, so the error comes at startup and never repeats the value. The
proxy variables that `env` uses do not go through it: only undici's own checks
apply when `buildUpstreamDispatcher` builds the `EnvHttpProxyAgent`, and they
accept a user name without a password. `formatUpstreamProxyForDisplay` in
`src/lib/redact.ts` shows only the proxy's origin in `status` and the startup log.

`configureUpstreamDispatcher` registers the credentials of each proxy URL the
dispatcher can use, the one in `config.yaml` or each proxy variable that
`EnvHttpProxyAgent` reads, with `registerLogSecret`: `user:password` as written
and decoded, and the `Basic` value undici sends, each when it is at least 8
characters long. It never registers a user name or password alone.
`registerLogSecret` replaces a value in every log line, so a short or common one
would cut ordinary text: a user name `copilot` would turn `copilot-relay` into
`[redacted]-relay`, and a user name `a` would break the `completion path=` entries
that `copilot-relay cache` reads. A config reload registers nothing, because it
never rebuilds the dispatcher.

`fetchUpstream` cleans the error of a request that fails without a response in
place, before it rethrows it (`sanitizeTransportError`). Anywhere in the cause
chain it drops `data` and `body`, where undici keeps raw bytes from the peer:
`HTTPParserError` keeps the unparsed rest of a reply, so a proxy that answers
`CONNECT` with a malformed reply that echoes `Proxy-Authorization` would carry
the password into every log line that prints the error. It also replaces every
form of the active proxy's credentials, short ones and a user name or password
alone included, in each message and in the head of each stack: only this one
error changes. The error keeps its type, `code` and `cause`, which callers read,
such as `failureReason` in `src/lib/usage.ts`.

When an upstream request fails without a response while `upstreamProxy` is empty
and `HTTPS_PROXY` or `HTTP_PROXY` is set, `fetchUpstream` logs once per process
that the variable was not used and how to opt in. A failure under
`withoutLogging`, such as a `models --deep` probe, writes nothing and leaves the
hint for a later failure. The default is not `env`:
`readAppConfig` writes every key back to disk, so an `env` default would reroute an
existing install that sets those variables for other tools.
`tests/integration/upstream-proxy.test.ts` runs each mode against a local
recording proxy.

## Streaming

### Long context and output budgets

`loadCopilotModelCatalog` in `src/copilot/models.ts` retains the catalog read
during preflight. Limits remain scoped to the exact upstream base URL; a change
refreshes discovery before using a budget, concurrent refreshes share one request,
and an older response cannot overwrite a newer provider's catalog. Missing or
invalid limit metadata is not converted into a guessed capacity.

`boundModelOutputTokens` caps a request at its routed model's advertised output
maximum without increasing an explicit smaller budget. Preflight and deep-health
requests keep their 16-token budgets. Prompt content is never sliced to fit.
`count_tokens` uses a supported discovered tokenizer when available and skips the old
Claude-family 15% padding in that case, so a reported tokenizer does not still
force premature compaction through a model-name heuristic. Local model discovery
returns cached limits and makes no upstream call.

After preflight, `start` loads `o200k_base`, the fallback, and each supported
tokenizer the configured models report before it listens, so the first
`count_tokens` request does not wait for an encoder to be built. A model swapped
in by hot reload loads its tokenizer on first use.

`src/lib/tokenizer.ts` assigns **4096 advisory tokens per image** before any
text encoder call. It never tokenizes base64/URL text, decodes an image or fetches
its URL. Text still uses the selected tokenizer; other message/tool heuristics
and any legacy padding still apply. This fixed image allowance is a UI budget
estimate, **not provider billing** or evidence a multimodal prompt will fit.

Some models advertise a lower `max_non_streaming_output_tokens` than their
streaming ceiling. `createChatCompletions` requests upstream SSE above that
threshold, then `collectChatCompletionStream` returns a completed chat response
for JSON callers and WebSearch final passes. It reuses the WebSearch accumulator,
preserves usage, reasoning, tool fragments and `length` termination, and refuses
an incomplete stream rather than synthesizing success. Ordinary streaming
callers still receive chunks as they arrive.

Managed Claude budgets, model-selector handling, and the opt-in unlimited relay
deadline are described in [Configuration](EN-Configuration.md). Boundary tests in
`tests/integration/model-text-limits.test.ts` preserve tokenizer-measured prompts
of 872K/936K tokens and outputs of 128K/64K through both response modes, with a
mocked upstream and no paid million-token generation.

### Claude SSE translation

`src/claude/stream.ts` converts streaming Copilot chat chunks into Claude SSE
events. It is a state machine because Claude requires explicit content block
start/delta/stop events in the correct order for text, thinking, and tool use —
a Copilot chunk stream carries no such framing.

Terminal status and usage are distinct: output exhaustion maps to `max_tokens`,
filter/refusal stays a refusal, failed/cancelled Responses terminals surface as
errors, and late usage must not erase a terminal reason. Interleaved tool-argument
fragments must never target a closed Claude content block. Regression coverage
lives in `tests/unit/stream-terminals.test.ts` and `tests/unit/native-messages.test.ts`.

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

### Native WebSearch history

`handleNativeMessages` keeps retrieval on Copilot Responses while the conversation
stays native Claude. Native bridge search supports automatic selection only:
`validateNativeMessages` rejects forced `any` with WebSearch advertised, an
explicitly forced search, or unrecognized bridge history with HTTP 400 JSON before
upstream work/SSE, even for streaming callers. At most one search executes per turn; multiple or repeated search
calls fail rather than looping. Text/thinking can stream before a decision; tool
blocks are held until the relay knows whether it must execute a server search.

The decision's signed blocks and original provider tool ID/name are preserved in
the continuation sent upstream. For the client, the relay replaces only the search
call with `server_tool_use`, followed by `web_search_tool_result`. A deterministic
`srvtoolu_relay_` marker encodes the original tool ID/name and block/turn boundary.
`normalizeNativeHistory` decodes and validates it to reconstruct the exact decision,
a user tool-result turn, and any final assistant blocks on the next request.
The marker is **not a provider signature**; no thinking signature is invented or
rewritten. Search data is explicitly untrusted. Sibling client tool calls retain
their IDs and are handed back to the client rather than executed by the relay.

Unrecognized old chat-bridge search history is rejected on native, not silently
flattened. Switching protocols is not a transparent migration of an existing
search conversation. Tests pin reconstruction, not live cache performance or the
cause of any historical refusal.

## Prompt caching

Long Claude Code sessions resend a large, mostly-stable prefix (system prompt,
tool definitions, prior turns) every request. Prompt cache hits on that prefix
are the main lever for input-token cost and latency. Keep the earlier translated
chat/Responses measurements separate from the bounded 2026-09-30 native comparison
below; neither establishes behavior for every account or workload.

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
the prefix stable, not overhead to trim. On the translated path this is flattened
assistant content, not preservation of a provider-signed native block.

### Opus 5.5 matched cache trial (2026-09-30)

A bounded live comparison used `low` effort, the same synthetic 720-reference-record
format, independent prefix markers per route, and three append-only conversation
turns on each route. The completed trial reported:

| Chat turn | Total input tokens | Cache-read tokens | Output tokens |
| --- | ---: | ---: | ---: |
| 1 (cold) | 25,960 | 0 | 4 |
| 2 | 25,981 | 25,939 | 4 |
| 3 | 26,002 | 25,960 | 4 |

| Native turn | Noncached `input_tokens` | Cache-write tokens | Cache-read tokens | Output tokens |
| --- | ---: | ---: | ---: | ---: |
| 1 (cold) | 21 | 25,936 | 0 | 4 |
| 2 | 42 | 0 | 25,936 | 4 |
| 3 | 63 | 0 | 25,936 | 4 |

Native input accounting is additive: noncached `input_tokens` plus
`cache_creation_input_tokens` plus `cache_read_input_tokens`. Chat total input
already includes cached input. Do not divide native cache reads by its noncached
`input_tokens`, or compare those fields alone across APIs.

For warm turns 2–3, the token-weighted cache-read fractions were:

- Chat: `(25,939 + 25,960) / (25,981 + 26,002)` = **99.8384%**.
- Native: `(25,936 + 25,936) / ((42 + 0 + 25,936) + (63 + 0 + 25,936))` = **99.7980%**.

The native fraction was about **0.04 percentage points lower** in this completed
trial. A second, counterbalanced trial began with native; its first cold request
returned a refusal and the trial was stopped. That interruption is part of the
result, not an omitted successful control or evidence of a completed repeat.

These small `low`-effort observations show warm cache reuse in the tested sequence,
not broad non-regression across effort, concurrency, cache expiry, long sessions
or near-limit prompts. **Billing-cost equivalence is unavailable**: native reports
cold cache writes explicitly, while chat does not expose an equivalent category.
Keep `claudeUpstreamApi: chat-completions` as the default; the evidence does not
justify promotion. Preserving signed history is a correctness requirement, but
reasoning flattening is still not proven to have caused the historical refusal.

### Isolated Claude Code checks (2026-09-30)

Real Claude Code **2.1.285** completed a native `Read` → tool result → `OK`
sequence over two model turns. Its first two requests received HTTP 400 for the
unsupported `safeguards` field, after which the **client** downgraded its own
request. The relay did not strip `safeguards`, add a refusal fallback, or bypass
provider safety controls. This proves only that observed client/tool continuation,
not general support for the rejected field or every Claude Code feature.

The warmed second turn's cache-read fraction over all reported input categories
was `3029 / (3029 + 146 + 2)` = **95.34%**. That is a separate workload from the
synthetic comparison and must not be pooled into its warm rate.

A separate real CLI run on the chat route also completed two tool turns and
returned `OK` after the redundant-inline-effort fix. The independent client runs
therefore exercised both protocols successfully, but were **not a matched cache
comparison**. The validation session used 18 of its 20 allotted requests and its
HOME-state hash was unchanged; those operational checks do not establish general
client compatibility or production readiness.

Full raw observed bodies were captured privately; recorded success and refusal
cases both returned offline `MATCH` through the current-handler replay. A matching
refusal is still a refusal, and replay is not a fresh upstream validation. These
were isolated checks, **not validation of the current production relay**; the
production listener on port 4142 was untouched. Only aggregate evidence belongs
here, never the private capture bodies or credentials.

### Chat route: system turns and cache breakpoints

Claude Code 2.1.288 sends a mid-conversation `role: "system"` message on every request (its
per-turn token reminder), and that message carries the newest `cache_control` breakpoint. The
system prompt carries two more breakpoints; tool definitions carry none. v0.4.4 forwarded the
message in place as a chat `system` message. On 2026-10-03, isolated test relays measured
claude-opus-5.5 over five sequential tool turns, with cache reads as a share of total input:

| Reminder message on the chat route | Request 2 | Request 5 | Cache reads, requests 2–5 |
| --- | ---: | ---: | --- |
| None | 97.68% | 98.39% | 29,242 → 30,904 |
| `role: "system"` on every request (v0.4.4) | 97.54% | 92.78% | 29,242 on every request |
| `role: "system"` on request 1 only | 98.30% | 98.39% | 29,446 → 30,924 |
| `role: "user"` on every request | 98.19% | 98.27% | 29,430 → 30,982 |

Real Claude Code on v0.4.4 showed the same cap: three rounds of 14 parallel `Read` calls read
18,444 tokens from cache on every warm request while total input grew from 25,177 to 28,457.
A new system turn on each request caps cache reads at the tools plus the original system
prompt; one system turn at the start does not. That fits Copilot folding chat `system`
messages into Claude's system prompt, which then changes in front of the history. It is an
inference from cache sizes, not an observed upstream request.

When the resolved upstream model is a Claude model and `selectCopilotEndpoint` picks
`/chat/completions` with no `/responses` fallback, `translateClaudeMessagesToOpenAI` therefore
sends each mid-conversation system message as a `role: "user"` turn holding
`<system-reminder>…</system-reminder>` in its original position, the form Claude Code uses for
most harness context. `translationEndpoint` in `src/routes/claude.ts` passes that endpoint to
`translateToOpenAI` for both requests and token counts. It passes none when
`createChatCompletions` may retry an `unsupported_api_for_model` failure on `/responses`,
because the retry resends the same translated payload. That happens only in `auto` mode, for a
Claude model with no endpoint metadata in the model catalog, or whose catalog entry lists
`/chat/completions` and `/responses` but not `/v1/messages`. Those requests keep
`role: "system"` and carry no cache marks, as in v0.4.4. With the default
`claudeUpstreamApi: chat-completions`, a Claude model never falls back. Validation and effort
selection run on the original messages first. GPT models keep `role: "system"`: with the
reminder sent as `role: "system"` on every request, gpt-6-astra on `/responses` read
98.16–98.25% of each warm request from cache. The native route forwards the original roles and
breakpoints unchanged.

This deliberately relaxes the system-role preservation described under Translated history, on
this route only: the text keeps its position and is never assistant speech or part of the
leading system prompt, but a later operator instruction arrives with user-turn authority. The
measurements cover caching, not how the model weighs a later operator instruction.
`claudeUpstreamApi: messages` keeps the system role.

Chat Completions has no `cache_control`. On the same route the relay sets
`copilot_cache_control: { "type": "ephemeral" }`, the field VS Code Copilot Chat sends, on the
translated message that holds each breakpoint's block (`markMessageBreakpoints` in
`src/claude/translate.ts`). `handleUserMessage` turns each `tool_result` into its own tool
message, so a marked result marks that tool message. Blocks that join into one message share
its mark, so a breakpoint on an earlier block moves to the end of that message. That covers the
blocks of the system prompt, of a system turn and of an assistant message, and the blocks of a
user message other than its tool results. Of the two system breakpoints Claude Code 2.1.288
sends, one is on the last system block and the other moves to the end of the joined prompt. A
breakpoint on a message that translates to nothing marks the previous message. With marks and
no reminder, request 2 read 29,422 tokens instead of 29,242, because the first user message was
cached too.

A build with this change, measured the same day: with the reminder sent as `role: "system"` on
every request, the five-turn harness read 98.21% of request 2 and 98.30% of request 5 from cache
(29,470 → 31,072 tokens). Real Claude Code 2.1.288, in the same three rounds of 14 parallel
`Read` calls, read 23,534, 25,195 and 26,856 tokens from cache on its warm requests, against
previous-request totals of 23,538, 25,199 and 26,860. Those requests each add 14 file results
to a small prompt, so their per-request rates were 93.39–94.16%.

`tests/unit/chat-route-cache.test.ts` replays this Claude Code request shape. It fails if a
translated request carries a system turn after the prompt starts, or if, with cache marks
removed, a request's messages stop being a prefix of the next request's messages. It also pins
the fallback rule above and where each breakpoint lands. When Claude Code changes how it sends
harness text or breakpoints, capture a new request shape: run the client, with a placeholder API
key, through a capture proxy to an isolated test relay on its own port, never the relay in daily
use. That relay runs with a temporary HOME holding a Copilot login, so the tool loop gets real
replies. Record only roles, block types and `cache_control` placement, never text or
credentials; delete the temporary HOME afterwards and update the test. The test itself mocks
upstream like every other test.

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

A future refresh deadline is not proof that upstream still accepts the token.
`setupProxyAuth` installs a non-interactive refresh callback on the runtime config.
`fetchCopilot` in `src/copilot/client.ts` uses it for HTTP 401 and HTTP 403 whose
entire body is plain `forbidden` (case/whitespace insensitive, at most 128 bytes).
Structured model/policy/quota denials are returned unchanged. The provider keeps
its base URL but reads the current token for each attempt.

Timer and request refreshes share one in-flight exchange. The attempted token and
refresh generation identify late rejections, so they reuse an already-completed
refresh even if the replacement token text is identical. A replacement is written
to a private temporary file and atomically renamed over the cache before updating
live state and rescheduling renewal. Each upstream operation allows one auth
recovery plus the existing transient retry allowance, at most three HTTP attempts;
chat-to-Responses fallback is a separate operation under the same caller deadline.

A cancelled/timed-out caller stops waiting and is never replayed; other callers
may still use the shared exchange, which has its own finite upstream timeout
(180 seconds when the configured timeout is disabled). Only rejected HTTP
responses are recovered, never a successful response or a started stream. Refresh
failures surface without device login or being retried as network failures.

Token recovery logs contain status, route and outcome, not bearer credentials or
response payloads. This is not a guarantee for raw captures: user-supplied prompts
or upstream echoes may themselves contain secrets.

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

`isRelayStartProcess` recognizes both `start` and the long-running `restart`
process, using narrow executable/entrypoint checks rather than arbitrary command
substrings. Before signalling and before escalation, lifecycle code checks a
coherent command, working-directory and creation-time identity. Unavailable
identity is not proof of exit, and PID reuse does not authorize killing a
replacement. Unknown/live PID records are preserved rather than cleared as if
cleanup succeeded. Ambiguous flattened POSIX paths require filesystem evidence
for the exact entrypoint and absence of earlier executable/script interpretations;
this is conservative, not an OS-atomic identity guarantee. Unknown initial discovery
retries within a bounded grace period, then fails without signalling. `status`
reports inspection uncertainty as a diagnostic exit `2`, not absence.

A `node <entry> start|restart` process whose entrypoint is not under a
`copilot-relay` or `copilot-relay-*` directory, such as a release runtime at
`~/.copilot-relay/runtime/0.4.1/dist/main.js`, is identified by the package
manifest instead (#113): `packagedEntryCandidate` in `src/lib/lifecycle.ts`
accepts an absolute or cwd-resolved `dist/main.js` or `src/main.ts`, and
`packageEntryProof` requires that path to be a regular file whose canonical
`../package.json` has `name: "copilot-relay"`. Any failure to prove that is
`nonrelay`, the verdict these commands had before, so an unrelated
`node app/dist/main.js start` is never signalled and never blocks `stop`.

Broken config makes `status` emit a safe diagnostic and exit `2` before probing;
it is not a claim the daemon stopped. `stop` can continue without a config port
hint, using only verified identities. Repair config before restarting.

### Exit codes are a contract

| Code | Meaning |
| --- | --- |
| `0` | a live process **and** a passing health probe |
| `1` | no relay running |
| `2` | unusable or status cannot be established — health/deep probe failed, or config could not be read |

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
After server closure, `startRelay` stops the config watcher, clears its PID record,
then awaits `flushCaptures` and `flushLogs`; forced process termination cannot
promise the same durability.

## Capture and offline replay

`RequestTrace` in `src/lib/request-trace.ts` wraps the admitted client body and
consumed upstream/downstream streams without an independent tee. `recordedFetch`
and `recordedRefresh` retain ordered attempts, discarded retry responses and
refresh outcomes. The manifest records the request's policy/catalog snapshot,
chunk lengths, observed byte counts, body state and handler settlement; final
metadata replaces `meta.json` atomically after queued body writes settle.
Private file handles retain append targets; directory/file identity and single-link
checks reject observed path substitution. This is not protection against every
possible same-user filesystem race. A transport/body failure is not the same as
a semantically refused answer.

`OutcomeObserver` extracts bounded metadata independently of body storage:
HTTP status, stop/finish/response terminal state, refusal category, incomplete
reason and reported input/output/cache usage. Missing or oversized metadata is
unknown, not a successful completion or zero cache use. Normal `info` outcome
lines contain this metadata, not prompt or response text.

`withTraceObserver` gives an in-process caller a request-scoped handle without
publishing a new HTTP API or reading captured files. The callback only stores the
handle: the response must be consumed before awaiting `finished`. `probeModels`
bounds that diagnostic wait, then uses `diagnosticSnapshot` rather than dumping
the manifest. The snapshot rechecks allowlisted identifiers against every
registered credential, including refreshed tokens, and emits only known routes,
statuses, outcomes and capture states. Unknown errors do not prove upstream blame.

`src/lib/model-probe-output.ts` owns presentation; `src/lib/terminal.ts` owns color
policy independently of the environment at module import. Status text shares
that policy but its JSON and detection logic do not change. Deep setup uses
`withoutConsoleLogging` so file evidence remains; inference and body consumption
use `withoutLogging` to avoid raw payload disclosure, then one safe failure summary
is logged. Device-auth instructions bypass quiet setup through an explicit callback.

Only debug enables body files. `safeHeaders` is an allowlist excluding auth
headers; policy snapshots omit bearer tokens and private upstream URL tails.
**Raw body bytes are intentionally not redacted** and can include credentials
placed in prompts, tool results or provider echoes. A bounded async write queue
never blocks forwarding on disk throughput; overload/write failure marks the
capture incomplete rather than silently truncating a purportedly replayable file.
Operational limits, permissions and safe handling are in
[Logs and troubleshooting](EN-Logging-Troubleshooting.md).

`cleanupCaptures` shares `logRetentionDays` with logs, using local-calendar date
directories, and runs on startup/reload. `cleanupCapturesIfDue` adds an hourly
request-time check outside replay. It retains active captures and pending records
with live/unknown owners; only `ESRCH` proves a pending owner has exited. Sweeping
requires validated directory/manifest identity and known regular single-link files,
leaving unknown or changing content alone. `flushCaptures` waits for cleanup and
pending captures during graceful shutdown; it cannot rescue a crash or SIGKILL.

`replayCapture` in `src/replay.ts` validates metadata/schema, fixed body filenames,
chunk totals, paths and size limits before running `createServer(config).fetch`
in process. `withRecordedTransport` supplies only recorded upstream responses,
errors and refresh outcomes in their original order. No listener/socket, device
auth, token refresh exchange, config write or new capture is created. It compares
actual current outgoing JSON and final JSON/SSE with the recording; unused or
unexpected operations are differences, not a network fallback. The validated
manifest request ID is supplied through internal recorded transport so local error
correlation text is reproduced exactly; client headers never select that identity.
Older error recordings can legitimately differ when the current error text changes.

Comparison ignores transport chunk boundaries and normalizes only known freshly
generated bridge IDs while protecting provider IDs and literal content. Diff
output prints structural paths and fixed reasons, never values or payload-derived
property names. `MATCH` is local transformation agreement, not a new model run,
a cache benchmark, or proof of a historical refusal's cause. Incomplete/aborted
captures cannot produce a match; see the CLI verdict table in
[Logs and troubleshooting](EN-Logging-Troubleshooting.md).

## Logging invariants

The one-line and rotation rules were learned from a log that reached 9.3 GB.
Raw capture files are a separate diagnostic channel, not larger normal log entries.

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

Object inspection is bounded at depth 6, 100 array elements, and 4000 characters
per contained string. URL and registered credential redaction precede line escaping
and final UTF-8-safe bounds: 16 KiB per rendered argument and 64 KiB per file entry,
including framing. Both sinks receive the same bounded payload; `[truncated]`
marks the final cap. These limits do not truncate the separate raw capture.

### Retention needs rotation

The active file is `copilot-relay.<local-date>.log`, resolved for each entry when
it is logged, so it rotates at local midnight with no timer.

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

### One queue, one open file

`wrapFileLog` in `src/lib/log.ts` stamps each entry and picks its dated file when
it is logged, then queues it. One drain at a time appends queued entries in call
order through a handle kept open between batches, in writes of at most 256 KiB
that end on entry boundaries: `FileHandle.appendFile` writes a larger buffer in
512 KiB pieces, and another process appending to the same file could land
between two of them.

The handle is closed once no entry has been written for a second, because Windows
cannot rename or move a folder while a file in it is open. The next entry reopens
the file with the full checks below. The close goes through the same write chain,
so it never runs during a drain. Its timer comes from `node:timers`, not the
global `setTimeout`: tests replace the global to capture or run the timers of the
code they drive, and a log entry must not add one to theirs.

The handle is reused only while its path still names the same private file with
one link and, on POSIX, mode 0600, and the app and logs directories are still the
directories checked when it was opened: real directories, not links, with mode
0700 on POSIX. lstat of the file follows links in its parent path, so without the
directory check a logs directory replaced by a link to where the open file was
moved would pass. A rename, deletion, replacement, second hard link, replaced
directory or loosened mode makes the next batch reopen the path with the full
checks: real private directories, then no symlink, one link, the same file before
and after the open, and chmod 0600. A failed write never fails a request; it drops
that batch and closes the handle. `flushLogs` waits for queued writes, then closes
the file; each call waits for the close it queued, so overlapping calls both
finish.

Before #141 each entry ran its own directory checks, open, stat, chmod, append and
close, and a burst could reach the file out of order.
`tests/unit/log-format.test.ts` covers call order, call-time stamps and the reuse
checks.

### Redaction

`src/lib/redact.ts` is pure and covers URLs that may carry credentials in a path,
query string, or fragment. A secret-bearing gateway tail must not survive into
normal logs. `copilotBaseUrl` validation rejects raw quotes, angle brackets,
whitespace and control characters because they make whole-URL recognition
ambiguous. `registerLogSecret` in `src/lib/log.ts` keeps known authentication
credentials in memory, including rotated values and the `upstreamProxy`
`user:password` and `Basic` value, and removes raw/escaped echoes from ordinary logs. Nested adjacent URLs are scrubbed independently even after
inspection escapes their separators. This is not a promise to remove arbitrary
prompt/tool secrets; review bounded excerpts before sharing, and never upload raw
captures wholesale. See [Logs and troubleshooting](EN-Logging-Troubleshooting.md).

## Testing

```sh
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
```

### Home directory redirection

The npm test scripts preload `scripts/test-bootstrap.mjs` **before `tsx` and any
source import**. It assigns each test process a private `HOME`, `USERPROFILE` and
temporary root, and cleans up only its owned directory on exit. This protects
static imports too; use the same preload when running a focused test.

A suite that needs its own log/config fixture must still redirect before that
module's first import: `src/lib/paths.ts` resolves `os.homedir()` once. For example:

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

GitHub calls go through the relay's upstream dispatcher, not the global `fetch`,
so replacing `fetch` does not fake them. `tests/fixtures/network.ts` provides the
stand-ins: `startFakeGitHub` answers GitHub locally, `redirectGitHubTo` patches
undici's `Agent` so requests for `github.com` and `api.github.com` reach it, and
`refuseExternalConnections` makes any other connection off the machine throw.
`withProxyEnvironment` sets proxy variables for one test and restores them.
`startRecordingProxy` records the requests a proxy receives, and
`startEchoingProxy` answers each `CONNECT` with a reply undici cannot parse that
echoes the credentials it received.

Start such a stand-in before the first `test()` in the file. `node:test` runs the
global `after()` hooks as soon as every test registered so far has finished, which
can happen during a top-level `await` placed between tests, and an `after()` hook
registered later never runs. The stand-in then keeps listening and the test process
never exits.

### Structural documentation tests

`tests/unit/wiki-docs.test.ts` enforces the documentation contract itself: that
`wiki/` is flat, that every `EN-` page has a `ZH-` counterpart, that every
relative link resolves, and that the real code-aware `scripts/publish-wiki.py`
transform leaves no broken published navigation. It invokes the same script as
the workflow, plus Python fixtures; it does not maintain a second regex transform.
The suite imports no relay source, and isolates both home variables for its Python
subprocesses. See [Development](EN-Development.md) for offline and post-publish checks.
