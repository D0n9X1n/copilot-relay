# Configuration

`copilot-relay` stores runtime configuration under:

```text
~/.copilot-relay/config.yaml
```

The file is created from the package template on first start. On subsequent
loads, the relay preserves your existing text, comments, key order, unknown flat
scalar keys, and explicit values; it appends defaults only for absent keys.
Writes use a checked file snapshot and atomic replacement of the resolved target,
so a symlink remains a symlink and detected concurrent edits are not overwritten.
Upgrades do not migrate saved values to new defaults.

Only flat scalar YAML is supported. Invalid known values, duplicate keys (including
aliases), and unsupported syntax fail before write-back; the file is left for you
to correct. Empty `webSearchBackend` is valid, not an instruction to erase other
settings. Hot reload is **read-only** and accepts only a stable, valid document
containing every materialized key; a partial or empty editor save keeps the last
valid runtime settings. Restore the missing keys rather than deleting one to
request its default. See [Internals](EN-Internals.md) for the writer's guarantees.

To see every key after defaults are resolved, and which of them need a restart,
run `copilot-relay status`. These are the values *on disk*, not proof the daemon
has loaded them. With broken config, `status` exits `2` with a safe diagnostic;
`stop` can still attempt recovery using verified process identities. See
[Logs and troubleshooting](EN-Logging-Troubleshooting.md).

## Example

```yaml
host: 127.0.0.1
port: 4142
copilotBaseUrl: https://api.githubcopilot.com
claudeSetup: true
logLevel: info
logRetentionDays: 3
thinkEffort: max
upstreamTimeoutSeconds: 180
webSearchBackend:
claudeUpstreamApi: chat-completions
gptModel: gpt-6-astra
opusModel: claude-opus-5.5
```

## Keys

| Key | Purpose |
| --- | --- |
| `host` | Local bind host for the Claude-compatible HTTP server. Keep `127.0.0.1` for local-only use. |
| `port` | Local port. Default: `4142`. |
| `copilotBaseUrl` | GitHub Copilot API base URL. Must be an absolute `http://` or `https://` URL, and may not contain credentials. Keep the default unless you know you need a tenant-specific endpoint. See [copilotBaseUrl rules](#copilotbaseurl-rules). |
| `claudeSetup` | When `true`, `start` updates `~/.claude/settings.json` with the local relay endpoint. |
| `logLevel` | One of `error`, `info`, `debug`. `debug` automatically captures full observed request/response bodies as well as bounded logs; see [Logs and troubleshooting](EN-Logging-Troubleshooting.md) before enabling it. Any other value fails startup. |
| `logRetentionDays` | Local calendar days to retain normal relay logs and debug captures, including today; positive integer, default `3`. Active/unknown captures are protected; see [Logs and troubleshooting](EN-Logging-Troubleshooting.md) for cleanup rules. |
| `thinkEffort` | Fallback reasoning effort when the request omits it: `low`, `medium`, `high`, `xhigh`, `max`. |
| `upstreamTimeoutSeconds` | Max seconds one Claude request can wait for upstream Copilot calls. Default: `180`; `0` disables the relay deadline. |
| `webSearchBackend` | Optional Copilot Responses model for bridge-managed WebSearch. Empty uses `gptModel`. |
| `claudeUpstreamApi` | Claude upstream protocol: `chat-completions` (default), `auto`, or `messages`. Does not change non-Claude routing. |
| `gptModel` | Upstream model for non-Opus requests. |
| `opusModel` | Upstream model for requested models containing `opus`. |

## Choose Claude's upstream protocol

Model selection still happens first (`opusModel` or `gptModel`). For a selected
upstream ID starting with `claude-`, `claudeUpstreamApi` then chooses:

| Value | Behavior |
| --- | --- |
| `chat-completions` | Default. Keep the translated Copilot `/chat/completions` path. |
| `auto` | Use native `/v1/messages` only when the current provider's cached model catalog advertises that endpoint; otherwise use the translated path. |
| `messages` | Force native `/v1/messages` for Claude models, even without an advertised capability. Upstream rejection remains an error. |

Non-Claude models keep their existing chat/Responses selection in every mode.
Native transport preserves signed thinking, cache markers, in-place system roles
and controls; it does not silently retry a refusal or failure through another API.
`chat-completions` remains the shipped default. A bounded 2026-09-30 matched
synthetic trial at `low` effort measured warm token-weighted cache reads of
99.8384% for chat and 99.7980% for native (about 0.04 percentage points apart).
A second, counterbalanced native-first trial stopped on its cold-turn refusal;
the completed trial does not establish broad non-regression or billing-cost
equivalence. These were isolated checks, not validation of the current production
relay; port 4142 was untouched. Methods and usage counts are in
[Internals](EN-Internals.md). Reasoning flattening is still not proven to have
caused the historical refusal.

Native bridge-managed WebSearch supports automatic selection only. With WebSearch
advertised, `any` or an explicitly forced search returns HTTP 400 JSON before
retrieval/SSE; only one search is allowed per turn. Its deterministic relay marker restores the original signed provider
history on continuation. Old chat-bridge history and native-bridge history are
not transparently interchangeable: keep an existing search conversation on its
original route, or begin a new conversation after switching. See
[Internals](EN-Internals.md) for protocol boundaries, not just model availability.

## Choose models and thinking effort

### List available models

Model availability depends on your Copilot account, organization policy, and
configured gateway. To fetch the complete catalog advertised by your relay's
upstream, run:

```sh
copilot-relay models
```

The command makes a fresh authenticated `GET /models` at the configured
`copilotBaseUrl`, reusing the relay's cached credentials, token refresh, and
`upstreamTimeoutSeconds`. Without usable cached credentials, the existing device
login flow may ask you to authenticate. All valid upstream IDs are printed in
sorted order, with duplicates removed; relay aliases such as `[1m]` are not added.
Models outside the configured `gptModel` and `opusModel` mappings are included.
Terminal control characters are stripped and sensitive gateway URL tails are
redacted for safe display; ordinary model IDs are unchanged.
An empty catalog is reported explicitly with exit code `0`; configuration,
authentication, network, HTTP, timeout, and malformed-catalog failures exit `1`.
A local timeout is reported separately from a real upstream HTTP 504.

It works while the relay is stopped and when a configured model ID is absent
upstream. It does not bind a port, run startup preflight or inference probes,
change your selected models, or alter Claude settings. The config loader still
materializes resolved keys in `config.yaml`, and authentication may update its
token cache, just as with other commands.

**Advertised does not mean verified.** A catalog entry is not proof of successful
inference or compatibility with relay requests, tools, or a particular effort.
After choosing models, startup checks the configured IDs and probes them;
`copilot-relay status --deep` checks a real request through the running relay.
In contrast, `copilot-relay status` shows configured relay IDs, and local
`GET /v1/models` also includes cached `context_window`, `max_input_tokens`, and
`max_tokens` when discovery supplied them. Neither fetches the upstream catalog.

For an interactive picker and any effort metadata it exposes, you can also run
GitHub Copilot CLI (`copilot`), then enter `/model` **inside its interactive
session**. Use the same account as the relay. That selection changes only the
Copilot CLI session, not the relay configuration; a custom gateway may advertise
a different catalog. Never paste bearer tokens into commands, logs, or issue
reports.

### Test model availability

Catalog listing is free of inference. Deep mode is opt-in and **consumes real
Copilot usage**; use an exact model selection to avoid probing the whole catalog:

```sh
copilot-relay models --deep --model claude-opus-5.5
copilot-relay models --deep --timeout 20 --total-timeout 120
copilot-relay models --deep --model gpt-6-astra --effort low --max-tokens 4096
```

The compact table shows `MODEL`, `STATUS`, `TIME`, and a short `RESULT`, followed
by nonzero outcome counts. A model ID appears once; long IDs wrap rather than
being silently shortened. Rows arrive as each sequential probe finishes. `*`
means effort or endpoint metadata was not advertised, not that it was verified.

TTY output uses green for PASS, red for FAIL, yellow for INCOMPLETE and muted
SKIPPED/NOT_TESTED labels. `status` and `status --deep` use the same policy for
health, upstream checks and version mismatches. Text labels remain authoritative;
color never changes an exit code. Pipes and dumb terminals default to plain text;
`NO_COLOR` or `FORCE_COLOR=0` disables ANSI, and a positive `FORCE_COLOR` enables
it explicitly. `NO_COLOR` takes precedence. `status --json` is always uncolored.

Routine deep-command setup messages stay in the log file rather than cluttering
the table; required sign-in instructions and setup errors remain visible. Probe
response text, tool arguments and raw errors are never printed. Nonpassing probes
include their generated `request_id`, and repeated next-step hints are deduplicated.

To see safe evidence for each probe, request details on the same invocation:

```sh
copilot-relay models --deep --model claude-opus-5.5 --details
```

Details include planned/actual routes, effective effort/output cap, reported model,
client/upstream HTTP status, completion state, correlation IDs and capture state.
A replay command appears only for a complete existing private capture. This is
still a **new real probe**, not offline inspection of an earlier failure; see
[Logs and troubleshooting](EN-Logging-Troubleshooting.md).

| Status | Meaning |
| --- | --- |
| `PASS` | The selected model returned completed nonempty text. This is not tool coverage, all-effort coverage, or proof the answer is correct. |
| `INCOMPLETE` | Generation did not finish. Positive reported output usage with budget exhaustion establishes reachability, not a completed answer. |
| `FAIL` | HTTP/auth/network failure, timeout, refusal, unexpected output, missing/mismatched model, or empty completed response. |
| `SKIPPED` | Advertised metadata excludes the required relay endpoint/effort or identifies a non-chat model, or the ID is unsafe/noncanonical. |
| `NOT_TESTED` | The overall deadline or an interruption stopped the active probe or prevented a later probe; this is not a model failure. |

The scope is **isolated relay pipeline; not running-daemon health**. The CLI
passes a synthetic request through the normal in-process Messages handler,
translation, upstream client, token refresh, and response translation. It
selects the exact upstream ID in process-local routing for each sequential probe,
then restores state. Simply sending every ID to the running daemon would instead
remap them to `gptModel`/`opusModel` and falsely report per-model coverage. No port
is bound, no daemon is restarted, and model config/Claude settings are unchanged.
Use `status --deep` to check the running daemon's configured route.

| Option | Default / behavior |
| --- | --- |
| `--model` | All advertised IDs; supplied ID must match the catalog exactly. Requires `--deep`. |
| `--details` | Include safe per-probe evidence and capture/replay availability. Requires `--deep`; does not add probes or retries. |
| `--max-tokens` | 4096 per probe, clamped to catalog output and native non-streaming ceilings. |
| `--effort` | Lowest advertised recognized value (`none`, `low`, `medium`, `high`, `xhigh`, `max`); missing metadata uses `low` marked unverified. An override unsupported by advertised metadata is skipped. |
| `--timeout` | 30 seconds per probe, capped by a positive `upstreamTimeoutSeconds`. |
| `--total-timeout` | 300 seconds for the probe phase. Discovery/auth precede this budget. |

Numeric options accept positive whole numbers up to 2,147,483; all probe options
require `--deep`. Even if config disables upstream deadlines, deep checks still
have their own deadlines. Missing endpoint metadata is marked unverified rather
than treated as proof of support. Model matching removes the relay's known GPT
context suffix. Only for a native `/v1/messages` probe of catalog ID
`claude-opus-5.5`, it also accepts the observed provider spelling `claude-opus-5-5`.
Keep the catalog spelling in config and `--model`; other mismatches still fail.
Authentication can refresh tokens; the existing bounded retries may consume additional calls, but
there is no new per-model retry loop. Ctrl+C aborts the active probe and marks
remaining models not tested. Raw shared-pipeline logging is suppressed only for
these diagnostic calls; normal relay logging is unaffected.

Deep exit codes: `0` all selected models passed; `1` invalid options, selection,
authentication, or discovery failure; `2` any other non-pass result or no models;
`130` interruption. Ordinary `models` still reports an empty catalog with exit `0`.

### Switching models within a conversation

With the default `claudeUpstreamApi: chat-completions`, the configured Opus route
uses Chat Completions and the configured GPT route uses Responses when required
by that model. A new request selects its destination from the current model
selector and resolves effort from that request's fields and history. An admitted
request keeps its routing and effort snapshot even if configuration changes
while its response or WebSearch passes are in flight.

`tests/integration/model-effort-switching.test.ts` replays actual relay JSON/SSE
output into subsequent requests while switching both directions, including tool
results, long tool names, zero-argument tools, thinking text, inline effort
controls and translated WebSearch continuation. It checks destination model,
effort, output ceilings, tool-call/result pairing and stream completion against
strict mocked upstream requests. This is offline verification of relay-local
translation and the encoded wire-format invariants, **not live Copilot acceptance
proof**, including for tool IDs carried from another model. It does not establish
unchanged cache hit rates.

Native Messages protocol migration remains outside this coverage. Choose an
effort supported by the destination model; authentication, rate limits, network
failures, context limits and upstream rejection can still fail a request. The
relay does not silently substitute a model or effort to conceal those failures.
Merging or building a fix does not update an already running installed relay;
that runtime must be updated and restarted separately.

### Choose a compatible effort

`thinkEffort` is the default, not an override. The initial effort is the first non-null value:

1. Claude Code's native `output_config.effort`.
2. The legacy request field `reasoning_effort`.
3. `thinkEffort` in `config.yaml`, or the shipped default when unset.

For example, `output_config: {"effort": "low"}` uses `low` even when
`thinkEffort: max`. Missing or null request fields use the fallback.
`thinking.budget_tokens` is not an effort level and is not converted into one.
Malformed explicit effort returns `400` rather than silently choosing the default.
An effort unsupported by the selected upstream model remains an upstream error;
the relay does not substitute another level.

You can change effort during a Claude Code conversation without clearing its
history. An in-message system `output_config` whose sole key is `effort` may use
`low`, `medium`, `high`, `xhigh`, or `max`. The latest marker before the latest
user turn selects the current effort; a user turn containing tool results counts
too. A marker after that user turn remains pending until the next user turn.
Older markers may have different levels and stay in the original history.

On translated chat/Responses routes, the relay maps the current effort to the
upstream request field, retaining system text and order and omitting empty
control-only messages. Extra/unknown control keys, malformed values, inline
`none`, and `clear_at` still return HTTP 400 JSON before inference or SSE.
Native Messages retains the initial setting and inline controls for upstream to
interpret. See [Internals](EN-Internals.md).

The selected effort is used for translated JSON/SSE and all WebSearch passes;
config reload cannot change it within an admitted request. Native follow-ups
retain control history, so a pending marker can activate when a later user/tool-result
turn is appended. Startup preflight still checks the configured default for both models.
Preserving translated message prefixes avoids unnecessary history changes, but
request-level effort changes may still invalidate upstream caches. Native
per-message effort is the protocol mechanism for preserving that cache; see the
[official effort guide](https://platform.claude.com/docs/en/build-with-claude/effort).

Choose a default supported by **both** `gptModel` and `opusModel` (and by
`webSearchBackend` when set). Configured defaults accept only `low`, `medium`,
`high`, `xhigh`, and `max`.
Legacy config value `minimal` is normalized to `low`; it is not a separate tier.
Missing effort metadata means "not advertised," not "all tiers supported."

`thinkEffort: none` is not a valid relay-wide default. It and any other malformed
explicit value fail before authentication, upstream probes, or config write-back:

```text
Invalid thinkEffort. Valid values: low, medium, high, xhigh, max. "none" is not allowed as a configured default.
```

The invalid file is left unchanged so you can correct it; the relay never hides
an invalid value by writing `max`. Missing keys still use the shipped default.
An invalid hot reload logs an error and keeps the last valid runtime settings.
After correcting the file, normal reload resumes.

This restriction is on the configured fallback, not on request-level overrides.
Explicit request `none` is still passed through for models that support it, such
as GPT-5.6 Sol. It is not an instruction to use the fallback.

The live catalog checked on 2026-09-05 advertised `low`, `medium`, `high`, `xhigh`,
and `max` for both `gpt-6-astra` and `claude-opus-5`; `none` is not advertised for
Astra. Higher effort generally trades latency and token use for more reasoning.
Recheck the picker when changing either model instead of assuming every model
accepts `max`.

### Opus 5.5 compatibility

Fresh installs use `opusModel: claude-opus-5.5`; existing configurations keep their
saved value, including `claude-opus-5`. Check `copilot-relay models` before changing
it: account entitlement, organization policy, and gateway availability still apply.
The authenticated catalog and isolated relay checks on 2026-09-23 verified the
exact `claude-opus-5.5` ID, JSON/SSE, automatic tool use and tool-result continuation,
conversation continuation, `low`/`max` effort, and WebSearch final-answer recomposition.
The catalog advertises all five configured efforts; no `[1m]` suffix is added to
this Opus ID. WebSearch retrieval remains on `webSearchBackend` or `gptModel`.

**The 2026-09-23 checks used the translated path:** `tool_choice` types `tool`
and `any` returned HTTP 400 for this model, while automatic selection worked.
That observation is not a native-API capability measurement. The relay preserves
upstream errors rather than silently converting a required tool call to `auto`.
Native bridge-search restrictions are described above. These are request-level
capability limits, not proof of an authentication failure.

An isolated 2026-09-30 check with real Claude Code 2.1.285 completed a native
`Read` → tool result → `OK` sequence over two model turns. The first two requests
received HTTP 400 for unsupported `safeguards`; Claude Code then downgraded its
own request. The relay did not strip that field or bypass a safeguard. This is
narrow compatibility evidence, not current production validation; see
[Internals](EN-Internals.md) for cache accounting and replay evidence.

### Update the relay config

Edit the existing keys, preserving unrelated settings. macOS or Linux:

```sh
${EDITOR:-vi} ~/.copilot-relay/config.yaml
```

Windows PowerShell:

```powershell
notepad "$env:USERPROFILE\.copilot-relay\config.yaml"
```

To switch the GPT route while keeping your Opus choice, use **Mike Farah's `yq`
v4** on macOS/Linux (optional; the editor needs no extra dependency):

```sh
cp -p ~/.copilot-relay/config.yaml ~/.copilot-relay/config.yaml.bak
yq -i '.gptModel = "gpt-6-astra" | .thinkEffort = "max"' ~/.copilot-relay/config.yaml
```

Use `max` only after checking the other configured model. The fresh-install pair is:

```yaml
gptModel: gpt-6-astra
opusModel: claude-opus-5.5
thinkEffort: max
```

These keys hot-reload. To validate both routes immediately, wait for active work to
finish and run `copilot-relay restart`, or restart through your service manager
(see the platform service pages). Startup makes small real upstream requests that
consume tokens; `restart` runs the relay in the foreground. `status --deep` makes
one real request to the GPT route, not a validation of both routes.

Existing installations keep their saved model choices; upgrading the package does
not migrate them. If startup reports Astra unavailable, edit the generated
`config.yaml` to a model your account supports, such as `gpt-5.6-sol` **if listed**,
and choose a compatible effort. The relay fails explicitly rather than silently
falling back. Restore `config.yaml.bak` if you need to undo the edit.

### Use the model's full context and output budgets

Keep the canonical `gpt-6-astra` in relay config. The relay exposes
`gpt-6-astra[1m]` to Claude Code and sends only `gpt-6-astra` to Copilot. `[1m]`
controls Claude Code's context accounting; it does not enlarge upstream capacity.
The live catalog checked on 2026-09-09 reported:

| Model | Total context | Maximum prompt | Maximum output |
| --- | ---: | ---: | ---: |
| `gpt-6-astra` | 1,000,000 | 872,000 | 128,000 |
| `claude-opus-5` | 1,000,000 | 936,000 | 64,000 |
| `claude-opus-5.5` (checked 2026-09-23) | 1,000,000 | 1,000,000 | 128,000 |
| `gpt-5.6-sol` | 1,050,000 | 922,000 | 128,000 |

These are discovered values, not hardcoded runtime limits or results of a
million-token production request. Leave room for output, including reasoning,
within the total window. The relay never truncates input or expands an explicit
smaller output budget. Upstream remains the authority on whether a prompt fits.
Local `/v1/messages/count_tokens` is advisory, not billing. Text uses the available
tokenizer; each image contributes a fixed 4096-token allowance without tokenizing,
decoding or fetching its base64/URL data. Native usage separates noncached input,
cache reads and cache writes, so native `input_tokens` alone is not total prompt
size. See [Internals](EN-Internals.md) for measured counts and denominators.

Both streamed and completed JSON responses can use the model's full output limit.
Opus 5.5 advertises a native non-streaming ceiling of 16,000 tokens; above it the
relay requests upstream SSE and buffers it for JSON callers. The 1M prompt ceiling
does not mean a 1M prompt plus 128K output fits in the 1M total window.

For an existing Claude Code setup, select the new identity explicitly:

```sh
CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000 claude --model 'gpt-6-astra[1m]'
```

Or enter `/model gpt-6-astra[1m]` inside Claude Code. `claudeSetup: true` seeds a
model only when no primary override exists; it preserves existing model selections
and shell wrappers. Update a wrapper that pins a different `--model` if necessary.
Use the configured model identity rather than assuming a built-in alias has the
same client-side context budget.

For a discovered GPT window other than exactly 1M, managed setup uses the plain
model ID and seeds `CLAUDE_CODE_MAX_CONTEXT_TOKENS` with the actual window.
Claude's `[1m]` suffix would otherwise override that numeric setting. For example,
manual Sol setup with the catalog above is:

```sh
CLAUDE_CODE_MAX_CONTEXT_TOKENS=1050000 CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000 \
  claude --model gpt-5.6-sol
```

On PowerShell, assign each value with `$env:CLAUDE_CODE_MAX_OUTPUT_TOKENS = "128000"`
(and `CLAUDE_CODE_MAX_CONTEXT_TOKENS` when needed), then run the same `claude`
command. Use values from your catalog, not from another account's model limits.
Claude settings, shell environment, auto-compaction, and provider limits can
still constrain the effective context; managed setup never disables compaction.
See Claude's [context override rules](https://code.claude.com/docs/en/model-config#correct-the-window-for-a-gateway-or-custom-model-id).

For responses that may take longer than the saved deadline, explicitly set:

```yaml
upstreamTimeoutSeconds: 0
```

This hot-reloads and removes only the relay's total deadline. Client cancellation
and client/provider/transport timeouts still apply. The fresh-install default
remains `180`, and existing saved values are never migrated.

### Recommended auto-compact window

For the documented **1M-context Opus 5.5 / GPT-6 Astra pair**, start conservatively
with an **800K auto-compact window**, keeping auto-compaction enabled. This is a
relay recommendation with headroom, not a measured optimum or a guarantee against
API errors. The dated catalog above gives Astra an 872K prompt limit and 128K
maximum output; reserving 128K from a 1M total also leaves 872K. An 800K target
keeps roughly 72K additional room for tool output, compaction and token-estimation
error. The client can compact earlier after its own output/buffer reservations.

Set it for the current session and save it to user settings:

```text
/autocompact 800k
```

Or use it for one launch without changing saved settings:

```sh
claude --autocompact 800k
```

The equivalent user-settings fragment is:

```json
{ "autoCompactWindow": 800000 }
```

For an environment override, use plain token counts:

```sh
CLAUDE_CODE_AUTO_COMPACT_WINDOW=800000 claude
```

`CLAUDE_CODE_AUTO_COMPACT_WINDOW` takes precedence over the command, flag and saved
setting. Do not use `800k` in that environment variable. `/autocompact auto` returns
to the model-tuned default after removing any environment override;
`claude --autocompact auto` does so for one launch. Managed settings can override
what the interactive command saves. See the official
[auto-compact window guidance](https://code.claude.com/docs/en/model-config)
and [environment variables](https://code.claude.com/docs/en/env-vars).

Use a smaller value when your gateway advertises lower limits. A useful upper
bound for choosing a window is `min(maximum prompt, total context - planned output
reserve) - extra headroom`; use the most restrictive model you switch to. Large
tool/image outputs or uncertain local token counts call for more headroom, not a
larger window. A native near-1M default (roughly 967K on some client models) can
already exceed a gateway's 872K prompt allowance. `[1m]` and client window settings
do not increase upstream limits. Do not disable compaction or automatically
rewrite existing settings to apply this recommendation.

## copilotBaseUrl rules

`copilotBaseUrl` is validated when the config is loaded, and startup fails if it
is not:

- **Absolute `http://` or `https://`.** A relative value (`/tenant/v1`), a bare
  host (`api.githubcopilot.com`), or another scheme (`ftp://`, `file://`) is
  rejected. Plain HTTP is allowed, so a local gateway such as
  `http://127.0.0.1:8080` is a valid value.
- **No credentials in the URL.** `https://user:password@host` is rejected. The
  upstream HTTP client refuses these at request time anyway, so accepting one
  would only turn a clear startup error into a confusing request failure.
- **No raw quotes, angle brackets, whitespace, or control characters.** These
  are what marks the end of a URL in a log line, so a value containing one
  cannot be recognised as a whole URL afterwards and its tail would be printed
  unredacted. Percent-encode them instead: `%27` for `'`, `%22` for `"`, `%60`
  for a backtick, `%3C`/`%3E` for `<`/`>`, `%20` for a space, `%09` for a tab.
  The encoded form is accepted and used exactly as written. Spaces or tabs
  *around* the value are just trimmed, as with every other config key.

The error names the key and the rule; it never repeats the value you configured,
because that message can end up on a terminal or in a log file.

### What logs and `status` show

If your `copilotBaseUrl` has a path, query string, or fragment — for example a
custom gateway like `https://gateway.example/tenant/abc123` — only its origin is
shown:

```text
copilot base url: https://gateway.example (path/query/fragment hidden)
```

The same applies to the `copilotBaseUrl` row in `copilot-relay status` and in
`copilot-relay status --json`, and to upstream URLs that appear in error
messages in `~/.copilot-relay/logs/`, which are written as
`https://gateway.example[redacted]`.

This matters because a gateway path can carry a token, and the log file is the
one thing users are asked to attach to a bug report. A base URL with no path,
such as the default `https://api.githubcopilot.com`, is shown in full — there is
nothing in it to hide.

## Hot reload vs restart

Hot-reloaded, applying to work that starts after the change:

- `logLevel`
- `logRetentionDays`
- `thinkEffort`
- `upstreamTimeoutSeconds`
- `copilotBaseUrl`
- `webSearchBackend`
- `claudeUpstreamApi`
- `gptModel`
- `opusModel`

Requires restart:

- `host`
- `port`
- `claudeSetup`

`host` and `port` require restart because the listening socket is already bound.
`claudeSetup` is read once during startup, so toggling it changes nothing until
the relay starts again.

Each admitted request snapshots routing, protocol mode, timeout, search backend,
effort fallback, and the catalog view before reading its body. Reloads affect new
requests, not retries or later passes of an active turn. Credentials are the
exception: each attempt reads the live refreshed token.

Changing `gptModel` reroutes new upstream requests, but does not rewrite the model
or token settings already saved in `~/.claude/settings.json`. Check those settings
when switching models; managed setup only seeds absent budgets.

## Claude Code settings

With `claudeSetup: true`, `copilot-relay start` writes:

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:4142
ANTHROPIC_AUTH_TOKEN=<dummy local token>
CLAUDE_CODE_MAX_CONTEXT_TOKENS=<discovered GPT context window>
CLAUDE_CODE_MAX_OUTPUT_TOKENS=<largest discovered output budget of the model pair>
```

into:

```text
~/.claude/settings.json
```

The token is intentionally a dummy value because `copilot-relay` authenticates to
GitHub Copilot with your cached GitHub/Copilot tokens, not with Claude's token.
The two budget variables are written only when absent. Smaller explicit values
are preserved. The relay bounds each request to the actual routed model's output
ceiling, so the common client setting cannot exceed the Opus limit when switching
from Astra. When a gateway omits valid limit metadata, startup logs that limits
are unavailable and leaves explicit budgets unchanged rather than inventing them.
With `claudeSetup: false`, configure these client variables yourself.
The settings writer uses the same snapshot/atomic replacement boundary; malformed
or existing empty settings files are not overwritten, and unrelated values remain.

The local dummy token is **not network authentication**. Host/Origin checks and
JSON content-type validation reduce browser-origin misuse, not access by an
arbitrary network client. Keep the listener on loopback; see
[Architecture](EN-Architecture.md).

### Keep the picker focused on Opus and GPT-6 Astra

For Claude Code **2.1.242 or newer**, merge this example into your user
`~/.claude/settings.json`, keeping the existing relay connection, budgets,
permissions, hooks, and other settings:

```json
{
  "model": "gpt-6-astra[1m]",
  "availableModels": ["opus", "gpt-6-astra[1m]"],
  "modelPicker": {
    "options": [
      { "model": "opus", "label": "Opus" },
      { "model": "gpt-6-astra[1m]", "label": "GPT-6 Astra" }
    ],
    "replaceBuiltInOptions": true
  },
  "env": {
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-opus-5.5"
  }
}
```

This uses the default relay pair, `opusModel: claude-opus-5.5` and
`gptModel: gpt-6-astra`. Keep the Opus override aligned with your configured
upstream ID. The Astra client ID carries `[1m]` for a discovered one-million-token
window; if your gateway reports a different window, use the relay's exposed plain
ID consistently in `model`, `availableModels`, and `modelPicker.options` instead.
The suffix is client context accounting, not a way to enlarge upstream capacity.

`modelPicker` replaces the built-in lineup with these two named choices instead
of suggesting unrelated Sonnet, Haiku, or Fable routes. Claude Code may still show
**Default** and a row for the current session's model; it does not guarantee exactly
two visible rows. `availableModels` is the selection allowlist and also filters
picker entries. `model` only selects the startup default. Use `/model` to select
Opus or GPT-6 Astra, or `/model gpt-6-astra[1m]` to select Astra explicitly.

This picker setting belongs in user or managed settings (or `--settings`), not
project/local settings. Managed allowlists cannot be expanded by this example;
without a managed list, user/project/local `availableModels` arrays can merge.
For an exact effective pair, remove stale entries in settings you control and
check any managed restrictions. With normal prefix matching, **Default** is not
constrained by the allowlist alone; organizational enforcement additionally uses
`enforceAvailableModels` in managed settings. See the official
[model configuration](https://code.claude.com/docs/en/model-config) and
[modelPicker reference](https://code.claude.com/docs/en/settings-reference#modelpicker).

An explicit `--model`, an exported `ANTHROPIC_MODEL`, or a saved resumed-session
model can override the startup selection; inspect shell wrappers and higher-priority
settings if the chosen model does not change. `claudeSetup` preserves existing
`model`, `availableModels`, and `modelPicker` choices; it does not install or reset
this lineup. Claude Code can substitute an allowed model for an excluded alias,
so verify the selected identity instead of assuming a disallowed alias must error.
This example is opt-in and does not change your running relay.

## Runtime files

```text
~/.copilot-relay/
  config.yaml
  github_token
  copilot_token.json
  logs/copilot-relay.2026-07-25.log   <- active, rotates at local midnight
  logs/copilot-relay.2026-07-24.log
  captures/<local-date>/<request-id>/   <- debug only; private full bodies
```

`github_token` is the login source. `copilot_token.json` is a short-lived Copilot
bearer-token cache with refresh metadata.
