import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// paths.ts resolves the home directory when it loads, and Windows reads USERPROFILE, not HOME.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-config-reload-log-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { readAppConfig, watchAppConfig } = await import("../../src/lib/app-config")
const { flushLogs, log, withoutConsoleLogging } = await import("../../src/lib/log")
const { getLogPath, paths } = await import("../../src/lib/paths")

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

// A value pasted under the wrong key can be a new credential that no log redaction knows.
const secret = "SYNTHETIC_UNREGISTERED_SECRET"

const readReloadEntry = async (): Promise<string> => {
  // File writes are fire-and-forget, so poll until the entry lands.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await flushLogs()
    const content = await fs.readFile(getLogPath(), "utf8").catch(() => "")
    const entry = content.split("\n").find((line) => line.includes("Could not reload config"))
    if (entry) {
      return entry
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error("the reload error was never logged")
}

test("a rejected config value reaches neither the console nor the log file", async (t) => {
  await readAppConfig()

  let poll: (() => void | Promise<void>) | undefined
  t.mock.method(globalThis, "setInterval", (callback: () => void | Promise<void>) => {
    poll ??= callback
    return { unref() {} } as unknown as ReturnType<typeof setInterval>
  })

  // The console reporter renders exactly these arguments; calling through also feeds the file.
  const entries: string[] = []
  const logError = log.error
  t.mock.method(log, "error", (...values: unknown[]) => {
    entries.push(values.map(String).join(" "))
    Reflect.apply(logError, log, values)
  })

  watchAppConfig(() => {})
  assert.ok(poll, "watchAppConfig must register its interval callback")
  const original = await fs.readFile(paths.configPath, "utf8")
  await withoutConsoleLogging(async () => {
    await poll?.()
    await fs.writeFile(
      paths.configPath,
      original.replace(/^logLevel: .*$/m, `logLevel: "https://user:${secret}@gateway.invalid"`),
    )
    await poll?.()
  })

  assert.equal(entries.length, 1)
  assert.match(entries[0], /Invalid logLevel: expected one of error, info, debug\./)
  assert.ok(!entries[0].includes(secret), "the console entry must not repeat the value")

  const entry = await readReloadEntry()
  assert.match(entry, /Invalid logLevel/)
  assert.ok(!entry.includes(secret), "the log file must not repeat the value")
})
