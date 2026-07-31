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
thinkEffort: xhigh
upstreamTimeoutSeconds: 180
webSearchBackend:
gptModel: gpt-5.5
opusModel: claude-opus-4.8
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
| `thinkEffort` | Default upstream reasoning effort: `none`, `low`, `medium`, `high`, `xhigh`. |
| `upstreamTimeoutSeconds` | Max seconds one Claude request can wait for upstream Copilot calls. Default: `180`. |
| `webSearchBackend` | Optional Copilot Responses model for bridge-managed WebSearch. Empty uses `gptModel`. |
| `gptModel` | Upstream model for non-Opus requests. |
| `opusModel` | Upstream model for requested models containing `opus`. |

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
