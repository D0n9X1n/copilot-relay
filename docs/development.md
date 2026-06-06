# copilot-relay development notes

## Goal

`copilot-relay` is just another relay for Claude Code to use a GitHub Copilot subscription. Do not add public OpenAI-compatible APIs unless the product direction changes.

Public API surface:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /healthz`

The proxy may call Copilot upstream `/chat/completions` and `/responses` internally, but those routes are not public.

## Current architecture

See [`architecture.md`](architecture.md) for the detailed design.
See [`logging.md`](logging.md) for log formats and debugging workflows.

```text
Claude Code
  -> Hono server
  -> src/routes/claude.ts
  -> src/claude/*      # Claude request/response translation
  -> src/copilot/*        # GitHub Copilot upstream client
  -> GitHub Copilot API
```

Runtime files:

```text
~/.copilot-relay/
  config.yaml          # hot-reloaded runtime config
  github_token         # GitHub OAuth/device token
  copilot_token.json   # cached Copilot bearer token + refresh metadata
  logs/                # runtime logs
```

## Configuration-first rule

Prefer config over hardcoded behavior. If a behavior can reasonably be configured, add it to `~/.copilot-relay/config.yaml` and `config.default.yaml`.

Current config keys:

```yaml
host: 127.0.0.1
port: 4142
copilotBaseUrl: https://api.githubcopilot.com
claudeSetup: true
logLevel: info
logRetentionDays: 3
thinkEffort: xhigh
gptModel: gpt-5.5
opusModel: claude-opus-4.8
```

The config file is hot-reloaded. Runtime reload currently updates log level, think effort, host/port values held in config, Copilot base URL, and model routing. A listening socket cannot move ports without restart, so changing `host` or `port` still requires restart to affect the bound server.

## Model routing

The default routing is:

- requested model containing `opus` -> `opusModel`
- anything else -> `gptModel`

Startup preflight must validate configured upstream models and configured `thinkEffort`. Valid efforts are `none`, `low`, `medium`, `high`, and `xhigh`.

## Logging

Log levels:

| Level | Logs |
| --- | --- |
| `silent` | Nothing |
| `error` | Startup, preflight, and request failures |
| `warn` | Errors plus recoverable warnings |
| `info` | Warnings plus startup status, preflight status, HTTP requests, and model routing summaries |
| `debug` | Info plus Copilot upstream timings, token refresh scheduling, and upstream error request summaries |
| `trace` | Debug plus full Claude request payloads and full upstream Copilot request payloads without redaction |

At `info`, every model request must log:

- client type
- requested model
- upstream model
- requested think effort
- requested thinking budget
- effective think effort

At `trace`, log the full Claude request payload and full upstream request payload without redaction.

Logs are appended to `~/.copilot-relay/logs/copilot-relay.log`. Startup cleanup removes old `.log` files according to `logRetentionDays`.

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

On startup, use the cached Copilot token if it has more than 60 seconds remaining. Otherwise refresh from `github_token`. Refresh timers must use `unref()` so they do not keep short-lived commands alive.

## Things intentionally removed

Do not reintroduce these without a product decision:

- public `/v1/chat/completions`
- public `/v1/embeddings`
- `/usage`
- Codex support
- Auto mode
- WebSearch support
- rate limiting
- Bun-only scripts

## Build and checks

```sh
npm install
npm run typecheck
npm run build
npm test
```

Tests currently use Node's built-in test runner.

## CI and publishing

CI lives in `.github/workflows/ci.yml` and runs on Linux, macOS, and Windows:

- install dependencies
- typecheck
- unit tests
- integration tests
- build

Publishing lives in `.github/workflows/publish.yml`.

- `0.0.x` versions are for package publishing smoke tests.
- `0.1.0` should be published only after local and CI checks are clean.
- pushing a `v*` tag creates or updates the GitHub Release and uploads the npm tarball plus `SHA256SUMS`
- npm publish uses npm Trusted Publishing with GitHub Actions OIDC, so it requires `id-token: write` in the workflow instead of `NPM_TOKEN`
- configure npm's trusted publisher for repository `D0n9X1n/copilot-relay` and workflow `.github/workflows/publish.yml`; npm matches these fields exactly
- GitHub Packages publish uses `GITHUB_TOKEN`
- the GitHub package is published as `@<owner>/copilot-relay`

Integration tests mock the upstream GitHub Copilot API with a local HTTP server. Do not call real Copilot services from CI tests.
