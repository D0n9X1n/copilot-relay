# Configuration

`copilot-relay` stores runtime configuration under:

```text
~/.copilot-relay/config.yaml
```

The file is created from the package template on first start.

To see every key after defaults are resolved, and which of them need a
restart, run `copilot-relay status`. It prints the resolved config rather than
making you read the file back. Those are the values *on disk*: a daemon that has
been running since before your last edit has not necessarily read them.

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
gptModel: gpt-6-astra
opusModel: claude-opus-5
```

## Keys

| Key | Purpose |
| --- | --- |
| `host` | Local bind host for the Claude-compatible HTTP server. Keep `127.0.0.1` for local-only use. |
| `port` | Local port. Default: `4142`. |
| `copilotBaseUrl` | GitHub Copilot API base URL. Must be an absolute `http://` or `https://` URL, and may not contain credentials. Keep the default unless you know you need a tenant-specific endpoint. See [copilotBaseUrl rules](#copilotbaseurl-rules). |
| `claudeSetup` | When `true`, `start` updates `~/.claude/settings.json` with the local relay endpoint. |
| `logLevel` | One of `error`, `info`, `debug`. Any other value fails startup. |
| `logRetentionDays` | Days to keep normal `.log` files under `~/.copilot-relay/logs/`. |
| `thinkEffort` | Default upstream reasoning effort: `none`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `upstreamTimeoutSeconds` | Max seconds one Claude request can wait for upstream Copilot calls. Default: `180`; `0` disables the relay deadline. |
| `webSearchBackend` | Optional Copilot Responses model for bridge-managed WebSearch. Empty uses `gptModel`. |
| `gptModel` | Upstream model for non-Opus requests. |
| `opusModel` | Upstream model for requested models containing `opus`. |

## Choose models and thinking effort

### List available models

Model availability depends on your Copilot account and organization policy. With
GitHub Copilot CLI installed, run `copilot` in your terminal, then enter this
command **inside its interactive session**:

```text
/model
```

The picker lists account-visible models and the selected model's supported effort
choices. Use the same account as the relay. Selecting a model there changes the
Copilot CLI session, not the relay configuration. There is no `copilot-relay models`
command.

The authoritative relay catalog is authenticated `GET /models` at your configured
`copilotBaseUrl`. Startup queries it and then probes both configured models.
`copilot-relay status` shows configured relay IDs; local `GET /v1/models` also
includes cached `context_window`, `max_input_tokens`, and `max_tokens` when
discovery supplied them. Neither endpoint fetches the catalog or proves current
model access. A custom gateway may
have a different catalog from Copilot CLI. Never paste bearer tokens into commands,
logs, or issue reports.

### Choose a compatible effort

`thinkEffort` overrides client-provided effort for both routes. Choose a value
supported by **both** `gptModel` and `opusModel` (and by `webSearchBackend` when
set). The relay accepts `none`, `low`, `medium`, `high`, `xhigh`, and `max`.
Legacy config value `minimal` is normalized to `low`; it is not a separate tier.
Missing effort metadata means "not advertised," not "all tiers supported."

The live catalog checked on 2026-09-05 advertised `low`, `medium`, `high`, `xhigh`,
and `max` for both `gpt-6-astra` and `claude-opus-5`; `none` is not advertised for
Astra. Higher effort generally trades latency and token use for more reasoning.
Recheck the picker when changing either model instead of assuming every model
accepts `max`.

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
opusModel: claude-opus-5
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
| `gpt-5.6-sol` | 1,050,000 | 922,000 | 128,000 |

These are discovered values, not hardcoded runtime limits or results of a
million-token production request. Leave room for output, including reasoning,
within the total window. The relay never truncates input or expands an explicit
smaller output budget. Upstream remains the authority on whether a prompt fits.
Both streamed and completed JSON responses can use the model's full output limit.

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
- `gptModel`
- `opusModel`

Requires restart:

- `host`
- `port`
- `claudeSetup`

`host` and `port` require restart because the listening socket is already bound.
`claudeSetup` is read once during startup, so toggling it changes nothing until
the relay starts again.

Changing `gptModel` reroutes upstream requests immediately, but does not rewrite
the model or token settings already saved in `~/.claude/settings.json`. Check
those settings when switching models; managed setup only seeds absent budgets.

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

## Runtime files

```text
~/.copilot-relay/
  config.yaml
  github_token
  copilot_token.json
  logs/copilot-relay.2026-07-25.log   <- active, rotates at local midnight
  logs/copilot-relay.2026-07-24.log
```

`github_token` is the login source. `copilot_token.json` is a short-lived Copilot
bearer-token cache with refresh metadata.
