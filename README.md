# copilot-relay

**Use Claude Code with the models available through your GitHub Copilot subscription.**

[![CI](https://img.shields.io/github/actions/workflow/status/D0n9X1n/copilot-relay/ci.yml?branch=main&logo=githubactions&logoColor=white&label=CI)](https://github.com/D0n9X1n/copilot-relay/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/copilot-relay?logo=npm)](https://www.npmjs.com/package/copilot-relay) [![npm downloads](https://img.shields.io/npm/dm/copilot-relay?logo=npm&label=downloads)](https://www.npmjs.com/package/copilot-relay) [![GitHub release](https://img.shields.io/github/v/release/D0n9X1n/copilot-relay?logo=github)](https://github.com/D0n9X1n/copilot-relay/releases/latest)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](https://nodejs.org/) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json) [![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)](wiki/README.md) [![License: MIT](https://img.shields.io/github/license/D0n9X1n/copilot-relay?color=blue)](LICENSE)

[![Watch the 80-second introduction to copilot-relay](https://raw.githubusercontent.com/D0n9X1n/copilot-relay/main/.github/assets/copilot-relay-explained.jpg)](https://github.com/D0n9X1n/copilot-relay/blob/main/.github/assets/copilot-relay-explained.mp4)

## Features

- **Claude Code, familiar workflow** — Messages API compatibility, streaming responses, and tool calls.
- **WebSearch that fits the conversation** — relay-managed search, followed by an answer that can still use your tools.
- **Your models, your settings** — configurable GPT/Opus routes and reasoning effort; existing selections survive upgrades.
- **Use the advertised capacity** — discovered context/output limits, without silently shortening your input.
- **Use advertised chat models** — catalog-driven endpoint selection, optional effort support, and clear opt-in per-model deep checks.
- **Choose Claude's upstream protocol** — `claudeUpstreamApi: chat-completions` stays the default; opt into `auto` or `messages` for native Claude transport.
- **Diagnose offline** — debug mode captures full observed bodies for `copilot-relay replay`; captures contain unredacted prompts and must never be shared wholesale.
- **Run it your way** — foreground CLI or background service on macOS, Windows, and Linux; set `apiKey` to require a client key before binding beyond loopback.

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
one using the [configuration guide](wiki/EN-Configuration.md). Behind a proxy, set
`upstreamProxy` in `config.yaml` to its URL, or `env`, before `copilot-relay auth`.

Discover models, find the config value for one, and optionally test it:

```sh
copilot-relay models
copilot-relay models sol fast    # prints the exact gptModel or opusModel line
copilot-relay models --deep --model claude-opus-5.5
```

Deep checks **consume Copilot usage** and test an isolated relay pipeline, not the
running daemon. Add `--details` for safe failure evidence and private replay hints.
Use `copilot-relay status --deep` for daemon health, and `copilot-relay stop` when finished.

Check how well prompt caching works per model and upstream route. The report reads
only local logs and shows a hit rate below the goal, 95% by default, in red:

```sh
copilot-relay cache                  # last 24 hours
copilot-relay cache --hourly         # or --daily; narrow with --since 6h or --model opus
copilot-relay cache --json
```

Check your Copilot plan and quota with `copilot-relay usage`; add `--json` for
scripts. It asks GitHub with the stored token, so no relay needs to run.

## Go further

**[Open the Wiki](https://github.com/D0n9X1n/copilot-relay/wiki)** · **[English / 中文](wiki/README.md)**

- [Configure models and deep checks](wiki/EN-Configuration.md) · [中文](wiki/ZH-Configuration.md)
- Run at login: [macOS](wiki/EN-macOS-LaunchAgent.md) · [Windows](wiki/EN-Windows-Service.md) · [Linux](wiki/EN-Linux-systemd.md)
- [Commands](wiki/EN-Commands.md) · [Prompt caching](wiki/EN-Prompt-Caching.md) · [Troubleshoot](wiki/EN-Logging-Troubleshooting.md) · [Understand the architecture](wiki/EN-Architecture.md) · [Contribute](wiki/EN-Development.md)

Unofficial research project; not affiliated with GitHub or Anthropic. Upstream
services and compatibility can change. Model and tool support are not guaranteed;
see the Wiki for known limitations. [MIT licensed](LICENSE).
