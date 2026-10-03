import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"

// paths.ts captures the home directory at import time, including on Windows.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay-config-preservation-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome
process.env.CONSOLA_LEVEL = "0"

const { readAppConfig, watchAppConfig } = await import("../../src/lib/app-config")
const { paths } = await import("../../src/lib/paths")
const { log } = await import("../../src/lib/log")
const { FileConflictError } = await import("../../src/lib/atomic-file")
type AppConfig = Awaited<ReturnType<typeof readAppConfig>>

const completeValues: Record<keyof AppConfig, string> = {
  host: "127.0.0.1",
  port: "4193",
  apiKey: "",
  copilotBaseUrl: "https://config-fixture.invalid",
  claudeSetup: "false",
  logLevel: "info",
  logRetentionDays: "7",
  thinkEffort: "high",
  upstreamTimeoutSeconds: "90",
  webSearchBackend: "search-fixture",
  gptModel: "gpt-fixture",
  opusModel: "opus-fixture",
  claudeUpstreamApi: "chat-completions",
}

const completeDocument = (
  changes: Partial<Record<keyof AppConfig, string>> = {},
  omit?: keyof AppConfig,
): string => Object.entries({ ...completeValues, ...changes })
  .filter(([key]) => key !== omit)
  .map(([key, value]) => `${key}: ${value}\n`)
  .join("")

let editTime = Date.UTC(2025, 0, 1)
const writeConfigFile = async (content: string): Promise<void> => {
  await fs.writeFile(paths.configPath, content)
  // A deterministic timestamp avoids depending on filesystem clock resolution.
  editTime += 2000
  await fs.utimes(paths.configPath, new Date(editTime), new Date(editTime))
}

const readConfigFile = (): Promise<string> => fs.readFile(paths.configPath, "utf8")

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Capture the actual interval callback so every filesystem operation can be
// awaited. Only scheduling and error output are replaced; parsing and writes
// use real temporary files, with no sleeps and no log files.
const startWatcher = async (t: TestContext, onReload: (next: AppConfig) => void) => {
  let poll: (() => void | Promise<void>) | undefined
  t.mock.method(globalThis, "setInterval", (callback: () => void | Promise<void>) => {
    poll = callback
    return { unref() {} } as unknown as ReturnType<typeof setInterval>
  })

  const errors: unknown[][] = []
  t.mock.method(log, "error", (...values: unknown[]) => {
    errors.push(values)
  })

  // Ignore whatever the baseline poll reports, so onReload sees only later reloads.
  let armed = false
  watchAppConfig((next) => {
    if (armed) {
      onReload(next)
    }
  })

  assert.ok(poll, "watchAppConfig must register its interval callback")
  await poll()
  armed = true

  return { poll, errors }
}

test.beforeEach(async () => {
  await fs.rm(paths.appDir, { force: true, recursive: true })
  await fs.mkdir(paths.appDir, { recursive: true })
})

test.after(async () => {
  await fs.rm(tempHome, { force: true, recursive: true })
})

for (const [key, value] of [
  ["claudeSetup", "no"],
  ["port", "0"],
  ["logRetentionDays", "0"],
  ["port", "4193junk"],
  ["port", "1.5"],
  ["port", "65536"],
  ["logRetentionDays", "7days"],
  ["logRetentionDays", "1.5"],
  ["host", "\"\""],
  ["copilotBaseUrl", ""],
  ["gptModel", "''"],
  ["opusModel", ""],
  ["apiKey", "short-key-15chr"],
  ["apiKey", "\"two words key value\""],
] as const) {
  test(`readAppConfig rejects explicit ${key}=${value || "(empty)"} without changing the file`, async () => {
    const original = `# keep this document\n${key}: ${value}\n`
    await writeConfigFile(original)

    await assert.rejects(readAppConfig(), new RegExp(`Invalid ${key}`))
    assert.equal(await readConfigFile(), original)
  })
}

test("a commented explicit false stays false and keeps its original spelling", async () => {
  const original = "# do not manage settings\nclaude_setup: false # opt out\n"
  await writeConfigFile(original)

  const config = await readAppConfig()

  assert.equal(config.claudeSetup, false)

  const written = await readConfigFile()
  assert.ok(written.startsWith(original))
  assert.doesNotMatch(written, /^claudeSetup:/m, "an alias already supplies the key")
})

test("quoted scalar hashes are values while trailing hashes introduce comments", async () => {
  const original = [
    'gptModel: "gpt-fixture # literal" # retain this note',
    "opusModel: 'opus-fixture # literal' # and this note",
    "",
  ].join("\n")
  await writeConfigFile(original)

  const config = await readAppConfig()

  assert.equal(config.gptModel, "gpt-fixture # literal")
  assert.equal(config.opusModel, "opus-fixture # literal")
  assert.ok((await readConfigFile()).startsWith(original))
})

test("startup appends every missing default without removing comments or unknown keys", async () => {
  const original = "# operator note\r\nport: 4193 # fixed local port\r\ncustom_hint: 'keep # me'\r\n"
  await writeConfigFile(original)

  const config = await readAppConfig()

  assert.equal(config.port, 4193)
  assert.equal(config.claudeSetup, true)
  assert.equal(config.logRetentionDays, 3)
  assert.equal(config.upstreamTimeoutSeconds, 180)
  assert.equal(config.webSearchBackend, undefined)

  const written = await readConfigFile()
  assert.ok(written.startsWith(original), "existing document bytes must survive")
  for (const key of Object.keys(completeValues)) {
    assert.equal(written.match(new RegExp(`^${key}:`, "gm"))?.length, 1, `${key} must be materialized once`)
  }

  assert.ok(!("custom_hint" in config), "unknown keys must remain inert")

  assert.deepEqual(await readAppConfig(), config)
  assert.equal(await readConfigFile(), written, "subsequent reads must be idempotent")
})

test("a complete document keeps empty backend, timeout zero, comments and bytes", async () => {
  const original = `# already materialized\n${completeDocument({ webSearchBackend: "", upstreamTimeoutSeconds: "0" })}`
  await writeConfigFile(original)
  const before = await fs.stat(paths.configPath)

  const config = await readAppConfig()

  assert.equal(config.webSearchBackend, undefined)
  assert.equal(config.upstreamTimeoutSeconds, 0)
  assert.equal(await readConfigFile(), original)
  assert.equal((await fs.stat(paths.configPath)).mtimeMs, before.mtimeMs, "a complete file needs no write")
})

for (const duplicate of [
  "port: 4193\nport: 4194\n",
  "claudeSetup: false\nclaude_setup: true\n",
  "gpt_model: first\ngptModel: second\n",
]) {
  test(`duplicate configuration keys are rejected: ${duplicate.trim().replaceAll("\n", ", ")}`, async () => {
    await writeConfigFile(duplicate)

    await assert.rejects(readAppConfig(), /duplicate/i)
    assert.equal(await readConfigFile(), duplicate)
  })
}

for (const unsupported of [
  "gptModel: [one, two]\n",
  "custom_hint:\n  nested: value\n",
  "gptModel: |\n",
  'gptModel: "unterminated\n',
]) {
  test(`unsupported YAML is rejected unchanged: ${unsupported.trim().replaceAll("\n", ", ")}`, async () => {
    await writeConfigFile(unsupported)

    await assert.rejects(readAppConfig(), /invalid|unsupported/i)
    assert.equal(await readConfigFile(), unsupported)
  })
}

test("startup preserves a config symlink and appends only missing keys to its target", async (t) => {
  const target = path.join(tempHome, "managed-config.yaml")
  const original = "# managed outside the application directory\nport: 4193\nowner_hint: external\n"
  await fs.writeFile(target, original)
  const linkTarget = path.relative(paths.appDir, target)

  try {
    await fs.symlink(linkTarget, paths.configPath, "file")
  } catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("Windows host does not permit file symlinks")
      return
    }

    throw error
  }

  await readAppConfig()

  assert.ok((await fs.lstat(paths.configPath)).isSymbolicLink())
  assert.equal(await fs.readlink(paths.configPath), linkTarget)
  const written = await fs.readFile(target, "utf8")
  assert.ok(written.startsWith(original))
  assert.match(written, /^webSearchBackend:/m)

  // Backdate the target, so a rewrite by the second read would change its mtime.
  await fs.utimes(target, new Date(editTime), new Date(editTime))
  const before = await fs.stat(target)

  await readAppConfig()

  assert.equal(await fs.readFile(target, "utf8"), written)
  assert.equal((await fs.stat(target)).mtimeMs, before.mtimeMs)
  assert.ok((await fs.lstat(paths.configPath)).isSymbolicLink())
})

test("missing defaults are published atomically without corrupting an open reader", async () => {
  const original = "# an already open document\nport: 4193\n"
  await writeConfigFile(original)
  const reader = await fs.open(paths.configPath, "r")
  try {
    // Windows refuses to rename over the open file, so the first publish
    // must fail cleanly there and succeed once the reader closes.
    if (process.platform === "win32") {
      await assert.rejects(readAppConfig(), { code: "EPERM", syscall: "rename" })
      assert.equal(await readConfigFile(), original)
      assert.deepEqual(await fs.readdir(paths.appDir), ["config.yaml"])
    } else {
      await readAppConfig()
    }

    assert.equal(await reader.readFile("utf8"), original)
  } finally {
    await reader.close()
  }

  if (process.platform === "win32") {
    await readAppConfig()
  }

  assert.match(await readConfigFile(), /^webSearchBackend:/m)
  assert.deepEqual(await fs.readdir(paths.appDir), ["config.yaml"])
})

test("startup refuses to publish defaults over a newer edit after its snapshot read", async (t) => {
  await writeConfigFile("port: 4193\n")
  const newest = `# newer editor save\n${completeDocument({ thinkEffort: "low" })}`
  const resolvedPath = await fs.realpath(paths.configPath)
  const realReadFile = fs.readFile
  let edited = false
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await realReadFile(...args)
    if ((args[0] === paths.configPath || args[0] === resolvedPath) && !edited) {
      edited = true
      await writeConfigFile(newest)
    }

    return bytes
  })

  await assert.rejects(readAppConfig(), /changed|conflict|concurrent/i)
  assert.equal(await readConfigFile(), newest)
})

test("generated config guidance identifies all restart-only settings", async () => {
  await readAppConfig()

  const written = await readConfigFile()
  assert.match(written, /host, port, and claudeSetup require restart/)
  assert.doesNotMatch(written, /This file is hot-reloaded while/)
})

test("hot reload applies a complete valid edit without rewriting the document", async (t) => {
  await writeConfigFile(completeDocument())
  let active = await readAppConfig()
  const watcher = await startWatcher(t, (next) => {
    active = next
  })

  const edited = `# edited by the operator\n${completeDocument({
    claudeSetup: "false # still opted out",
    thinkEffort: "low",
    webSearchBackend: "",
    upstreamTimeoutSeconds: "0",
  })}unknown_note: keep\n`
  await writeConfigFile(edited)
  const before = await fs.stat(paths.configPath)

  await watcher.poll()

  assert.equal(active.thinkEffort, "low")
  assert.equal(active.claudeSetup, false)
  assert.equal(active.upstreamTimeoutSeconds, 0)
  assert.equal(active.webSearchBackend, undefined)
  assert.equal(await readConfigFile(), edited)
  assert.equal((await fs.stat(paths.configPath)).mtimeMs, before.mtimeMs)
  assert.deepEqual(watcher.errors, [])
})

// Admission reads the live key on every request (#159), so a valid edit must reach it at once. A
// rejected edit keeps the previous key: dropping it would leave the relay open.
test("hot reload applies a changed or cleared apiKey and keeps the previous key through a rejected edit", async (t) => {
  const firstKey = "reload-fixture-key-0001"
  const secondKey = "reload-fixture-key-0002"
  const rejected = "REJECTED KEY SENTINEL"
  await writeConfigFile(completeDocument({ apiKey: firstKey }))
  let active = await readAppConfig()
  const watcher = await startWatcher(t, (next) => {
    active = next
  })

  assert.equal(active.apiKey, firstKey)

  await writeConfigFile(completeDocument({ apiKey: secondKey }))
  await watcher.poll()
  assert.equal(active.apiKey, secondKey)

  await writeConfigFile(completeDocument({ apiKey: `"${rejected}"` }))
  await watcher.poll()
  assert.equal(active.apiKey, secondKey, "a rejected edit keeps the previous key")
  assert.equal(watcher.errors.length, 1)
  assert.match(String(watcher.errors[0]?.[0]), /Invalid apiKey/)
  assert.ok(!String(watcher.errors[0]?.[0]).includes(rejected), "the error never repeats the value")

  await writeConfigFile(completeDocument({ apiKey: "" }))
  await watcher.poll()
  assert.equal(active.apiKey, "", "an empty key disables the check")
  assert.equal(watcher.errors.length, 1)
})

test("hot reload retries an unchanged valid edit after snapshot verification fails", async (t) => {
  await writeConfigFile(completeDocument())
  const previous = await readAppConfig()
  let active = previous
  let reloads = 0
  const watcher = await startWatcher(t, (next) => {
    active = next
    reloads++
  })

  const edited = completeDocument({ thinkEffort: "low" })
  await writeConfigFile(edited)
  const before = await fs.stat(paths.configPath)
  const resolvedPath = await fs.realpath(paths.configPath)
  const realReadFile = fs.readFile
  let configReads = 0
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if ((args[0] === paths.configPath || args[0] === resolvedPath) && ++configReads === 2) {
      throw Object.assign(new Error("Config file temporarily busy"), { code: "EBUSY" })
    }

    return realReadFile(...args)
  })

  await watcher.poll()
  assert.equal(configReads, 2, "the transient failure must occur during snapshot verification")
  assert.equal(active, previous)
  assert.equal(reloads, 0)
  assert.equal(watcher.errors.length, 1)

  await watcher.poll()
  assert.equal(active.thinkEffort, "low", "retry the same file without requiring another edit")
  assert.equal(reloads, 1)

  await watcher.poll()
  assert.equal(reloads, 1, "skip the unchanged snapshot only after applying it")
  assert.equal(watcher.errors.length, 1)
  assert.equal(await readConfigFile(), edited)
  assert.equal((await fs.stat(paths.configPath)).mtimeMs, before.mtimeMs)
  await assert.rejects(fs.stat(paths.logsDir), { code: "ENOENT" })
})

test("hot reload retries an unchanged valid edit after its callback throws", async (t) => {
  await writeConfigFile(completeDocument())
  const previous = await readAppConfig()
  let active = previous
  let attempts = 0
  const watcher = await startWatcher(t, (next) => {
    if (++attempts === 1) {
      throw new Error("Runtime settings temporarily unavailable")
    }

    active = next
  })

  const edited = completeDocument({ thinkEffort: "low" })
  await writeConfigFile(edited)

  await watcher.poll()
  assert.equal(attempts, 1)
  assert.equal(active, previous)
  assert.equal(watcher.errors.length, 1)

  await watcher.poll()
  assert.equal(attempts, 2)
  assert.equal(active.thinkEffort, "low")

  await watcher.poll()
  assert.equal(attempts, 2, "a successfully applied snapshot should not run the callback again")
  assert.equal(watcher.errors.length, 1)
  assert.equal(await readConfigFile(), edited)
  await assert.rejects(fs.stat(paths.logsDir), { code: "ENOENT" })
})

test("a failed reload is logged once, with its reason, until the file or the reason changes", async (t) => {
  await writeConfigFile(completeDocument())
  let active = await readAppConfig()
  const watcher = await startWatcher(t, (next) => {
    active = next
  })

  const message = (index: number): string => String(watcher.errors[index]?.[0])

  await writeConfigFile(completeDocument({ upstreamTimeoutSeconds: "-1" }))
  await watcher.poll()
  await watcher.poll()
  await watcher.poll()
  assert.equal(watcher.errors.length, 1, "an unchanged invalid file is retried without logging again")
  assert.match(message(0), /^Could not reload config \(/)
  assert.ok(message(0).includes(paths.configPath), "the entry names the file")
  assert.match(message(0), /Invalid upstreamTimeoutSeconds/)
  assert.match(message(0), / Keeping the previous runtime settings\.$/)
  assert.equal(active.upstreamTimeoutSeconds, 90)

  await writeConfigFile(completeDocument({ upstreamTimeoutSeconds: "-1" }))
  await watcher.poll()
  assert.equal(watcher.errors.length, 2, "saving the same invalid content again logs again")

  await writeConfigFile(completeDocument({ logRetentionDays: "0" }))
  await watcher.poll()
  await watcher.poll()
  assert.equal(watcher.errors.length, 3, "a different reason is logged")
  assert.match(message(2), /Invalid logRetentionDays/)

  await fs.unlink(paths.configPath)
  await watcher.poll()
  await watcher.poll()
  assert.equal(watcher.errors.length, 4, "a deleted file is logged once")
  assert.match(message(3), /Config file is missing/)

  await writeConfigFile(completeDocument({ upstreamTimeoutSeconds: "45" }))
  await watcher.poll()
  assert.equal(active.upstreamTimeoutSeconds, 45)
  assert.equal(watcher.errors.length, 4)

  await writeConfigFile(completeDocument({ upstreamTimeoutSeconds: "-1" }))
  await watcher.poll()
  assert.equal(watcher.errors.length, 5, "a failure after a successful reload is logged again")
  await assert.rejects(fs.stat(paths.logsDir), { code: "ENOENT" })
})

test("a read failure after the applied file reads cleanly again is logged again", async (t) => {
  await writeConfigFile(completeDocument())
  await readAppConfig()
  const watcher = await startWatcher(t, () => {})

  const resolvedPath = await fs.realpath(paths.configPath)
  const realReadFile = fs.readFile
  let busy = true
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (busy && (args[0] === paths.configPath || args[0] === resolvedPath)) {
      throw Object.assign(new Error("Config file temporarily busy"), { code: "EBUSY" })
    }

    return realReadFile(...args)
  })

  await watcher.poll()
  await watcher.poll()
  assert.equal(watcher.errors.length, 1, "one busy episode is logged once")

  busy = false
  await watcher.poll()
  assert.equal(watcher.errors.length, 1, "a clean read of the applied file logs nothing")

  busy = true
  await watcher.poll()
  assert.equal(watcher.errors.length, 2, "a later busy episode is logged again")
})

test("a config path that is a directory is logged once and recovers", async (t) => {
  await writeConfigFile(completeDocument())
  let active = await readAppConfig()
  const watcher = await startWatcher(t, (next) => {
    active = next
  })

  await fs.unlink(paths.configPath)
  await fs.mkdir(paths.configPath)
  await watcher.poll()
  await watcher.poll()
  assert.equal(watcher.errors.length, 1, "a lasting directory is reported once, not hidden")
  assert.match(String(watcher.errors[0]?.[0]), /is not a regular file/)
  assert.equal(active.upstreamTimeoutSeconds, 90)

  await fs.rmdir(paths.configPath)
  await writeConfigFile(completeDocument({ upstreamTimeoutSeconds: "45" }))
  await watcher.poll()
  assert.equal(active.upstreamTimeoutSeconds, 45)
  assert.equal(watcher.errors.length, 1)
})

test("an error thrown while applying a reload is logged whatever its type, without terminal controls", async (t) => {
  await writeConfigFile(completeDocument())
  await readAppConfig()
  const failures = [new FileConflictError(), new Error("apply failed \u009b2J here")]
  const watcher = await startWatcher(t, () => {
    const failure = failures.shift()
    if (failure) {
      throw failure
    }
  })

  await writeConfigFile(completeDocument({ thinkEffort: "low" }))
  await watcher.poll()
  assert.equal(watcher.errors.length, 1, "a FileConflictError from applying is not a save in progress")

  await writeConfigFile(completeDocument({ thinkEffort: "medium" }))
  await watcher.poll()
  assert.equal(watcher.errors.length, 2)
  const message = String(watcher.errors[1]?.[0])
  assert.ok(!message.includes("\u009b"), "C1 controls are removed")
  assert.match(message, /apply failed 2J here/)
})

const badReloads: Array<[string, string | null]> = [
  ["missing file", null],
  ["empty file", ""],
  ["comment-only file", "# editor is still saving\n"],
  ...Object.keys(completeValues).map((key): [string, string] => [
    `missing ${key}`,
    completeDocument({}, key as keyof AppConfig),
  ]),
  ["invalid explicit boolean", completeDocument({ claudeSetup: "no" })],
  ["invalid explicit port", completeDocument({ port: "0" })],
  ["invalid explicit retention", completeDocument({ logRetentionDays: "0" })],
]

for (const [name, edited] of badReloads) {
  test(`hot reload retains the last good config through ${name} and can recover`, async (t) => {
    await writeConfigFile(completeDocument())
    const previous = await readAppConfig()
    let active = previous
    const watcher = await startWatcher(t, (next) => {
      active = next
    })

    if (edited === null) {
      await fs.unlink(paths.configPath)
    } else {
      await writeConfigFile(edited)
    }

    await watcher.poll()
    assert.equal(active, previous, "partial edits must never replace the last good config")
    if (edited === null) {
      await assert.rejects(fs.stat(paths.configPath), { code: "ENOENT" })
    } else {
      assert.equal(await readConfigFile(), edited)
    }

    const recovered = completeDocument({ thinkEffort: "low" })
    await writeConfigFile(recovered)
    await watcher.poll()
    assert.equal(active.thinkEffort, "low")
    assert.equal(await readConfigFile(), recovered)
    await assert.rejects(fs.stat(paths.logsDir), { code: "ENOENT" })
  })
}

test("watcher reloads do not overlap or apply a stale read after a newer edit", async (t) => {
  await writeConfigFile(completeDocument())
  await readAppConfig()
  const applied: AppConfig[] = []
  const watcher = await startWatcher(t, (next) => {
    applied.push(next)
  })

  const readStarted = deferred()
  const releaseRead = deferred()
  const resolvedPath = await fs.realpath(paths.configPath)
  const realReadFile = fs.readFile
  let readsInFlight = 0
  let maxReadsInFlight = 0
  let pause = true
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] !== paths.configPath && args[0] !== resolvedPath) {
      return realReadFile(...args)
    }

    readsInFlight++
    maxReadsInFlight = Math.max(maxReadsInFlight, readsInFlight)
    try {
      const bytes = await realReadFile(...args)
      if (pause) {
        pause = false
        readStarted.resolve()
        await releaseRead.promise
      }

      return bytes
    } finally {
      readsInFlight--
    }
  })

  // Pause the first poll inside its config read, then save a newer edit and
  // poll again while that read is still pending.
  await writeConfigFile(completeDocument({ thinkEffort: "low" }))
  const firstPoll = watcher.poll()
  await readStarted.promise
  const newest = completeDocument({ thinkEffort: "medium" })
  try {
    await writeConfigFile(newest)
    await watcher.poll()
    assert.equal(maxReadsInFlight, 1, "an unfinished reload must exclude another poll")
  } finally {
    releaseRead.resolve()
    await firstPoll
  }

  assert.equal(applied.length, 0, "the old snapshot must not become runtime config")

  await watcher.poll()
  assert.equal(applied.length, 1)
  assert.equal(applied[0].thinkEffort, "medium")
  assert.equal(await readConfigFile(), newest)
})
