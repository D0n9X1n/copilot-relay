// Static process defaults that are not intended to be user-tuned.
import path from "node:path"
import os from "node:os"

/**
 * Static defaults for copilot-relay. Previously these lived in
 * `~/.config/copilot-relay/settings.json`, but that file became an implicit
 * third source of truth alongside `~/.claude/settings.json`, which caused
 * subtle port-mismatch bugs. The relay's host and port now come from
 * `~/.copilot-relay/config.yaml`, whose shipped defaults are `defaultConfig`
 * in app-config.ts.
 */

export const defaultHost = "127.0.0.1"
export const defaultPort = 4142

// Claude Code reads $CLAUDE_CONFIG_DIR/settings.json, or ~/.claude/settings.json when it is unset.
export const getClaudeConfigPath = (): string =>
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "settings.json")

// Codex reads $CODEX_HOME, or ~/.codex when it is unset. Resolved on each call so a test that
// redirects the home directory or CODEX_HOME sees its own.
export const getCodexHome = (): string =>
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
