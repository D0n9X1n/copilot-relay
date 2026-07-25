import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// paths.ts resolves everything from os.homedir() at import time, so HOME must be
// redirected before the module graph loads. Node runs each test file in its own
// process, so this cannot leak into another file.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-log-"))
process.env.HOME = tempHome

const { cleanupLogs } = await import("../../src/lib/log")
const { formatLogDate, getLogPath, paths } = await import("../../src/lib/paths")

const dayInMs = 24 * 60 * 60 * 1000

const daysAgo = (days: number): Date => new Date(Date.now() - days * dayInMs)

const seedLog = async (fileName: string, mtime?: Date): Promise<string> => {
  await fs.mkdir(paths.logsDir, { recursive: true })
  const filePath = path.join(paths.logsDir, fileName)
  await fs.writeFile(filePath, "seeded\n")
  if (mtime) {
    await fs.utimes(filePath, mtime, mtime)
  }
  return filePath
}

const listLogs = async (): Promise<Array<string>> =>
  (await fs.readdir(paths.logsDir)).sort()

test.beforeEach(async () => {
  await fs.rm(paths.logsDir, { force: true, recursive: true })
  await fs.mkdir(paths.logsDir, { recursive: true })
})

// Why: this is the 9.3 GB bug. One never-rotated file had its mtime refreshed by
// every append, so it never aged past the cutoff and retention deleted nothing
// for 22 days. Date-stamped names are what make a file stop being written to.
test("deletes dated logs past retention while keeping the active day", async () => {
  await seedLog(`copilot-relay.${formatLogDate(daysAgo(5))}.log`)
  await seedLog(`copilot-relay.${formatLogDate(daysAgo(3))}.log`)
  await seedLog(`copilot-relay.${formatLogDate(daysAgo(1))}.log`)
  await seedLog(`copilot-relay.${formatLogDate(new Date())}.log`)

  await cleanupLogs(3)

  assert.deepEqual(await listLogs(), [
    `copilot-relay.${formatLogDate(daysAgo(1))}.log`,
    `copilot-relay.${formatLogDate(new Date())}.log`,
  ])
})

// Why: mtime is rewritten by backups, cp, and editors touching a file. Trusting
// it over the filename stamp would silently extend or shorten the window.
test("prefers the filename date over a misleading mtime", async () => {
  // Old file whose mtime was refreshed to now: must still be deleted.
  await seedLog(`copilot-relay.${formatLogDate(daysAgo(9))}.log`, new Date())
  // Current file whose mtime looks ancient: must still be kept.
  await seedLog(`copilot-relay.${formatLogDate(new Date())}.log`, daysAgo(9))

  await cleanupLogs(3)

  assert.deepEqual(await listLogs(), [
    `copilot-relay.${formatLogDate(new Date())}.log`,
  ])
})

// Why: installs upgrading from a pre-rotation build have a large undated file.
// It carries no filename date, so retention falls back to mtime and drains it
// without asking the user to delete anything by hand.
test("sweeps the legacy undated log via mtime fallback", async () => {
  await seedLog("copilot-relay.log", daysAgo(9))
  await seedLog(`copilot-relay.${formatLogDate(new Date())}.log`)

  await cleanupLogs(3)

  assert.deepEqual(await listLogs(), [
    `copilot-relay.${formatLogDate(new Date())}.log`,
  ])
})

// Why: a fresh legacy file is still the file being written to right now. Aging
// it out by mtime would delete logs the user is actively tailing.
test("keeps a legacy undated log while it is still fresh", async () => {
  await seedLog("copilot-relay.log", daysAgo(1))

  await cleanupLogs(3)

  assert.deepEqual(await listLogs(), ["copilot-relay.log"])
})

// Why: retention must not reach outside its own file type. The logs directory is
// user-visible and may hold saved samples or extracted error digests.
test("ignores non-log files regardless of age", async () => {
  await seedLog("error-sample.txt", daysAgo(30))
  await seedLog("notes.md", daysAgo(30))
  await seedLog(`copilot-relay.${formatLogDate(daysAgo(30))}.log`)

  await cleanupLogs(3)

  assert.deepEqual(await listLogs(), ["error-sample.txt", "notes.md"])
})

// Why: Date rolls impossible values forward, so 2026-13-45 would parse as a
// real day and be judged against the cutoff instead of falling back to mtime.
test("falls back to mtime for impossible date stamps", async () => {
  await seedLog("copilot-relay.2026-13-45.log", daysAgo(9))
  await seedLog("copilot-relay.2026-02-30.log", new Date())

  await cleanupLogs(3)

  assert.deepEqual(await listLogs(), ["copilot-relay.2026-02-30.log"])
})

// Why: retentionDays counts calendar days including today, so 1 means today
// only. An off-by-one here either deletes the active log or keeps an extra day.
test("retentionDays=1 keeps only the current day", async () => {
  await seedLog(`copilot-relay.${formatLogDate(daysAgo(1))}.log`)
  await seedLog(`copilot-relay.${formatLogDate(new Date())}.log`)

  await cleanupLogs(1)

  assert.deepEqual(await listLogs(), [
    `copilot-relay.${formatLogDate(new Date())}.log`,
  ])
})

// Why: the path is resolved per write rather than cached at startup, which is
// what lets a long-running relay roll over at local midnight with no timer.
test("resolves a distinct dated path per calendar day", () => {
  const first = new Date(2026, 6, 24, 23, 59, 59)
  const second = new Date(2026, 6, 25, 0, 0, 1)

  assert.equal(path.basename(getLogPath(first)), "copilot-relay.2026-07-24.log")
  assert.equal(path.basename(getLogPath(second)), "copilot-relay.2026-07-25.log")
  assert.notEqual(getLogPath(first), getLogPath(second))
})

// Why: local, not UTC. logRetentionDays is a human "how many days" setting, and
// a UTC stamp would roll the file over mid-afternoon west of Greenwich.
test("stamps file names with the local date", () => {
  // 2026-07-24T04:30Z is still 2026-07-23 in any negative UTC offset.
  const evening = new Date(2026, 6, 23, 21, 30)

  assert.equal(formatLogDate(evening), "2026-07-23")
  assert.equal(path.basename(getLogPath(evening)), "copilot-relay.2026-07-23.log")
})

test("zero-pads single-digit months and days", () => {
  assert.equal(formatLogDate(new Date(2026, 0, 5)), "2026-01-05")
  assert.equal(formatLogDate(new Date(2026, 11, 31)), "2026-12-31")
})

test.after(async () => {
  await fs.rm(tempHome, { force: true, recursive: true })
})
