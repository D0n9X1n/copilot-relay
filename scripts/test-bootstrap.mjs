// Loaded before tsx and source modules in every test process. A private tmpdir
// also contains existing per-suite mkdtemp homes, including ones not removed by
// their suite. Never infer cleanup ownership from a mutable environment value.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isMainThread } from "node:worker_threads"

if (isMainThread) {
  const owned = mkdtempSync(join(tmpdir(), "copilot-relay-test-"))
  const home = join(owned, "home")
  const temporary = join(owned, "tmp")
  mkdirSync(home)
  mkdirSync(temporary)
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.TMPDIR = temporary
  process.env.TMP = temporary
  process.env.TEMP = temporary
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
    if (inheritedLevel === undefined) delete process.env.CONSOLA_LEVEL
    else process.env.CONSOLA_LEVEL = inheritedLevel
  }
}
