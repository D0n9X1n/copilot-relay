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
| `upstreamTimeoutSeconds` | Max seconds one Claude request can wait for upstream Copilot calls. Default: `180`. |
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
`copilot-relay status` and local `GET /v1/models` show configured relay IDs only;
they never fetch that catalog and do not prove model access. A custom gateway may
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

### Use the 1M context window

Keep the canonical `gpt-6-astra` in relay config. The relay exposes
`gpt-6-astra[1m]` to Claude Code and sends only `gpt-6-astra` to Copilot. `[1m]`
controls Claude Code's context accounting; it does not enlarge upstream capacity.
The catalog checked on 2026-09-05 advertised a 1,000,000-token total window,
872,000 prompt tokens, and up to 128,000 output tokens. Leave room for output and
compact before hitting the upstream prompt limit; no million-token request was
used to establish these advertised limits.

For an existing Claude Code setup, select the new identity explicitly:

```sh
claude --model 'gpt-6-astra[1m]'
```

Or enter `/model gpt-6-astra[1m]` inside Claude Code. `claudeSetup: true` seeds a
model only when no primary override exists; it preserves existing model selections
and shell wrappers. Update a wrapper that pins a different `--model` if necessary.

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
the model already saved in `~/.claude/settings.json` — that is written at
startup.

## Claude Code settings

With `claudeSetup: true`, `copilot-relay start` writes:

```text
ANTHROPIC_BASE_URL=http://127.0.0.1:4142
ANTHROPIC_AUTH_TOKEN=<dummy local token>
```

into:

```text
~/.claude/settings.json
```

The token is intentionally a dummy value because `copilot-relay` authenticates to
GitHub Copilot with your cached GitHub/Copilot tokens, not with Claude's token.

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
