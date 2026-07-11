# copilot-relay

[![CI](https://github.com/D0n9X1n/copilot-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/D0n9X1n/copilot-relay/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/copilot-relay.svg?logo=npm)](https://www.npmjs.com/package/copilot-relay)
[![npm downloads](https://img.shields.io/npm/dm/copilot-relay.svg?logo=npm)](https://www.npmjs.com/package/copilot-relay)
[![GitHub Packages](https://img.shields.io/badge/GitHub%20Packages-ready-24292f?logo=github)](https://github.com/D0n9X1n/copilot-relay/pkgs/npm/copilot-relay)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-supported-d97757)](https://docs.anthropic.com/en/docs/claude-code/overview)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Yet, just another relay for Claude Code to use a GitHub Copilot subscription.

## Disclaimer

This is a research-oriented project and is not affiliated with GitHub, GitHub
Copilot, Anthropic, or Claude Code. It depends on upstream GitHub Copilot
services and undocumented compatibility behavior, so Copilot availability, model
access, API behavior, and runtime stability are not guaranteed.

Public API:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /healthz`

Claude WebSearch is bridge-managed: when the model selects the WebSearch tool,
the relay executes Copilot `/responses` with `web_search_preview`, then sends the
retrieved context through a final model pass and returns Claude
`server_tool_use` / `web_search_tool_result` blocks. Unknown API routes return
`500` and log method, path, selected headers, and request payload to help
implement compatible endpoints later.

Routing:

| Requested model | Upstream model |
| --- | --- |
| contains `opus` | `claude-opus-4.8` |
| `gpt-5.6-sol[1m]`, plain `gpt-5.6-sol`, or another non-Opus alias | `gpt-5.6-sol` |

The relay advertises `gpt-5.6-sol[1m]` to Claude Code. The `[1m]` selector
changes Claude Code's client-side context budgeting only; every Copilot request
still uses `gpt-5.6-sol`, and the relay cannot enlarge GitHub Copilot's upstream
capacity. An explicit CLI or API model override that bypasses the managed Claude
settings is outside this guarantee.

Claude Code can still show its built-in Haiku and Sonnet picker entries. The
managed `model` field sets the startup default but does not restrict
`availableModels`; selecting any non-Opus alias still follows the GPT route.

## Install & run

```sh
npx copilot-relay@latest auth
npx copilot-relay@latest start
npx copilot-relay@latest restart
npx copilot-relay@latest stop
```

With `claudeSetup: true`, `start` manages `ANTHROPIC_BASE_URL`, a dummy
`ANTHROPIC_AUTH_TOKEN` when auth is absent, and the configured GPT default via
the top-level `model` field in `~/.claude/settings.json`. Exact
`gpt-5.6-sol` model overrides are normalized to the Claude-facing
`gpt-5.6-sol[1m]` identity; unrelated model choices are preserved.

## Config

Config lives at `~/.copilot-relay/config.yaml` and is hot-reloaded:

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
```

`logLevel` controls verbosity:

| Level | Logs |
| --- | --- |
| `error` | Startup, preflight, and request failures |
| `info` | Errors plus startup status, preflight status, request IDs, upstream lifecycle, and local HTTP status codes |
| `debug` | Info plus model routing summaries, Copilot upstream timings, and request payloads |

Any other `logLevel` value is invalid and stops startup.

Valid `thinkEffort`: `none`, `low`, `medium`, `high`, `xhigh`, `max`.

`upstreamTimeoutSeconds` controls the maximum time a single Claude request can
spend waiting on upstream Copilot calls, including chat, Responses, preflight,
and bridge-managed WebSearch calls. The default is `180`.

`webSearchBackend` controls bridge-managed Claude WebSearch. Leave it empty to
use `gptModel`, or set a Copilot Responses model ID such as `gpt-5.5`.

The same folder stores `copilot_token.json` for the cached Copilot bearer token, `github_token` for refresh/login, and `logs/` for runtime logs.

## CLI

```sh
copilot-relay auth
copilot-relay start
copilot-relay restart
copilot-relay stop
```

## Logging

At `debug`, every model request logs the requested model, upstream model, requested think effort, requested thinking, and effective think effort.

Upstream failures are logged at `error` with full request and response context in the same log file.

Unsupported Claude API requests are logged at `error` with the local method/path
and detailed request payload.

Logs are written to `~/.copilot-relay/logs/copilot-relay.log`; old `.log` files are cleaned according to `logRetentionDays`.

Quick inspection:

```sh
tail -f ~/.copilot-relay/logs/copilot-relay.log
grep -n "Failed to create\\|Startup preflight failed" ~/.copilot-relay/logs/copilot-relay.log
```

See [`docs/troubleshooting.md`](docs/troubleshooting.md) for common debugging workflows.

## Development

Developer notes live in [`docs/development.md`](docs/development.md).
Architecture notes live in [`docs/architecture.md`](docs/architecture.md).
Logging notes live in [`docs/logging.md`](docs/logging.md).
Troubleshooting notes live in [`docs/troubleshooting.md`](docs/troubleshooting.md).

```sh
npm install
npm run typecheck
npm run build
npm test
```
