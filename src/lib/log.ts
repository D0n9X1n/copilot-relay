// Central logger: writes to console and ~/.copilot-relay/logs with daily
// rotation and retention cleanup.
import fs from "node:fs/promises"
import { inspect } from "node:util"

import consola from "consola"

import type { LogLevelName } from "~/lib/app-config"
import { getLogPath, paths } from "~/lib/paths"

const logCleanupCheckIntervalMs = 60 * 60 * 1000
const millisecondsPerDay = 24 * 60 * 60 * 1000
let logRetentionDays = 3
let nextLogCleanupCheckAt = 0

// Matches the dated files getLogPath() writes, e.g. copilot-relay.2026-07-24.log.
const datedLogFilePattern = new RegExp(
  `^${paths.logFileBaseName}\\.(\\d{4})-(\\d{2})-(\\d{2})\\.log$`,
)

const consolaLevelByName: Record<LogLevelName, number> = {
  error: 0,
  info: 3,
  debug: 4,
}

// Keep runtime logging intentionally small: error carries full failure context,
// info is operational status, and debug is detailed tracing for local diagnosis.
const fileLevelByMethod: Record<string, number> = {
  error: consolaLevelByName.error,
  info: consolaLevelByName.info,
  debug: consolaLevelByName.debug,
}

let currentLogLevel = consolaLevelByName.info

export const setLogLevel = (level: LogLevelName): void => {
  currentLogLevel = consolaLevelByName[level]
  consola.level = consolaLevelByName[level]
}

/**
 * Render one logged value as a single physical line.
 *
 * `breakLength: Infinity` matters as much as the depth cap. The previous
 * `inspect(value, { depth: null })` pretty-printed each payload across
 * thousands of physical lines, which was both the dominant source of log volume
 * and the reason the `grep` recipes in docs/logging.md returned a fragment of an
 * object instead of the matching entry. One entry is now one line.
 */
const formatLogValue = (value: unknown): string =>
  typeof value === "string" ? value : (
    inspect(value, {
      breakLength: Infinity,
      // compact: true is load-bearing next to breakLength, not redundant with
      // it. Node's default compact: 3 unites only the three inner-most levels
      // and still prints one property per line at outer levels, so breakLength
      // alone left nested payloads spread across lines - the exact shape this
      // is meant to collapse.
      compact: true,
      depth: 6,
      maxArrayLength: 100,
      maxStringLength: 4000,
    })
  )

const writeLogFile = async (
  level: string,
  values: Array<unknown>,
): Promise<void> => {
  await fs.mkdir(paths.logsDir, { recursive: true })
  await cleanupLogsIfDue()
  const line = [
    new Date().toISOString(),
    level,
    values.map(formatLogValue).join(" "),
  ].join(" ")
  // Resolved per write, so a relay running across local midnight starts the next
  // dated file on its own; there is no rotation timer to drift or miss.
  await fs.appendFile(getLogPath(), `${line}\n`)
}

const cleanupLogsIfDue = async (): Promise<void> => {
  const now = Date.now()
  if (now < nextLogCleanupCheckAt) {
    return
  }

  nextLogCleanupCheckAt = now + logCleanupCheckIntervalMs
  await cleanupLogs(logRetentionDays)
}

const wrapFileLog = <T extends (...args: Array<unknown>) => unknown>(
  level: string,
  fn: T,
): T =>
  ((...args: Array<unknown>) => {
    if ((fileLevelByMethod[level] ?? consolaLevelByName.info) <= currentLogLevel) {
      // File logging must never block the console path or fail a request. If
      // the disk write fails, the original consola call still runs.
      void writeLogFile(level, args).catch(() => undefined)
    }
    return fn(...args)
  }) as T

consola.error = wrapFileLog("error", consola.error.bind(consola))
consola.info = wrapFileLog("info", consola.info.bind(consola))
consola.debug = wrapFileLog("debug", consola.debug.bind(consola))

/**
 * Calendar day a log file belongs to, or undefined when its name carries no
 * date stamp.
 *
 * The filename stamp is preferred over mtime because mtime is rewritten by
 * backups, `cp`, and editors touching the file, any of which would silently
 * extend or shorten the retention window.
 */
const parseLogFileDate = (fileName: string): Date | undefined => {
  const match = datedLogFilePattern.exec(fileName)
  if (!match) {
    return undefined
  }

  const [, year, month, day] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day))
  // Rejects impossible stamps such as 2026-13-45, which Date would otherwise
  // roll forward into a plausible-looking day.
  return (
      date.getFullYear() === Number(year)
      && date.getMonth() === Number(month) - 1
      && date.getDate() === Number(day)
    ) ?
      date
    : undefined
}

export const cleanupLogs = async (retentionDays: number): Promise<void> => {
  logRetentionDays = retentionDays
  await fs.mkdir(paths.logsDir, { recursive: true })

  // retentionDays counts today plus the preceding retentionDays - 1 days, so the
  // default of 3 keeps today, yesterday, and the day before.
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const cutoff =
    startOfToday.getTime() - (retentionDays - 1) * millisecondsPerDay

  const entries = await fs.readdir(paths.logsDir, { withFileTypes: true })
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map(async (entry) => {
        const filePath = `${paths.logsDir}/${entry.name}`
        const fileDate = parseLogFileDate(entry.name)
        // Undated files - notably the pre-rotation copilot-relay.log - keep the
        // original mtime rule, so upgrading installs drain without manual steps.
        const timestamp =
          fileDate?.getTime() ?? (await fs.stat(filePath)).mtimeMs
        if (timestamp < cutoff) {
          // Two relay processes can sweep the same directory; losing that race
          // is not a failure worth surfacing.
          await fs.rm(filePath, { force: true })
        }
      }),
  )
}

export const log = consola
