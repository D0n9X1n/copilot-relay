# copilot-relay

**Use Claude Code with the models available through your GitHub Copilot subscription.**

[![CI](https://github.com/D0n9X1n/copilot-relay/actions/workflows/ci.yml/badge.svg)](https://github.com/D0n9X1n/copilot-relay/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/copilot-relay.svg?logo=npm)](https://www.npmjs.com/package/copilot-relay)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Features

- **Claude Code, familiar workflow** — Messages API compatibility, streaming responses, and tool calls.
- **WebSearch that fits the conversation** — relay-managed search, followed by an answer that can still use your tools.
- **Your models, your settings** — configurable GPT/Opus routes and reasoning effort; existing selections survive upgrades.
- **Use the advertised capacity** — discovered context/output limits, without silently shortening your input.
- **Know what works** — model discovery and opt-in per-model deep checks with clear results.*
- **Run it your way** — foreground CLI or background service on macOS, Windows, and Linux.

\* Model discovery, deep checks, and the Opus 5.5 fresh-install default require
**v0.3.10 or later**.

## Quick start

You need **Node.js 22+**, **Claude Code**, and a GitHub account with Copilot access
to the models you select.

```sh
npm install -g copilot-relay
copilot-relay auth
copilot-relay start
```

Follow the device-login prompt. Keep the relay running in this terminal; by default,
startup configures Claude Code's connection in `~/.claude/settings.json`.
Open a **second terminal** and run:

```sh
claude
```

Configuration lives in `~/.copilot-relay/config.yaml`. Model access depends on your
account and organization policy; if startup rejects a model, choose an available
one using the [configuration guide](wiki/EN-Configuration.md).

Discover models and optionally test one (v0.3.10+):

```sh
copilot-relay models
copilot-relay models --deep --model claude-opus-5.5
```

Deep checks **consume Copilot usage** and test an isolated relay pipeline, not the
running daemon. Use `copilot-relay status --deep` for daemon health, and
`copilot-relay stop` when finished.

## Go further

**[Open the Wiki](https://github.com/D0n9X1n/copilot-relay/wiki)** · **[English / 中文](wiki/README.md)**

- [Configure models and deep checks](wiki/EN-Configuration.md) · [中文](wiki/ZH-Configuration.md)
- Run at login: [macOS](wiki/EN-macOS-LaunchAgent.md) · [Windows](wiki/EN-Windows-Service.md) · [Linux](wiki/EN-Linux-systemd.md)
- [Troubleshoot](wiki/EN-Logging-Troubleshooting.md) · [Understand the architecture](wiki/EN-Architecture.md) · [Contribute](wiki/EN-Development.md)

Unofficial research project; not affiliated with GitHub or Anthropic. Upstream
services and compatibility can change. Model and tool support are not guaranteed;
see the Wiki for known limitations. [MIT licensed](LICENSE).
