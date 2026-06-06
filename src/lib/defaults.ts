// Static process defaults that are not intended to be user-tuned.
import path from "node:path"
import os from "node:os"

/**
 * Static defaults for copilot-relay. Previously these lived in
 * `~/.config/copilot-relay/settings.json`, but that file ended up being a
 * silent third source of truth alongside `~/.claude/settings.json`, which
 * caused subtle port-mismatch bugs. copilot-relay now relies on these defaults
 * plus CLI flags only.
 */

export const defaultHost = "127.0.0.1"
export const defaultPort = 4142

export const claudeConfigPath = path.join(
  os.homedir(),
  ".claude",
  "settings.json",
)
