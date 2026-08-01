// Central logger: writes to console and ~/.copilot-relay/logs with daily
// rotation and retention cleanup.
import fs from "node:fs/promises"
import { inspect } from "node:util"

import consola from "consola"

import type { LogLevelName } from "~/lib/app-config"
import { getLogPath, paths } from "~/lib/paths"
import { scrubSensitiveUrls } from "~/lib/redact"

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
 * and the reason the `grep` recipes in wiki/EN-Logging-Troubleshooting.md
 * returned a fragment of an object instead of the matching entry. One entry is
 * now one line.
 */
const formatLogValue = (value: unknown): string =>
  typeof value === "string" ? value : (
    inspect(value, {
      breakLength: Infinity,
      // compact: true is load-bearing next to breakLength, not redundant with
      // it. The Node docs say breakLength: Infinity formats input on one line
      // "in combination with compact set to true or any number >= 1", which
      // reads as though the default compact: 3 would suffice. It does not: the
      // number is a count of inner elements united, not a threshold, so it only
      // collapses payloads nesting no deeper than that count. Measured on
      // v26.5.0 with a real Copilot error payload (4 levels deep):
      //
      //   compact: 3  + breakLength: Infinity -> 10 lines
      //   compact: 1  + breakLength: Infinity -> 22 lines
      //   compact: 10 + breakLength: Infinity ->  1 line
      //   compact: true + breakLength: Infinity -> 1 line
      //
      // Lowering the number makes it worse, which no threshold reading
      // predicts. compact: true is depth-independent, so it holds for payloads
      // deeper than any fixed count we might pick.
      compact: true,
      depth: 6,
      maxArrayLength: 100,
      maxStringLength: 4000,
    })
  )

/**
 * Appends one already-rendered entry.
 *
 * Takes strings rather than raw values: rendering happens once in wrapFileLog,
 * so the console and the file are guaranteed to carry the same redacted text.
 * Inspecting again here would reintroduce the gap this closes - the file would
 * be scrubbed while the console showed the original object. See #47.
 */
const writeLogFile = async (
  level: string,
  values: Array<string>,
): Promise<void> => {
  await fs.mkdir(paths.logsDir, { recursive: true })
  await cleanupLogsIfDue()
  const line = [new Date().toISOString(), level, values.join(" ")].join(" ")
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

/**
 * The single boundary where every logged value becomes redacted text.
 *
 * Each argument is rendered exactly once and scrubbed once, and the identical
 * array of strings goes to both the file and the console. Scrubbing only on the
 * way to disk would leave the original object on the console - the screen a
 * user screenshots into an issue - so the two sinks must not diverge. See #47.
 *
 * Rendering is skipped only when neither sink would emit, so the cost matches
 * the old behavior at info level. The console gate is read from consola rather
 * than assumed equal to currentLogLevel: if the two ever diverge, rendering
 * must follow whichever sink is still emitting, or that sink gets raw values.
 */
const wrapFileLog = <T extends (...args: Array<unknown>) => unknown>(
  level: string,
  fn: T,
): T =>
  ((...args: Array<unknown>) => {
    const methodLevel = fileLevelByMethod[level] ?? consolaLevelByName.info
    const writesToFile = methodLevel <= currentLogLevel
    const writesToConsole = methodLevel <= consola.level

    if (!writesToFile && !writesToConsole) {
      return fn(...args)
    }

    const rendered = args.map((value) =>
      scrubSensitiveUrls(formatLogValue(value)),
    )

    if (writesToFile) {
      // File logging must never block the console path or fail a request. If
      // the disk write fails, the original consola call still runs.
      void writeLogFile(level, rendered).catch(() => undefined)
    }
    return fn(...rendered)
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
