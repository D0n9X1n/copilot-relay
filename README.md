# copilot-relay

[![CI](https://github.com/D0n9X1n/copilot-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/D0n9X1n/copilot-relay/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/copilot-relay.svg?logo=npm)](https://www.npmjs.com/package/copilot-relay)
[![npm downloads](https://img.shields.io/npm/dm/copilot-relay.svg?logo=npm)](https://www.npmjs.com/package/copilot-relay)
[![GitHub Packages](https://img.shields.io/badge/GitHub%20Packages-ready-24292f?logo=github)](https://github.com/D0n9X1n/copilot-relay/pkgs/npm/copilot-relay)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-supported-d97757)](https://docs.anthropic.com/en/docs/claude-code/overview)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

`copilot-relay` is a small GitHub Copilot proxy for Claude Code.

Public API:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /healthz`

Routing:

| Requested model | Upstream model |
| --- | --- |
| contains `opus` | `claude-opus-4.8` |
| anything else | `gpt-5.5` |

## Install & run

```sh
npx copilot-relay@latest auth
npx copilot-relay@latest start
```

`start` writes `ANTHROPIC_BASE_URL` and a dummy `ANTHROPIC_AUTH_TOKEN` into `~/.claude/settings.json`.

## Config

Config lives at `~/.copilot-relay/config.yaml` and is hot-reloaded:

```yaml
host: 127.0.0.1
port: 4142
copilotBaseUrl: https://api.githubcopilot.com
claudeSetup: true
logLevel: info
thinkEffort: xhigh
```

`logLevel` controls verbosity:

| Level | Logs |
| --- | --- |
| `silent` | Nothing |
| `error` | Startup, preflight, and request failures |
| `warn` | Errors plus recoverable warnings |
| `info` | Warnings plus startup status, preflight status, HTTP requests, and model routing summaries |
| `debug` | Info plus Copilot upstream timings, token refresh scheduling, and upstream error request summaries |
| `trace` | Debug plus full Claude request payloads and full upstream Copilot request payloads without redaction |

Valid `thinkEffort`: `none`, `low`, `medium`, `high`, `xhigh`.

The same folder stores `copilot_token.json` for the cached Copilot bearer token and `github_token` for refresh/login.

## CLI

```sh
copilot-relay auth
copilot-relay start
copilot-relay start --show-token
```

## Logging

At `info`, every model request logs the requested model, upstream model, requested think effort, requested thinking, and effective think effort.

At `trace`, copilot-relay logs the full Claude request payload and full upstream request payload without redaction.

## Development

Developer notes live in [`docs/development.md`](docs/development.md).

```sh
npm install
npm run typecheck
npm run build
npm test
```
