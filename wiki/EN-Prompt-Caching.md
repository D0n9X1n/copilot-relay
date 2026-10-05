# Prompt caching

Every Claude Code request resends the whole conversation: the system prompt, the
tool definitions and every earlier turn. Most of it repeats the previous request.
When Copilot serves that repeated prefix from its prompt cache, those input tokens
are read from cache instead of being processed again. In long sessions that is the
main lever for input-token cost and latency.

This page explains who caches, what Claude Code marks for caching, what the relay
sends on each upstream route, what keeps a conversation's prefix stable, and how to
measure the hit rate. The precise mechanics and the measurements are under "Prompt
caching" in [Internals](EN-Internals.md).

## Who caches

Copilot does. The relay keeps no prompt cache of its own, and it cannot make
Copilot cache a request or keep an entry. It decides only what it forwards: on some
routes it passes on Claude Code's cache marks, on `/responses` it sends a cache key,
and on the rest it sends no cache hint. It learns how much input was read from cache
only from the usage Copilot reports for each call. None of this guarantees a cache
hit.

## What Claude Code marks

Claude Code marks the end of each prefix it wants cached with `cache_control` on a
content block. In the request shape recorded from Claude Code 2.1.288, in
`tests/unit/chat-route-cache.test.ts`, three blocks carry it: two in the system
prompt, and the token reminder Claude Code sends as the last message of every
request, a mid-conversation `role: "system"` message. Earlier reminders are replayed
as plain strings without a mark, and the tool definitions carry none. Other Claude
Code versions may mark other blocks.

## What the relay sends on each route

Which route a request takes depends on the model, its catalog entry and
`claudeUpstreamApi`; see `claudeUpstreamApi` in [Configuration](EN-Configuration.md).

| Route | Cache hint the relay sends | Mid-conversation system message |
| --- | --- | --- |
| `/v1/messages` | Claude Code's `cache_control`, forwarded as sent | Kept as `role: "system"` |
| `/chat/completions`, Claude model whose request cannot fall back to `/responses` | `copilot_cache_control` on each message that holds a marked block | Sent as a `role: "user"` turn holding `<system-reminder>`, in its original position |
| `/chat/completions`, a request that can fall back, or a model that is not Claude | None | Kept as `role: "system"` |
| `/responses` | `prompt_cache_key`, when there is a source for it | Kept as `role: "system"` |

On every route, the relay first removes Claude Code's billing attribution line from
the top-level system prompt. A block that held only that line is dropped; the other
blocks keep their `cache_control`. See "Claude Code's billing line" in
[Internals](EN-Internals.md).

### `/chat/completions`

Chat Completions has no `cache_control`. For a Claude model whose request cannot
fall back to `/responses`, the relay sets
`copilot_cache_control: { "type": "ephemeral" }` on the translated message that
holds each marked block. Blocks that join into one message share its mark, so a mark
on an earlier block moves to the end of that message.

On the same route, a mid-conversation system message is sent as a `role: "user"`
turn holding `<system-reminder>…</system-reminder>`, in its original position.
Measured with claude-opus-5.5, a new `role: "system"` message on every request
capped cache reads at the tools plus the original system prompt, and a user turn did
not; see "Chat route: system turns and cache breakpoints" in
[Internals](EN-Internals.md). The cost is authority: a later operator instruction
arrives with user-turn authority. The measurements cover caching, not how the model
weighs that instruction. `claudeUpstreamApi: messages` keeps the system role.

A Claude request can fall back only in `auto` mode, for a model with no endpoint
metadata in the catalog, or whose catalog entry lists `/chat/completions` and
`/responses` but not `/v1/messages`. When Copilot answers `/chat/completions` with
`unsupported_api_for_model`, the relay sends the same translated payload to
`/responses`, so that payload keeps `role: "system"` and carries no cache marks. A
model that is not Claude is translated the same way. With the default
`claudeUpstreamApi: chat-completions`, a Claude model never falls back.

### `/responses`

The relay sends no cache marks to `/responses`. It sends `prompt_cache_key`, a
cache-routing hint derived with SHA-256:

- `cr-` plus 32 hex characters, from the request's `user` identifier, which the
  relay takes from Claude Code's `metadata.user_id`;
- `cr-sys-` plus 32 hex characters, from the system prompt text, when there is no
  `user` identifier;
- no key when there is neither.

The key does not guarantee a cache hit. Earlier Copilot tests with the GPT-5.5/5.6
family found cache reads dropping to 0 without it, while GPT-6 Astra also cached
requests without it.

Hashing the key does not hide the identifier: the relay also sends the identifier
itself, truncated to 64 characters, in the request's `user` field, on `/responses`
and on `/chat/completions`. Treat `metadata.user_id` as a value Copilot sees.

## How cached input is reported

Claude Code receives usage in the Messages API form: `input_tokens` for uncached
input, plus `cache_read_input_tokens` and `cache_creation_input_tokens`. Copilot
reports usage differently per route, and the relay maps it:

| Route | Copilot reports | Claude Code receives |
| --- | --- | --- |
| `/v1/messages` | Messages API usage | The same fields |
| `/chat/completions` | `prompt_tokens`, which includes cached input, and `prompt_tokens_details.cached_tokens` | `input_tokens` = `prompt_tokens` minus `cached_tokens`; `cache_read_input_tokens` = `cached_tokens` |
| `/responses` | `input_tokens`, which includes cached input, and `input_tokens_details.cached_tokens` | `input_tokens` = `input_tokens` minus `cached_tokens`; `cache_read_input_tokens` = `cached_tokens` |

Only `/v1/messages` reports cache writes. When Copilot reports no cached count, the
relay leaves `cache_read_input_tokens` out rather than sending `0`. The relay's own
log keeps each route's counts as Copilot reported them, so its `input_tokens`
includes cached input on `/chat/completions` and `/responses` but not on
`/v1/messages`; `copilot-relay cache` accounts for that, as "What is counted" below
explains.

## What keeps the prefix stable

A cache hit needs the start of a request to match, byte for byte, what an earlier
request sent. These keep it stable on the relay's side:

- Assistant `thinking` stays in the upstream history. Claude Code replays it, and
  stripping it before forwarding would rewrite the prefix and invalidate the cache;
  see "Assistant `thinking` stays in upstream history" in
  [Internals](EN-Internals.md).
- On `/chat/completions`, for a Claude model that cannot fall back, a reminder stays
  a user turn in its original position rather than becoming a new system message on
  every request.
- `tests/unit/chat-route-cache.test.ts` replays Claude Code's request shape. It fails
  if a translated request carries a system turn after the prompt starts, or if, with
  cache marks removed, a request's messages stop being a prefix of the next
  request's messages.
- On `/responses`, the key stays the same while the `user` identifier, or the system
  prompt when there is no identifier, stays the same.

Anything that changes an earlier part of the request starts a new prefix from that
point: a different system prompt, a changed tool list, or edited or compacted
history. Copilot decides what to cache and when an entry expires, so a stable prefix
makes a hit possible, not certain.

## Measure the hit rate

`copilot-relay cache` reports how much of each model's input the prompt cache
served, per upstream route. It reads only the relay's log files: it contacts neither
the relay nor Copilot, and writes nothing. Its options and exit codes are under
`cache` in [Commands](EN-Commands.md). To find the hour a hit rate changed, or one
cache-read size repeated across many requests, see "Finding a regression" in
[Logs and troubleshooting](EN-Logging-Troubleshooting.md).

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

### What is counted

The command reads the `completion` entry the relay logs at `info` for each
upstream call, from the dated files in `~/.copilot-relay/logs/`. An entry counts
only with `http_status=200`, a numeric `input_tokens`, and a route of
`/chat/completions`, `/responses` or `/v1/messages`. Its `body` and `terminal`
values do not matter, so a call cut off after its usage arrived still shows what
it read from cache. The `request outcome` entry reports usage again, for the
client request (both entries are described under "HTTP requests" in
[Logs and troubleshooting](EN-Logging-Troubleshooting.md)), so it is
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
