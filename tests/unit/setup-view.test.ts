import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { stripVTControlCharacters } from "node:util"

// See log-rotation.test.ts: the home directory must be redirected before paths.ts loads, and
// Windows resolves it from USERPROFILE rather than HOME.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-setup-view-"))
process.env.HOME = home
process.env.USERPROFILE = home

const { renderSetupOutcomes } = await import("../../src/setup")
const { displayWidth } = await import("../../src/lib/terminal")

test.after(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

const outcomes = [
  { target: "claude-code-cli", path: "/home/u/.claude/settings.json", status: "updated" },
  { target: "claude-code-app", path: "/home/u/Library/Application Support/Claude", status: "skipped: the app has not run here" },
  { target: "codex-cli", path: "/home/u/.codex/config.toml", status: "already up to date" },
  { target: "codex-app", path: "/home/u/.codex/config.toml", status: "shares the Codex config above" },
]

test("setup prints a heading and one marked row per client with its result and where", () => {
  assert.deepEqual(renderSetupOutcomes(outcomes, "http://127.0.0.1:4142", false, true), [
    "Client setup · http://127.0.0.1:4142",
    "",
    "  CLIENT           RESULT        DETAIL",
    "  claude-code-cli  ✓ updated     /home/u/.claude/settings.json",
    "  claude-code-app  – skipped     the app has not run here",
    "  codex-cli        ✓ up to date  /home/u/.codex/config.toml",
    "  codex-app        ✓ up to date  shares the Codex config above",
  ])
})

test("setup prints paths under the home directory from ~, so a normal row fits 80 columns", () => {
  const userHome = os.homedir()
  const real = [
    { target: "claude-code-cli", path: path.join(userHome, ".claude", "settings.json"), status: "updated" },
    { target: "claude-code-app", path: path.join(userHome, "Library", "Application Support", "Claude-3p"), status: "already up to date" },
    { target: "codex-cli", path: path.join(userHome, ".codex", "config.toml"), status: "already up to date" },
  ]
  const lines = renderSetupOutcomes(real, "http://127.0.0.1:4142", false, false)

  assert.match(lines[3], new RegExp(`ok updated +${path.join("~", ".claude", "settings.json").replace(/[\\.]/g, "\\$&")}$`))
  for (const line of lines) {
    assert.ok(displayWidth(line) <= 80, `${displayWidth(line)}: ${line}`)
  }
})

test("a failed client is marked without relying on color, and a long detail is cut", () => {
  const failed = [{ target: "codex-cli", path: "", status: `failed: ${"x".repeat(80)}` }]
  const lines = renderSetupOutcomes(failed, "http://127.0.0.1:4142", false, false)

  assert.match(lines[3], /^ {2}codex-cli {2}x failed {2}x+…$/)
  assert.ok(lines.every((line) => displayWidth(line) <= 80))

  const colored = renderSetupOutcomes(failed, "http://127.0.0.1:4142", true, false)
  assert.deepEqual(colored.map((line) => stripVTControlCharacters(line)), lines)
  assert.match(colored[3], /\u001b\[31mx failed\u001b\[0m/)
})
