import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-status-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { hasVersionMismatch, renderStatus, resolveExitCode } = await import(
  "../../src/status"
)
const { findRelayOnPort, readRelayPidFileEntry, writeRelayPidFile } =
  await import("../../src/lib/lifecycle")
const { paths } = await import("../../src/lib/paths")
const { appVersion } = await import("../../src/lib/version")
type RelayStatus = Awaited<
  ReturnType<typeof import("../../src/status").collectStatus>
>

const baseStatus: RelayStatus = {
  configPath: "/home/u/.copilot-relay/config.yaml",
  logLevel: "info",
  logPath: "/home/u/.copilot-relay/logs/copilot-relay.2026-07-25.log",
  running: false,
  thinkEffort: "max",
  version: "0.2.5",
}

const runningStatus: RelayStatus = {
  ...baseStatus,
  baseUrl: "http://127.0.0.1:4142",
  daemonVersion: "0.2.5",
  health: { ms: 2, ok: true },
  models: ["gpt-5.6-sol[1m]", "claude-opus-5"],
  pid: 93_744,
  port: 4142,
  running: true,
  startedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
}

const render = (status: RelayStatus): string => renderStatus(status).join("\n")

// Why: "not running" is an answer, not an error. It must say so plainly and
// point at the fix rather than making the user infer it.
test("reports not running with a next step", () => {
  const out = render(baseStatus)

  assert.match(out, /not running/)
  assert.match(out, /copilot-relay start/)
  assert.doesNotMatch(out, /pid/)
})

// Why: with no relay there is nothing to have measured, so claiming health or
// models would be fabrication.
test("claims no health or models when not running", () => {
  const out = render(baseStatus)

  assert.doesNotMatch(out, /health\s+ok/)
  assert.doesNotMatch(out, /gpt-5\.6-sol/)
})

test("reports pid, address, and uptime when running", () => {
  const out = render(runningStatus)

  assert.match(out, /running \(pid 93744, up 1h 30m\)/)
  assert.match(out, /http:\/\/127\.0\.0\.1:4142/)
})

// Why: this is the #29 lesson encoded. /healthz and /v1/models both pass on a
// relay whose Copilot token expired an hour ago, so a green status line without
// --deep must not read as "working".
test("states upstream was not checked without --deep", () => {
  const out = render(runningStatus)

  assert.match(out, /health\s+ok/)
  assert.match(out, /upstream\s+not checked \(use --deep\)/)
})

test("reports a successful end-to-end check under --deep", () => {
  const out = render({ ...runningStatus, deep: { ms: 890, ok: true } })

  assert.match(out, /upstream\s+ok \(890ms\)/)
  assert.match(out, /end-to-end/)
})

// Why: listening but unable to reach Copilot is the failure users actually hit,
// and the fix is not obvious from the symptom.
test("points at auth when the relay is up but upstream fails", () => {
  const out = render({
    ...runningStatus,
    deep: { detail: "http 401: unauthorized", ok: false },
  })

  assert.match(out, /upstream\s+FAILED/)
  assert.match(out, /http 401: unauthorized/)
  assert.match(out, /copilot-relay auth/)
})

// Why: a process can be alive while its socket is not answering. Reporting that
// as healthy would be worse than reporting nothing.
test("surfaces a failed local health probe", () => {
  const out = render({
    ...runningStatus,
    health: { detail: "timed out", ok: false },
    models: [],
  })

  assert.match(out, /health\s+FAILED/)
  assert.match(out, /timed out/)
  assert.match(out, /models\s+unavailable/)
})

// Why: an unparseable or absent startedAt must degrade to "unknown" rather than
// rendering NaN or a negative duration.
test("renders uptime across ranges and degrades safely", () => {
  const cases: Array<[string | undefined, RegExp]> = [
    [new Date(Date.now() - 30 * 1000).toISOString(), /up 30s/],
    [new Date(Date.now() - 45 * 60 * 1000).toISOString(), /up 45m/],
    [new Date(Date.now() - 26 * 3600 * 1000).toISOString(), /up 1d 2h/],
    [undefined, /up unknown/],
    ["not-a-date", /up unknown/],
  ]

  for (const [startedAt, expected] of cases) {
    const status: RelayStatus = { ...runningStatus }
    if (startedAt === undefined) {
      delete status.startedAt
    } else {
      status.startedAt = startedAt
    }
    assert.match(render(status), expected)
  }
})

// Why: the log path is the first thing a user needs when status says something
// is wrong, and it must be today's dated file rather than the pre-v0.2.3 name.
test("shows the dated log path", () => {
  const out = render(runningStatus)

  assert.match(out, /copilot-relay\.\d{4}-\d{2}-\d{2}\.log/)
  assert.doesNotMatch(out, /logs\/copilot-relay\.log/)
})

// Why (#34): the exit code is the contract every scripted caller depends on.
// It exited 0 while printing "health FAILED", so anything gating on it treated
// an unreachable relay as fine.
test("exits non-zero when the health probe fails", () => {
  assert.equal(
    resolveExitCode({
      ...runningStatus,
      health: { detail: "fetch failed", ok: false },
    }),
    2,
  )
})

// Why: absent health is not passing health. Defaulting to 0 on missing data
// would reintroduce #34 through a different door.
test("treats absent health as not usable", () => {
  const status = { ...runningStatus }
  delete status.health
  assert.equal(resolveExitCode(status), 2)
})

// Why: 1 and 2 mean different things — no relay at all versus a relay that is
// up but cannot serve. They call for different responses.
test("separates not-running from running-but-broken", () => {
  assert.equal(resolveExitCode(baseStatus), 1)
  assert.equal(
    resolveExitCode({ ...runningStatus, deep: { detail: "http 401", ok: false } }),
    2,
  )
})

test("exits 0 only when running and healthy", () => {
  assert.equal(resolveExitCode(runningStatus), 0)
  assert.equal(resolveExitCode({ ...runningStatus, deep: { ms: 8, ok: true } }), 0)
})

// Why (#43): status reported the version of the CLI being invoked, never
// asking the daemon. After `npm i -g copilot-relay@X` without a restart it
// confidently printed the new version while the old process kept serving —
// wrong in exactly the situation you would run it to check.
test("reports the daemon's version, not the CLI's", () => {
  const out = render({ ...runningStatus, daemonVersion: "0.2.6", version: "0.3.0" })

  assert.match(out, /version\s+0\.2\.6/)
})

// Why: the mismatch is the finding, and a bare version row reads as trivia
// beside a green health line. It has to say which build is serving, which is
// installed, and what to do about it.
test("surfaces a version mismatch and names the next step", () => {
  const out = render({ ...runningStatus, daemonVersion: "0.2.6", version: "0.3.0" })

  assert.match(out, /MISMATCH/)
  assert.match(out, /running relay is 0\.2\.6; 0\.3\.0 is installed/)
  assert.match(out, /copilot-relay restart/)
})

// Why: a stale build still serves traffic. Mapping that to 2 would tell every
// scripted caller the relay is broken when it is merely not the build you
// installed, so the mismatch is surfaced in text and the contract holds.
test("keeps exit code 0 on a version mismatch", () => {
  const mismatched = { ...runningStatus, daemonVersion: "0.2.6", version: "0.3.0" }

  assert.equal(hasVersionMismatch(mismatched), true)
  assert.equal(resolveExitCode(mismatched), 0)
})

// Why: the warning must fire only on a real difference. Warning when the
// versions agree would train users to ignore it.
test("stays quiet when daemon and CLI versions agree", () => {
  const matched = { ...runningStatus, daemonVersion: "0.3.0", version: "0.3.0" }
  const out = render(matched)

  assert.equal(hasVersionMismatch(matched), false)
  assert.match(out, /version\s+0\.3\.0/)
  assert.doesNotMatch(out, /MISMATCH/)
  assert.doesNotMatch(out, /is installed/)
})

// Why: a daemon older than v0.3.1 reports no version at all. Unknown is not a
// mismatch — filling the gap with the CLI's version is precisely the bug, and
// warning on every old daemon would be noise.
test("reports unknown for a daemon that predates version reporting", () => {
  const unknown = { ...runningStatus }
  delete unknown.daemonVersion
  const out = render(unknown)

  assert.equal(hasVersionMismatch(unknown), false)
  assert.match(out, /version\s+unknown/)
  assert.doesNotMatch(out, /MISMATCH/)
  assert.equal(resolveExitCode(unknown), 0)
})

// Why: a stopped relay has no version to report, and printing a row about one
// would imply something was inspected.
test("omits the daemon version row when not running", () => {
  const out = render(baseStatus)

  assert.doesNotMatch(out, /version\s+unknown/)
  assert.doesNotMatch(out, /MISMATCH/)
})

// Why: the pid file is the source that covers a daemon which is up but not yet
// answering /healthz. It records the version of the process that wrote it, so
// it must survive the write/read round trip.
test("round-trips the daemon version through the pid file", async () => {
  await writeRelayPidFile({ host: "127.0.0.1", port: 4142 })

  const entry = await readRelayPidFileEntry()
  assert.equal(entry?.version, appVersion)

  await fs.rm(paths.pidPath, { force: true })
})

// Why: a pid file written before v0.3.1 has no version field. It must still
// parse — degrading to "unknown" — rather than being discarded as corrupt,
// which would make status report "not running" for a live relay.
test("reads a pre-v0.3.1 pid file without a version", async () => {
  await fs.mkdir(paths.appDir, { recursive: true })
  await fs.writeFile(
    paths.pidPath,
    JSON.stringify({
      host: "127.0.0.1",
      pid: process.pid,
      port: 4142,
      startedAt: new Date().toISOString(),
    }),
  )

  const entry = await readRelayPidFileEntry()
  assert.equal(entry?.pid, process.pid)
  assert.equal(entry?.version, undefined)

  await fs.rm(paths.pidPath, { force: true })
})

// Why (#33): status paired a pid found by scanning every process on the machine
// with an address taken from config, so it reported a relay "running" on a port
// nothing was listening on. Detection must be scoped to the port asked about.
test("ignores a pid file describing a different port", async () => {
  await fs.mkdir(paths.appDir, { recursive: true })
  await fs.writeFile(
    paths.pidPath,
    JSON.stringify({
      host: "127.0.0.1",
      pid: process.pid,
      port: 4142,
      startedAt: new Date().toISOString(),
    }),
  )

  // Asked about 4199; the pid file describes 4142. Must not answer with it.
  assert.equal(
    await findRelayOnPort({ host: "127.0.0.1", port: 4199 }),
    undefined,
  )

  await fs.rm(paths.pidPath, { force: true })
})

test("returns nothing when no pid file and nothing is listening", async () => {
  await fs.rm(paths.pidPath, { force: true })

  assert.equal(
    await findRelayOnPort({ host: "127.0.0.1", port: 4199 }),
    undefined,
  )
})

test.after(async () => {
  await fs.rm(tempHome, { force: true, recursive: true })
})
