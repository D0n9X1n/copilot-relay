import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inspect, type InspectOptions } from "node:util"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-fmt-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { log, setLogLevel } = await import("../../src/lib/log")
const { getLogPath, paths } = await import("../../src/lib/paths")

const readActiveLog = async (): Promise<string> => {
  // File writes are fire-and-forget so logging never blocks a request.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const content = await fs.readFile(getLogPath(), "utf8").catch(() => "")
    if (content) {
      return content
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("log file was never written")
}

test.beforeEach(async () => {
  await fs.rm(paths.logsDir, { force: true, recursive: true })
  setLogLevel("debug")
})

// Why: this was two thirds of the 9.3 GB. inspect(depth: null) pretty-printed
// each payload across thousands of indented lines - 226,488 of 275,442 sampled
// lines were object-dump continuations. One entry must be one line.
test("collapses a nested payload onto a single line", async () => {
  log.error("Failed to create responses", {
    request: {
      messages: [{ content: "hello", role: "user" }],
      model: "gpt-5.6-sol",
      tools: [{ function: { name: "Read", parameters: { type: "object" } } }],
    },
    response: { body: { error: { message: "bad request" } }, status: 400 },
  })

  const content = await readActiveLog()
  const lines = content.trimEnd().split("\n")

  assert.equal(lines.length, 1)
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z error Failed to create responses/)
  assert.match(lines[0], /status: 400/)
})

// Why: the grep recipes in wiki/EN-Logging-Troubleshooting.md search for a
// message and expect the matching line to carry its context. Multi-line dumps
// returned a fragment.
test("keeps message and context greppable on one line", async () => {
  log.error("Startup preflight failed", {
    detail: { attempted: ["gpt-5.6-sol", "claude-opus-5"] },
    model: "claude-opus-5",
  })

  const content = await readActiveLog()
  const matched = content
    .split("\n")
    .filter((line) => line.includes("Startup preflight failed"))

  assert.equal(matched.length, 1)
  assert.match(matched[0], /claude-opus-5/)
})

// Why: an unbounded string in a payload (a pasted file, a base64 blob) could
// otherwise write megabytes in a single entry.
test("truncates oversized strings inside payloads", async () => {
  log.error("Large payload", { blob: "x".repeat(50_000) })

  const content = await readActiveLog()
  const lines = content.trimEnd().split("\n")

  assert.equal(lines.length, 1)
  assert.ok(
    lines[0].length < 10_000,
    `expected truncation, got ${lines[0].length} bytes`,
  )
  assert.match(lines[0], /more characters/)
})

// Why: deeply nested tool schemas recurse far enough to be worth bounding, but
// the entry must still identify what failed.
test("bounds depth without losing the message", async () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: "bottom" } } } } } } } }
  log.error("Deep payload", deep)

  const content = await readActiveLog()
  const lines = content.trimEnd().split("\n")

  assert.equal(lines.length, 1)
  assert.match(lines[0], /Deep payload/)
})

// Why: plain strings are the common case and must not be quoted or reformatted,
// or every documented grep pattern would need to change.
test("passes string messages through unchanged", async () => {
  log.info("request_id=abc123 POST /v1/messages -> 200 1234ms")

  const content = await readActiveLog()

  assert.match(content, /info request_id=abc123 POST \/v1\/messages -> 200 1234ms/)
})

// Why: guards against "simplifying" the logger back to Node's default compact.
// The Node docs say breakLength: Infinity formats on one line "in combination
// with compact set to true or any number >= 1", which reads as though the
// default compact: 3 would do. It does not - the number counts inner elements
// united, not a threshold - so it only collapses payloads nesting no deeper
// than that count. Asserted directly against inspect so the reason this option
// is set survives independently of the logger's own output.
test("compact: true is required beyond the default compact depth", () => {
  // Four levels deep, the shape a Copilot upstream error actually logs.
  const payload = {
    request: {
      messages: [{ content: "hello", role: "user" }],
      tools: [{ function: { name: "Read", parameters: { type: "object" } } }],
    },
    response: { body: { error: { message: "bad request" } }, status: 400 },
  }

  const lines = (options: InspectOptions): number =>
    inspect(payload, { breakLength: Infinity, depth: 6, ...options }).split("\n")
      .length

  // The default does not collapse this payload, breakLength notwithstanding.
  assert.ok(
    lines({ compact: 3 }) > 1,
    "expected default compact: 3 to leave this payload multi-line",
  )
  // Lowering the count makes it worse, which no threshold reading predicts.
  assert.ok(lines({ compact: 1 }) > lines({ compact: 3 }))
  // compact: true is depth-independent and is what the logger relies on.
  assert.equal(lines({ compact: true }), 1)
})

test.after(async () => {
  await fs.rm(tempHome, { force: true, recursive: true })
})
