import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

// paths.ts resolves everything from os.homedir() at import time, so the home
// directory must be redirected before the module graph loads. Node reads HOME on
// POSIX and USERPROFILE on Windows, and CI runs windows-latest, so both are set:
// HOME alone would silently write into the real profile on the Windows leg.
// Node runs each test file in its own process, so this cannot leak into another
// file.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-log-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

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

test("preserves service-manager and foreign log files regardless of age", async () => {
  await seedLog("launchd.err.log", daysAgo(30))
  await seedLog("launchd.out.log", daysAgo(30))
  await seedLog("saved-errors.log", daysAgo(30))
  await seedLog(`copilot-relay.${formatLogDate(daysAgo(30))}.log`)

  await cleanupLogs(3)

  assert.deepEqual(await listLogs(), ["launchd.err.log", "launchd.out.log", "saved-errors.log"])
})

// A fixed TZ in a child makes this independent of the developer and CI timezone.
// Date mocking advances only the clock, not timers or filesystem operations.
test("keeps three local calendar days across the fall DST transition", async () => {
  const home = await fs.mkdtemp(path.join(tempHome, "dst-"))
  try {
    const script = `
      import fs from "node:fs/promises";
      import path from "node:path";
      import { mock } from "node:test";
      const { cleanupLogs } = await import(${JSON.stringify(new URL("../../src/lib/log.ts", import.meta.url).href)});
      const { paths } = await import(${JSON.stringify(new URL("../../src/lib/paths.ts", import.meta.url).href)});
      mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-02T12:00:00-05:00") });
      try {
        if (new Date(2026, 9, 31).getTimezoneOffset() !== 240 || new Date().getTimezoneOffset() !== 300) {
          throw new Error("DST fixture timezone was not applied");
        }
        await fs.mkdir(paths.logsDir, { recursive: true });
        for (const day of ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]) {
          await fs.writeFile(path.join(paths.logsDir, "copilot-relay." + day + ".log"), "fixture\\n");
        }
        await cleanupLogs(3);
        process.stdout.write(JSON.stringify((await fs.readdir(paths.logsDir)).sort()));
      } finally {
        mock.timers.reset();
      }
    `
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", script,
    ], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: { ...process.env, HOME: home, USERPROFILE: home, TZ: "America/New_York" },
      timeout: 10_000,
    })
    assert.deepEqual(JSON.parse(stdout), [
      "copilot-relay.2026-10-31.log",
      "copilot-relay.2026-11-01.log",
      "copilot-relay.2026-11-02.log",
    ])
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

for (const target of ["app directory", "logs directory"]) {
  test(`does not follow a symlinked ${target} during retention`, {
    skip: process.platform === "win32",
  }, async () => {
    const outside = await fs.mkdtemp(path.join(tempHome, "outside-"))
    const link = target === "app directory" ? paths.appDir : paths.logsDir
    const foreignLogs = target === "app directory" ? path.join(outside, "logs") : outside
    await fs.mkdir(foreignLogs, { recursive: true })
    const foreignLog = path.join(foreignLogs, "copilot-relay.2000-01-01.log")
    await fs.writeFile(foreignLog, "do not delete\n")
    await fs.chmod(outside, 0o755)
    await fs.rm(link, { recursive: true, force: true })
    await fs.symlink(outside, link, "dir")
    try {
      await cleanupLogs(3).catch(() => undefined)
      assert.equal(await fs.readFile(foreignLog, "utf8"), "do not delete\n")
      assert.equal((await fs.stat(outside)).mode & 0o777, 0o755)
    } finally {
      await fs.unlink(link)
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
}

test.after(async () => {
  await fs.rm(tempHome, { force: true, recursive: true })
})
