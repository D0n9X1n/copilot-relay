// Loaded before tsx and source modules in every test process. A private tmpdir
// also contains existing per-suite mkdtemp homes, including ones not removed by
// their suite. Never infer cleanup ownership from a mutable environment value.
import { Console } from "node:console"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isMainThread } from "node:worker_threads"

// tsx's unawaited disk-cache writes can race exit cleanup in loader workers.
process.env.TSX_DISABLE_CACHE = "1"

if (isMainThread) {
  const owned = mkdtempSync(join(tmpdir(), "copilot-relay-test-"))
  const home = join(owned, "home")
  const temporary = join(owned, "tmp")
  mkdirSync(home)
  mkdirSync(temporary)

  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere, and os.tmpdir()
  // reads TMPDIR, TMP or TEMP depending on the platform, so every variant is set.
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.TMPDIR = temporary
  process.env.TMP = temporary
  process.env.TEMP = temporary

  // rmSync, not rm: Node abandons queued async work once "exit" listeners return.
  process.once("exit", () => {
    rmSync(owned, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  // Latch the in-process logger before any source import, then restore the
  // environment so CLI subprocesses retain their normal --help output.
  const inheritedLevel = process.env.CONSOLA_LEVEL
  process.env.CONSOLA_LEVEL = "0"
  try {
    const { default: consola } = await import("consola")
    consola.level = 0
  } finally {
    if (inheritedLevel === undefined) {
      delete process.env.CONSOLA_LEVEL
    } else {
      process.env.CONSOLA_LEVEL = inheritedLevel
    }
  }

  // A test file's stdout carries the result frames its runner reads back. Plain text there can make
  // Node's runner join two reads out of order and lose the file's results. So in a test file the
  // runner started, the relay logger and the console write to stderr, which the runner reports as
  // diagnostics. A process a test starts itself keeps its stdout: that test reads it as data.
  const isRunnerTestFile =
    process.env.NODE_TEST_CONTEXT === "child-v8" && /\.test\.[cm]?[jt]s$/.test(process.argv[1] ?? "")

  if (isRunnerTestFile) {
    const { default: consola } = await import("consola")
    consola.options.stdout = process.stderr
    globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })
  }
}
