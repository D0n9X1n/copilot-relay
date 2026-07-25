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

const { renderStatus } = await import("../../src/status")
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

test.after(async () => {
  await fs.rm(tempHome, { force: true, recursive: true })
})
