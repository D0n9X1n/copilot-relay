import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inspect, promisify, type InspectOptions } from "node:util"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-fmt-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { log, setLogLevel, isDebugLogging, flushLogs } = await import("../../src/lib/log")
const { getLogPath, paths } = await import("../../src/lib/paths")

const consoleOutput: Array<string> = []
log.setReporters([{
  log: (entry: { args: Array<unknown> }) => {
    consoleOutput.push(entry.args.map((value) => typeof value === "string" ? value : inspect(value)).join(" "))
  },
}])

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
  await flushLogs()
  await fs.rm(paths.logsDir, { force: true, recursive: true })
  consoleOutput.length = 0
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

for (const [name, payload] of [
  ["plain string", "request failed " + "x".repeat(2 * 1024 * 1024)],
  ["escaped multiline string", "request failed " + "line\r\n".repeat(400_000)],
  ["multibyte string", "request failed " + "診断".repeat(400_000)],
] as const) {
  test(`bounds a multi-MiB ${name} to 16 KiB in both sinks`, async () => {
    log.error(payload)
    await flushLogs()
    const file = await fs.readFile(getLogPath(), "utf8")
    const rendered = file.slice(0, -1).replace(/^\S+ error /, "")
    assert.ok(Buffer.byteLength(rendered) <= 16 * 1024, "one rendered argument exceeded 16 KiB")
    assert.equal(consoleOutput.length, 1)
    assert.equal(rendered, consoleOutput[0])
    assert.ok(rendered.startsWith("request failed "))
    assert.ok(rendered.endsWith("[truncated]"))
    assert.doesNotMatch(rendered, /[\r\n]/)
    assert.ok(!rendered.includes(String.fromCodePoint(0xfffd)), "truncation split a UTF-8 character")
  })
}

test("bounds a multi-argument entry to 64 KiB including file framing", async () => {
  log.error("argument-0 " + "x".repeat(12 * 1024),
    ...Array.from({ length: 31 }, (_, index) => `argument-${index + 1} ` + "x".repeat(12 * 1024)))
  await flushLogs()
  const file = await fs.readFile(getLogPath(), "utf8")
  const rendered = file.slice(0, -1).replace(/^\S+ error /, "")
  assert.ok(Buffer.byteLength(file) <= 64 * 1024, "whole entry exceeded 64 KiB")
  assert.equal(consoleOutput.length, 1)
  assert.equal(rendered, consoleOutput[0])
  assert.ok(rendered.startsWith("argument-0 "))
  assert.ok(rendered.endsWith("[truncated]"))
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

test("keeps an Error stack on one physical line without losing frames", async () => {
  const error = new Error("upstream failed")
  error.stack = "Error: upstream failed\n    at request (relay.ts:12:3)\n    at dispatch (relay.ts:24:5)"
  log.error("Request failed", error)

  const content = await readActiveLog()
  assert.match(content, /\n$/)
  assert.doesNotMatch(content.slice(0, -1), /[\r\n]/)
  assert.match(content, /upstream failed/)
  assert.match(content, /request \(relay\.ts:12:3\)/)
  assert.match(content, /dispatch \(relay\.ts:24:5\)/)
})

for (const [name, separator] of [["LF", "\n"], ["CRLF", "\r\n"], ["CR", "\r"]]) {
  test(`keeps literal ${name} strings on one physical line`, async () => {
    log.error(`first${separator}second`, `context${separator}last`)

    const content = await readActiveLog()
    assert.match(content, /\n$/)
    assert.doesNotMatch(content.slice(0, -1), /[\r\n]/)
    for (const word of ["first", "second", "context", "last"]) {
      assert.ok(content.includes(word), `lost diagnostic text: ${word}`)
    }
  })
}

for (const existing of [false, true]) {
  test(`keeps ${existing ? "existing" : "new"} log paths private under umask 022`, {
    skip: process.platform === "win32",
  }, async () => {
    await fs.rm(paths.appDir, { recursive: true, force: true })
    const previousUmask = process.umask(0o022)
    try {
      if (existing) {
        await fs.mkdir(paths.logsDir, { recursive: true })
        await fs.writeFile(getLogPath(), "")
        await fs.chmod(paths.appDir, 0o755)
        await fs.chmod(paths.logsDir, 0o755)
        await fs.chmod(getLogPath(), 0o644)
      }

      log.error("private diagnostic")
      await readActiveLog()

      const modes = await Promise.all(
        [paths.appDir, paths.logsDir, getLogPath()].map(async (filePath) =>
          (await fs.stat(filePath)).mode & 0o777,
        ),
      )
      assert.deepEqual(modes, [0o700, 0o700, 0o600])
    } finally {
      process.umask(previousUmask)
    }
  })
}

test("does not append through an active log symlink or change its target mode", {
  skip: process.platform === "win32",
}, async () => {
  const home = await fs.mkdtemp(path.join(tempHome, "symlink-"))
  try {
    // beforeExit runs only after the logger's fire-and-forget filesystem work
    // drains, so this observes completion rather than sleeping for a guessed delay.
    const script = `
      import fs from "node:fs/promises";
      import { readFileSync, statSync } from "node:fs";
      import path from "node:path";
      const { log } = await import(${JSON.stringify(new URL("../../src/lib/log.ts", import.meta.url).href)});
      const { paths, getLogPath } = await import(${JSON.stringify(new URL("../../src/lib/paths.ts", import.meta.url).href)});
      log.setReporters([]);
      const target = path.join(process.env.HOME, "outside.log");
      await fs.writeFile(target, "untouched\\n");
      await fs.chmod(target, 0o644);
      await fs.mkdir(paths.logsDir, { recursive: true });
      await fs.symlink(target, getLogPath());
      process.once("beforeExit", () => {
        process.stdout.write(JSON.stringify({ content: readFileSync(target, "utf8"), mode: statSync(target).mode & 0o777 }));
      });
      log.error("must not reach outside");
    `
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", script,
    ], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, HOME: home, USERPROFILE: home },
      timeout: 10_000,
    })
    assert.deepEqual(JSON.parse(stdout), { content: "untouched\n", mode: 0o644 })
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
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

test("debug logging reflects the current file log level", () => {
  for (const [level, expected] of [["error", false], ["info", false], ["debug", true]] as const) {
    setLogLevel(level)
    assert.equal(isDebugLogging(), expected)
  }
})

test("flushLogs waits for queued writes without making logging synchronous", async (t) => {
  let release!: () => void
  let opened!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { opened = resolve })
  const realOpen = fs.open.bind(fs)
  const mockOpen = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args)
    if (args[0] === getLogPath()) {
      const append = handle.appendFile.bind(handle)
      t.mock.method(handle, "appendFile", async (...values: Parameters<typeof handle.appendFile>) => {
        opened()
        await waiting
        return append(...values)
      })
    }
    return handle
  })
  log.error("queued flush fixture")
  let flushed = false
  let flushing: Promise<void> | undefined
  try {
    flushing = flushLogs().then(() => { flushed = true })
    await entered
    assert.equal(flushed, false)
    release()
    await flushing
    assert.match(await fs.readFile(getLogPath(), "utf8"), /queued flush fixture/)
  } finally {
    release()
    await flushing
    await flushLogs()
    mockOpen.mock.restore()
  }
})

test.after(async () => {
  await flushLogs()
  await fs.rm(tempHome, { force: true, recursive: true })
})
