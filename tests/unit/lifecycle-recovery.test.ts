import assert from "node:assert/strict"
import childProcess from "node:child_process"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify, stripVTControlCharacters } from "node:util"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-lifecycle-recovery-"))
process.env.HOME = home
process.env.USERPROFILE = home

// Replace the OS boundary before lifecycle captures promisify(execFile). No
// fixture is allowed to fall through to ps/lsof/PowerShell or a real signal.
const originalExecFile = childProcess.execFile
const originalKill = process.kill
let commandOutput: (file: string, args: string[]) => Promise<string> = async () => {
  throw new Error("Process discovery is not enabled for this test")
}
const fakeExecFile = () => { throw new Error("Unexpected callback execFile") }
Object.defineProperty(fakeExecFile, promisify.custom, {
  value: async (file: string, args: string[]) => ({ stdout: await commandOutput(file, args), stderr: "" }),
})
childProcess.execFile = fakeExecFile as unknown as typeof childProcess.execFile
syncBuiltinESMExports()
process.kill = () => { throw new Error("Real signals are forbidden") }

const { clearRelayPidFile, findRelayOnPort, findRelayProcessIds, readRelayPidFileEntry, stopExistingRelay } =
  await import("../../src/lib/lifecycle")
const { paths } = await import("../../src/lib/paths")
const { flushLogs } = await import("../../src/lib/log")
await fs.mkdir(paths.appDir, { recursive: true })

test.after(async () => {
  await flushLogs()
  childProcess.execFile = originalExecFile
  process.kill = originalKill
  syncBuiltinESMExports()
  await fs.rm(home, { recursive: true, force: true })
})
test.beforeEach(async () => { await fs.rm(paths.pidPath, { force: true }) })

for (const raw of ['{"pid":', '{not-json', '900001junk']) {
  test(`clears malformed PID content without throwing: ${raw}`, async () => {
    await fs.writeFile(paths.pidPath, raw)
    assert.equal(await readRelayPidFileEntry(), undefined)
    await assert.doesNotReject(clearRelayPidFile(900_002))
    await assert.rejects(fs.stat(paths.pidPath), { code: "ENOENT" })
  })
}

for (const pid of ["900001junk", "9e5", "1.5", Number.MAX_SAFE_INTEGER + 1]) {
  test(`rejects an unsafe or partially parsed PID: ${pid}`, async () => {
    await fs.writeFile(paths.pidPath, JSON.stringify({ pid, host: "127.0.0.1", port: 45001 }))
    assert.equal(await readRelayPidFileEntry(), undefined)
  })
}

for (const address of [
  { host: "", port: 45001 }, { host: " ", port: 45001 },
  { host: "user@127.0.0.1", port: 45001 }, { host: "127.0.0.1/path", port: 45001 },
  { host: "127.0.0.1?query", port: 45001 }, { host: "127.0.0.1#fragment", port: 45001 },
  { host: "http://127.0.0.1", port: 45001 }, { host: "[invalid]", port: 45001 },
  { host: "[::1]:80", port: 45001 }, { host: "[::1]:45002", port: 45001 },
  { host: "127.0.0.1", port: 0 }, { host: "127.0.0.1", port: 65536 },
  { host: "127.0.0.1", port: 1.5 }, { host: "127.0.0.1", port: "45001" },
]) {
  test(`rejects an invalid PID-record address: ${JSON.stringify(address)}`, async () => {
    await fs.writeFile(paths.pidPath, JSON.stringify({ pid: 900001, ...address }))
    assert.equal(await readRelayPidFileEntry(), undefined)
  })
}

type ProcessSignal = Parameters<typeof process.kill>[1]

interface FakeProcess {
  pid: number
  command: string
  cwd: string
  startedAt: string
  alive: boolean
}
const relay = (pid = 900_001): FakeProcess => ({
  pid, command: "node /opt/copilot-relay/dist/main.js start", cwd: "/opt/copilot-relay",
  startedAt: "Tue Sep 29 12:00:00 2026", alive: true,
})

function inventory(t: TestContext, processes: FakeProcess[]) {
  const commands: Array<{ file: string; args: string[] }> = []
  const signals: Array<[number, ProcessSignal]> = []
  const unexpected: string[] = []
  const hooks: {
    beforeQuery?: (process: FakeProcess, field: "command" | "createdAt" | "cwd") => void
    beforeInspect?: (process: FakeProcess) => void
    onSignal?: (process: FakeProcess, signal: ProcessSignal) => void
    onList?: () => Promise<void>
    onListeners?: () => void
    listed?: number[]
    listeners?: number[]
  } = {}
  commandOutput = async (file, args) => {
    commands.push({ file, args })
    if ((file === "ps" && args.includes("-axo"))
      || (file === "powershell.exe" && args.join(" ").includes("Win32_Process | ForEach-Object"))) {
      await hooks.onList?.()
      return processes.filter((p) => p.alive && (!hooks.listed || hooks.listed.includes(p.pid)))
        .map((p) => `${p.pid}\t${p.command}`).join("\n")
    }
    if ((file === "lsof" && args.some((arg) => arg.startsWith("-iTCP:")))
      || (file === "powershell.exe" && args.join(" ").includes("Get-NetTCPConnection"))) {
      hooks.onListeners?.()
      return (hooks.listeners ?? []).join("\n")
    }
    const pid = file === "powershell.exe"
      ? Number(args.join(" ").match(/ProcessId\s*=\s*(\d+)/)?.[1])
      : Number(args[args.indexOf("-p") + 1])
    const p = processes.find((candidate) => candidate.pid === pid && candidate.alive)
    if (!p) return ""
    if (file === "lsof" && args.includes("cwd")) {
      hooks.beforeQuery?.(p, "cwd")
      return `n${p.cwd}\n`
    }
    if (file === "ps" || file === "powershell.exe") {
      if (args.includes("command=") || args.join(" ").includes("CommandLine")) {
        hooks.beforeQuery?.(p, "command")
        hooks.beforeInspect?.(p)
        return p.command
      }
      if (args.includes("lstart=") || args.join(" ").includes("CreationDate")) {
        hooks.beforeQuery?.(p, "createdAt")
        return p.startedAt
      }
    }
    unexpected.push(`${file} ${args.join(" ")}`)
    return ""
  }
  process.kill = (pid, signal) => {
    const p = processes.find((candidate) => candidate.pid === pid && candidate.alive)
    if (!p) throw Object.assign(new Error("synthetic ESRCH"), { code: "ESRCH" })
    if (signal !== 0) {
      signals.push([pid, signal])
      if (hooks.onSignal) hooks.onSignal(p, signal)
      else p.alive = false
    }
    return true
  }
  t.after(() => {
    commandOutput = async () => { throw new Error("Process discovery is not enabled for this test") }
    process.kill = () => { throw new Error("Real signals are forbidden") }
    assert.deepEqual(unexpected, [])
  })
  return { commands, signals, hooks }
}

const savePid = async (p: FakeProcess) => {
  await fs.writeFile(paths.pidPath, JSON.stringify({
    pid: p.pid, host: "127.0.0.2", port: 45001, startedAt: p.startedAt,
  }))
}

test("stop rechecks the selected process identity immediately before SIGTERM", async (t) => {
  const p = relay()
  const fixture = inventory(t, [p])
  let inspections = 0
  fixture.hooks.beforeInspect = (process) => {
    if (++inspections > 1) process.command = "node /opt/other-app/server.js"
  }
  const stopped = await stopExistingRelay({ port: 45001 })
  assert.deepEqual(fixture.signals, [])
  assert.deepEqual(stopped, [])
})

test("stop preserves the record of a live process whose identity cannot be verified", async (t) => {
  const p = { ...relay(), startedAt: "" }
  await savePid(p)
  const original = await fs.readFile(paths.pidPath, "utf8")
  const fixture = inventory(t, [p])
  fastStopClock(t)
  await assert.rejects(stopExistingRelay({ port: 45001 }), /Could not verify.*900001/)
  assert.deepEqual(fixture.signals, [])
  assert.equal(await fs.readFile(paths.pidPath, "utf8"), original)
})

test("stop does not SIGKILL a reused PID with the same relay command", async (t) => {
  const p = relay()
  const fixture = inventory(t, [p])
  fixture.hooks.onSignal = (process, signal) => {
    if (signal === "SIGTERM") process.startedAt = "Tue Sep 29 12:01:00 2026"
    else process.alive = false
  }
  // Advance past each grace window without sleeping or real signals.
  let clock = 0
  t.mock.method(Date, "now", () => (clock += 6_000))
  await stopExistingRelay({ port: 45001 })
  assert.deepEqual(fixture.signals, [[p.pid, "SIGTERM"]])
})

// No wall-clock sleeps: advance the stop clock only when its poll timer runs.
const fastStopClock = (t: TestContext) => {
  let clock = 0
  t.mock.method(Date, "now", () => clock)
  t.mock.method(globalThis, "setTimeout", (callback: () => void, delay: number) => {
    clock += delay
    queueMicrotask(callback)
    return { unref() {} } as ReturnType<typeof setTimeout>
  })
}

for (const source of ["pid", "listener", "global"] as const) {
  for (const field of ["command", "createdAt", "cwd"] as const) {
    test(`initial ${source} candidate with unavailable ${field} fails without signalling`, {
      skip: field === "cwd" && process.platform === "win32",
    }, async (t) => {
      const p = { ...relay(), command: source === "global" ? "node dist/main.js start" : relay().command }
      const fixture = inventory(t, [p])
      fixture.hooks.listed = source === "global" ? [p.pid] : []
      fixture.hooks.listeners = source === "listener" ? [p.pid] : []
      if (source === "pid") await savePid(p)
      const original = await fs.readFile(paths.pidPath, "utf8").catch(() => undefined)
      let queries = 0
      fixture.hooks.beforeQuery = (_process, queried) => {
        if (queried === field) { queries++; throw new Error("synthetic initial inspection failure") }
      }
      fastStopClock(t)
      await assert.rejects(stopExistingRelay({ port: 45001 }), /Could not verify.*900001/)
      assert.ok(queries > 1)
      assert.deepEqual(fixture.signals, [])
      assert.equal(await fs.readFile(paths.pidPath, "utf8").catch(() => undefined), original)
    })
  }
}

for (const boundary of ["global", "listener"] as const) {
  test(`unavailable initial ${boundary} discovery fails rather than claiming no relay`, async (t) => {
    const fixture = inventory(t, [])
    let attempts = 0
    const unavailable = () => { attempts++; throw new Error("synthetic discovery failure") }
    if (boundary === "global") fixture.hooks.onList = async () => unavailable()
    else fixture.hooks.onListeners = unavailable
    fastStopClock(t)
    await assert.rejects(stopExistingRelay({ port: 45001 }), /Could not verify/)
    assert.ok(attempts > 1)
    assert.deepEqual(fixture.signals, [])
  })
}

test("transient initial inspection is retried before a relay is stopped", async (t) => {
  const p = relay()
  const fixture = inventory(t, [p])
  let attempts = 0
  fixture.hooks.beforeQuery = (_process, field) => {
    if (field === "command" && ++attempts === 1) throw new Error("synthetic transient discovery failure")
  }
  fastStopClock(t)
  assert.deepEqual(await stopExistingRelay({ port: 45001 }), [p.pid])
  assert.ok(attempts > 1)
  assert.deepEqual(fixture.signals, [[p.pid, "SIGTERM"]])
})

for (const state of ["absent", "nonrelay"] as const) {
  test(`verified ${state} candidates remain a successful no-op`, async (t) => {
    const p = { ...relay(), alive: state !== "absent", command: "node /opt/worker" }
    await savePid(p)
    const fixture = inventory(t, [p])
    fixture.hooks.listeners = [p.pid]
    assert.deepEqual(await stopExistingRelay({ port: 45001 }), [])
    assert.deepEqual(fixture.signals, [])
  })
}

for (const field of ["command", "createdAt", "cwd"] as const) {
  test(`stop fails rather than reporting success when ${field} inspection stays unavailable after TERM`, {
    skip: field === "cwd" && process.platform === "win32",
  }, async (t) => {
    const p = relay()
    await savePid(p)
    const original = await fs.readFile(paths.pidPath, "utf8")
    const fixture = inventory(t, [p])
    let unavailableQueries = 0
    fixture.hooks.onSignal = () => {}
    fixture.hooks.beforeQuery = (_process, queried) => {
      if (queried === field && fixture.signals.length > 0) {
        unavailableQueries++
        throw Object.assign(new Error("synthetic process inspection failure"), {
          stdout: field === "command" ? p.command : field === "cwd" ? `n${p.cwd}` : p.startedAt,
        })
      }
    }
    fastStopClock(t)
    await assert.rejects(stopExistingRelay({ port: 45001 }), /Could not verify.*900001/)
    assert.ok(unavailableQueries > 1, "unknown inspection must be retried during the grace period")
    assert.equal(p.alive, true)
    assert.deepEqual(fixture.signals, [[p.pid, "SIGTERM"]])
    assert.equal(await fs.readFile(paths.pidPath, "utf8"), original)
  })
}

test("stop retries a transient post-TERM inspection failure before verified escalation", async (t) => {
  const p = relay()
  const fixture = inventory(t, [p])
  let failedOnce = false
  fixture.hooks.onSignal = (process, signal) => { if (signal === "SIGKILL") process.alive = false }
  fixture.hooks.beforeQuery = (_process, field) => {
    if (field === "command" && fixture.signals.length > 0 && !failedOnce) {
      failedOnce = true
      throw new Error("synthetic transient query failure")
    }
  }
  fastStopClock(t)
  assert.deepEqual(await stopExistingRelay({ port: 45001 }), [p.pid])
  assert.equal(failedOnce, true)
  assert.equal(p.alive, false)
  assert.deepEqual(fixture.signals, [[p.pid, "SIGTERM"], [p.pid, "SIGKILL"]])
})

test("stop refuses KILL when inspection becomes unavailable after the grace-period check", async (t) => {
  const p = relay()
  const fixture = inventory(t, [p])
  fixture.hooks.onSignal = () => {}
  let queriesAfterTerm = 0
  fixture.hooks.beforeQuery = (_process, field) => {
    if (field === "command" && fixture.signals.length > 0 && ++queriesAfterTerm > 1) {
      throw new Error("synthetic failure immediately before KILL")
    }
  }
  let clock = 0
  t.mock.method(Date, "now", () => (clock += 6_000))
  await assert.rejects(stopExistingRelay({ port: 45001 }), /Could not verify.*900001/)
  assert.equal(p.alive, true)
  assert.deepEqual(fixture.signals, [[p.pid, "SIGTERM"]])
})

test("stop refuses TERM when a selected identity becomes unavailable", async (t) => {
  const p = relay()
  const fixture = inventory(t, [p])
  let commandQueries = 0
  fixture.hooks.beforeQuery = (_process, field) => {
    if (field === "command" && ++commandQueries > 1) throw new Error("synthetic pre-TERM inspection failure")
  }
  fastStopClock(t)
  await assert.rejects(stopExistingRelay({ port: 45001 }), /Could not verify.*900001/)
  assert.ok(commandQueries > 2)
  assert.deepEqual(fixture.signals, [])
})

test("stop preserves a PID record created after discovery began", async (t) => {
  const p = relay()
  const fixture = inventory(t, [p])
  const replacement = JSON.stringify({ pid: 900_002, host: "127.0.0.3", port: 45002 })
  fixture.hooks.onList = async () => { await fs.writeFile(paths.pidPath, replacement) }
  await stopExistingRelay({ port: 45001 })
  assert.equal(await fs.readFile(paths.pidPath, "utf8"), replacement)
})

test("stop preserves a concurrently replaced PID file even with identical bytes", async (t) => {
  const p = relay()
  await savePid(p)
  const original = await fs.readFile(paths.pidPath, "utf8")
  const fixture = inventory(t, [p])
  fixture.hooks.onList = async () => {
    const replacementPath = `${paths.pidPath}.replacement`
    await fs.writeFile(replacementPath, original)
    await fs.rename(replacementPath, paths.pidPath)
  }
  await stopExistingRelay({ port: 45001 })
  assert.equal(await fs.readFile(paths.pidPath, "utf8"), original)
})

test("stop discovers verified relays without a configured port hint", async (t) => {
  const p = { ...relay(), command: "node /opt/copilot-relay/dist/main.js restart" }
  const fixture = inventory(t, [p])
  assert.deepEqual(await stopExistingRelay({}), [p.pid])
  assert.deepEqual(fixture.signals, [[p.pid, "SIGTERM"]])
  assert.equal(fixture.commands.some(({ args }) => args.some((arg) => /iTCP:|Get-NetTCPConnection/.test(arg))), false)
})

test("status stays port-scoped while stop finds verified relays globally", async (t) => {
  const p = relay()
  await savePid(p)
  const fixture = inventory(t, [p])
  assert.equal(await findRelayOnPort({ host: "127.0.0.1", port: 45002 }), undefined)
  assert.equal(fixture.commands.some(({ args }) => args.includes("-axo") || args.join(" ").includes("ForEach-Object")), false)
  assert.deepEqual(await findRelayProcessIds({ port: 45002 }), [p.pid])
  assert.deepEqual(fixture.signals, [])
})

type ProcessFile = { kind: "file" | "directory"; canonical?: string; content?: string; denied?: boolean }
const mockProcessFiles = async (t: TestContext, entries: Map<string, ProcessFile>) => {
  const example = await fs.stat(paths.appDir)
  const readFile = fs.readFile.bind(fs)
  const file = (value: unknown) => {
    const name = String(value)
    const entry = entries.get(name)
    if (!entry) throw Object.assign(new Error("synthetic missing file"), { code: "ENOENT" })
    if (entry.denied) throw Object.assign(new Error("synthetic denied file"), { code: "EACCES" })
    return { name, entry }
  }
  t.mock.method(fs, "stat", async (value: unknown) => {
    const { name, entry } = file(value)
    return { ...example, ino: [...entries.keys()].indexOf(name) + 1,
      isFile: () => entry.kind === "file", isDirectory: () => entry.kind === "directory" }
  })
  t.mock.method(fs, "realpath", async (value: unknown) => {
    const { name, entry } = file(value)
    return entry.canonical ?? name
  })
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    const name = String(args[0])
    if (name.startsWith(home + path.sep)) return readFile(...args)
    const { entry } = file(name)
    return entry.content ?? "synthetic entrypoint"
  })
}

const proofFiles = (entry = "/workspace/Space Folder/copilot-relay/dist/main.js") => new Map<string, ProcessFile>([
  [entry, { kind: "file" }],
  [path.posix.join(path.posix.dirname(path.posix.dirname(entry)), "package.json"), {
    kind: "file", content: JSON.stringify({ name: "copilot-relay" }),
  }],
])

for (const [firstProgram, remainder] of [
  ["/usr/local/bin/worker", "./workspace/copilot-relay/dist/main.js"],
  ["/usr/local/bin/worker", "workspace/copilot-relay/dist/main.js"],
  ["worker", "workspace/copilot-relay/dist/main.js"],
] as const) {
  for (const kind of ["file", "directory"] as const) {
    test(`filesystem proof rejects existing ${kind} entrypoint: node ${firstProgram} ${remainder} start`, {
      skip: process.platform === "win32",
    }, async (t) => {
      const p = { ...relay(), cwd: "/fixture", command: `node ${firstProgram} ${remainder} start` }
      const files = proofFiles(path.posix.resolve(p.cwd, `${firstProgram} ${remainder}`))
      files.set(path.posix.resolve(p.cwd, firstProgram), { kind })
      await mockProcessFiles(t, files)
      const fixture = inventory(t, [p])
      assert.deepEqual(await stopExistingRelay({}), [])
      assert.deepEqual(fixture.signals, [])
    })
  }
}

test("filesystem proof requires the exact regular relay entrypoint before accepting flat script paths", {
  skip: process.platform === "win32",
}, async (t) => {
  const entry = "/workspace/Space Folder/copilot-relay/dist/main.js"
  const files = proofFiles(entry)
  files.delete(entry)
  await mockProcessFiles(t, files)
  const p = { ...relay(), command: `node ${entry} start` }
  const fixture = inventory(t, [p])
  fastStopClock(t)
  await assert.rejects(stopExistingRelay({}), /Could not verify.*900001/)
  assert.deepEqual(fixture.signals, [])
  files.set(entry, { kind: "file" })
  assert.deepEqual(await stopExistingRelay({}), [p.pid])
  assert.deepEqual(fixture.signals, [[p.pid, "SIGTERM"]])
})

test("filesystem proof preserves exact repeated spaces in a flat entrypoint", {
  skip: process.platform === "win32",
}, async (t) => {
  const entry = "/workspace/Space  Folder/copilot-relay/dist/main.js"
  await mockProcessFiles(t, proofFiles(entry))
  const p = { ...relay(), command: `node ${entry} restart` }
  const fixture = inventory(t, [p])
  fastStopClock(t)
  assert.deepEqual(await stopExistingRelay({}), [p.pid])
  assert.deepEqual(fixture.signals, [[p.pid, "SIGTERM"]])
})

test("filesystem proof recognizes an actual flat POSIX Node executable path with spaces", {
  skip: process.platform === "win32",
}, async (t) => {
  const node = "/opt/Node Runtime/bin/node"
  const entry = "/workspace/copilot-relay/dist/main.js"
  const files = proofFiles(entry)
  files.set(node, { kind: "file" })
  await mockProcessFiles(t, files)
  const p = { ...relay(), command: `${node} ${entry} start` }
  const fixture = inventory(t, [p])
  assert.deepEqual(await stopExistingRelay({}), [p.pid])
  assert.deepEqual(fixture.signals, [[p.pid, "SIGTERM"]])
})

for (const reason of ["denied", "directory", "foreign canonical path", "foreign package"] as const) {
  test(`filesystem proof remains unknown for ${reason}`, { skip: process.platform === "win32" }, async (t) => {
    const entry = "/workspace/Space Folder/copilot-relay/dist/main.js"
    const files = proofFiles(entry)
    if (reason === "denied") files.set("/workspace/Space", { kind: "file", denied: true })
    if (reason === "directory") files.set(entry, { kind: "directory" })
    if (reason === "foreign canonical path") files.set(entry, { kind: "file", canonical: "/foreign/main.js" })
    if (reason === "foreign package") files.set("/workspace/Space Folder/copilot-relay/package.json", {
      kind: "file", content: JSON.stringify({ name: "foreign-worker" }),
    })
    await mockProcessFiles(t, files)
    const p = { ...relay(), command: `node ${entry} start` }
    const fixture = inventory(t, [p])
    fastStopClock(t)
    await assert.rejects(stopExistingRelay({}), /Could not verify.*900001/)
    assert.deepEqual(fixture.signals, [])
  })
}

test("filesystem proof is repeated before TERM when an earlier directory entrypoint appears", {
  skip: process.platform === "win32",
}, async (t) => {
  const files = proofFiles()
  await mockProcessFiles(t, files)
  const p = { ...relay(), command: "node /workspace/Space Folder/copilot-relay/dist/main.js start" }
  const fixture = inventory(t, [p])
  let commands = 0
  fixture.hooks.beforeQuery = (_process, field) => {
    if (field === "command" && ++commands > 1) files.set("/workspace/Space", { kind: "directory" })
  }
  fastStopClock(t)
  await assert.rejects(stopExistingRelay({}), /Could not verify.*900001/)
  assert.deepEqual(fixture.signals, [])
})

test("status reports an initial unknown port candidate instead of claiming no relay", async (t) => {
  const p = relay()
  const fixture = inventory(t, [p])
  fixture.hooks.listeners = [p.pid]
  fixture.hooks.beforeQuery = (_process, field) => { if (field === "command") throw new Error("synthetic unavailable status") }
  await assert.rejects(findRelayOnPort({ host: "127.0.0.1", port: 45001 }), /Could not verify/)
  assert.equal(fixture.commands.some(({ args }) => args.includes("-axo") || args.join(" ").includes("ForEach-Object")), false)
  assert.deepEqual(fixture.signals, [])
})

test("status command exits 2 with a fixed diagnostic for initial inspection failure", async (t) => {
  const { runCommand } = await import("citty")
  const { status } = await import("../../src/status")
  const p = relay()
  const fixture = inventory(t, [p])
  fixture.hooks.listeners = [p.pid]
  fixture.hooks.beforeQuery = (_process, field) => { if (field === "createdAt") throw new Error("untrusted inspection detail") }
  await fs.writeFile(paths.configPath, "port: 45001\nlogLevel: error\n")
  const exitCode = process.exitCode
  const messages: string[] = []
  t.mock.method(console, "error", (value: unknown) => { messages.push(String(value)) })
  t.mock.method(console, "log", (value: unknown) => { messages.push(String(value)) })
  t.after(async () => { process.exitCode = exitCode; await fs.rm(paths.configPath, { force: true }) })

  await runCommand(status, { rawArgs: [] })

  assert.equal(process.exitCode, 2)
  assert.deepEqual(messages, ["Could not verify relay process state; status is unknown."])
  assert.deepEqual(fixture.signals, [])
})

test("invalid PID-record address falls back to the same port listener record", async (t) => {
  const p = relay()
  await fs.writeFile(paths.pidPath, JSON.stringify({ pid: p.pid, host: "", port: 45001 }))
  const fixture = inventory(t, [p])
  fixture.hooks.listeners = [p.pid]
  const detected = await findRelayOnPort({ host: "127.0.0.3", port: 45001 })
  assert.deepEqual(detected, { pid: p.pid, host: "127.0.0.3", port: 45001, startedAt: "" })
  assert.deepEqual(fixture.signals, [])
})

test("stop continues after valid-config log cleanup refuses a symlinked log directory", async (t) => {
  const { runCommand } = await import("citty")
  const { stop } = await import("../../src/stop")
  const { flushLogs, log } = await import("../../src/lib/log")
  await flushLogs()
  const external = await fs.mkdtemp(path.join(home, "external-logs-"))
  const sentinel = path.join(external, "copilot-relay.2000-01-01.log")
  await fs.writeFile(sentinel, "outside log store; must not change\n")
  await fs.rm(paths.logsDir, { recursive: true, force: true })
  await fs.symlink(external, paths.logsDir, process.platform === "win32" ? "junction" : "dir")
  await fs.writeFile(paths.configPath, "port: 45001\nlogLevel: info\n")
  t.after(async () => {
    await flushLogs()
    await fs.rm(paths.logsDir, { recursive: true, force: true })
    await fs.rm(external, { recursive: true, force: true })
    await fs.rm(paths.configPath, { force: true })
  })
  const warnings: unknown[][] = []
  t.mock.method(log, "error", (...values: unknown[]) => { warnings.push(values) })
  const p = relay()
  const fixture = inventory(t, [p])

  await runCommand(stop, { rawArgs: [] })

  assert.deepEqual(fixture.signals, [[p.pid, "SIGTERM"]])
  assert.ok(fixture.commands.some(({ args }) => args.join(" ").includes("-iTCP:45001")
    || args.join(" ").includes("Get-NetTCPConnection -LocalPort 45001")))
  assert.deepEqual(warnings, [["Could not clean up logs; continuing to stop verified relay processes."]])
  assert.equal(await fs.readFile(sentinel, "utf8"), "outside log store; must not change\n")
  assert.deepEqual(await fs.readdir(external), [path.basename(sentinel)])
  assert.equal((await fs.lstat(paths.logsDir)).isSymbolicLink(), true)
})

const entry = new URL("../../src/main.ts", import.meta.url)
const cwd = fileURLToPath(new URL("../../", import.meta.url))

for (const command of ["status", "restart", "stop"] as const) {
  test(`${command} handles invalid config without unsafe process or network access`, async (t) => {
    const childHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay-lifecycle-cli-"))
    t.after(async () => { await fs.rm(childHome, { recursive: true, force: true }) })
    const appDir = path.join(childHome, ".copilot-relay")
    const configPath = path.join(appDir, "config.yaml")
    const original = "not a valid config line\n"
    await fs.mkdir(appDir)
    await fs.writeFile(configPath, original)
    const script = `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      import { promisify } from "node:util";
      const signals = [];
      let alive = true;
      const forbidden = () => { console.error("UNSAFE_ACCESS_FORBIDDEN"); throw new Error("UNSAFE_ACCESS_FORBIDDEN"); };
      const execute = () => forbidden();
      execute[promisify.custom] = async (file, args) => {
        if (${JSON.stringify(command)} !== "stop") return forbidden();
        const joined = args.join(" ");
        let stdout;
        if (joined.includes("-axo") || joined.includes("ForEach-Object")) stdout = "900001 node /opt/copilot-relay/dist/main.js restart".replace("900001 ", "900001\\t");
        else if (joined.includes("command=") || joined.includes("CommandLine")) stdout = "node /opt/copilot-relay/dist/main.js restart";
        else if (joined.includes("lstart=") || joined.includes("CreationDate")) stdout = "Tue Sep 29 12:00:00 2026";
        else if (joined.includes("cwd")) stdout = "n/opt/copilot-relay";
        else return forbidden();
        return { stdout, stderr: "" };
      };
      childProcess.execFile = execute;
      syncBuiltinESMExports();
      process.kill = (pid, signal) => {
        if (${JSON.stringify(command)} !== "stop" || pid !== 900001) return forbidden();
        if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        if (signal !== 0) { signals.push([pid, signal]); alive = false; }
        return true;
      };
      globalThis.fetch = forbidden;
      process.on("exit", () => console.log("SIGNALS=" + JSON.stringify(signals)));
      process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entry))}, ${JSON.stringify(command)}];
      await import(${JSON.stringify(entry.href)});
    `
    const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
      const child = originalExecFile(process.execPath, [
        "--import", "tsx", "--input-type=module", "--eval", script,
      ], {
        cwd, timeout: 10_000,
        env: { ...process.env, HOME: childHome, USERPROFILE: childHome, FORCE_COLOR: "0" },
      }, (error, stdout, stderr) => {
        const code = error ? error.code : 0
        if (error?.killed || typeof code !== "number") return reject(error)
        resolve({ code, output: stripVTControlCharacters(stdout + stderr) })
      })
      child.stdin?.end()
    })
    assert.doesNotMatch(result.output, /UNSAFE_ACCESS_FORBIDDEN/)
    assert.equal(await fs.readFile(configPath, "utf8"), original)
    assert.match(result.output, /config/i)
    assert.match(result.output, command === "stop" ? /SIGNALS=\[\[900001,"SIGTERM"\]\]/ : /SIGNALS=\[\]/)
    assert.equal(result.code, command === "status" ? 2 : command === "restart" ? 1 : 0, result.output)
    if (command === "status") assert.doesNotMatch(result.output, /process\s+not running/)
  })
}
