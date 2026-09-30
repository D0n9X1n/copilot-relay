// Central logger: writes to console and ~/.copilot-relay/logs with daily
// rotation and retention cleanup.
import fs from "node:fs/promises"
import type { Stats } from "node:fs"
import { AsyncLocalStorage } from "node:async_hooks"
import { inspect } from "node:util"

import consola from "consola"

import type { LogLevelName } from "~/lib/app-config"
import { getLogPath, paths } from "~/lib/paths"
import { scrubSensitiveUrls } from "~/lib/redact"

const logCleanupCheckIntervalMs = 60 * 60 * 1000
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

const loggingSuppressed = new AsyncLocalStorage<boolean>()

export const withoutLogging = <T>(run: () => T): T => loggingSuppressed.run(true, run)

let currentLogLevel = consolaLevelByName.info
const pendingLogWrites = new Set<Promise<void>>()
const registeredLogSecrets = new Set<string>()
const logSecretForms = new Set<string>()
let logSecretPattern: RegExp | undefined
const redactedSecret = "[redacted]"
const truncatedMarker = "[truncated]"
const maxLogArgumentBytes = 16 * 1024
// Leave room for the timestamp, level, separating spaces, and final newline.
const maxLogPayloadBytes = 64 * 1024 - 64

const escapedSecretForms = (value: string): Array<string> => {
  const inspected = inspect(value, { compact: true, breakLength: Infinity, maxStringLength: Infinity })
  const quote = inspected[0]
  const body = inspected.slice(1, -1).replaceAll(`\\${quote}`, quote)
  return [
    value,
    JSON.stringify(value).slice(1, -1),
    ...["'", '"', "`"].map((delimiter) => body.replaceAll(delimiter, `\\${delimiter}`)),
  ]
}

// Secrets stay in memory for this process's lifetime, just like URL-origin
// policies: a response can echo a token after rotation replaced the active one.
export const registerLogSecret = (value: string | undefined): void => {
  if (!value || registeredLogSecrets.has(value)) return
  registeredLogSecrets.add(value)
  for (const form of escapedSecretForms(value)) {
    for (const nested of escapedSecretForms(form)) logSecretForms.add(nested)
  }
  const alternatives = [...logSecretForms].sort((left, right) => right.length - left.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  logSecretPattern = new RegExp(alternatives.join("|"), "g")
}

const scrubLogSecrets = (value: string): string => {
  if (!logSecretPattern) return value
  // inspect keeps its 4000-character string limit. A registered token can cross
  // that boundary, so redact its visible prefix only at inspect's explicit
  // truncation marker, before exact matches can replace a shorter token prefix.
  const truncatedStrings = value.replace(
    /(['"`])((?:\\[\s\S]|(?!\1)[^\\])*)\1(\.\.\. \d+ more characters)/g,
    (_match, quote: string, body: string, suffix: string) => {
      let hiddenLength = 0
      for (const form of logSecretForms) {
        for (let length = Math.min(form.length - 1, body.length); length > hiddenLength; length -= 1) {
          if (body.endsWith(form.slice(0, length))) {
            hiddenLength = length
            break
          }
        }
      }
      return quote + (hiddenLength ? body.slice(0, -hiddenLength) + redactedSecret : body) + quote + suffix
    },
  )
  return truncatedStrings.replace(logSecretPattern, () => redactedSecret)
}

const boundLogText = (value: string, maxBytes: number): string => {
  if (Buffer.byteLength(value) <= maxBytes) return value
  const bytes = Buffer.from(value)
  let end = maxBytes - Buffer.byteLength(truncatedMarker)
  while ((bytes[end] & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end).toString("utf8") + truncatedMarker
}

export const isDebugLogging = (): boolean => currentLogLevel >= consolaLevelByName.debug

// Logging stays fire-and-forget on the request path; teardown can explicitly
// wait for in-flight writes before removing a temporary home or exiting.
export const flushLogs = async (): Promise<void> => {
  while (pendingLogWrites.size > 0) await Promise.all([...pendingLogWrites])
}

export const setLogLevel = (level: LogLevelName): void => {
  currentLogLevel = consolaLevelByName[level]
  consola.level = consolaLevelByName[level]
}

/**
 * Render one logged value with bounded, compact object inspection.
 *
 * `breakLength: Infinity` matters as much as the depth cap. The previous
 * `inspect(value, { depth: null })` pretty-printed each payload across
 * thousands of physical lines, which was both the dominant source of log volume
 * and the reason the `grep` recipes in wiki/EN-Logging-Troubleshooting.md
 * returned a fragment of an object instead of the matching entry. Raw line
 * separators must survive until redaction; wrapFileLog then escapes them.
 */
const formatLogValue = (value: unknown): string =>
  (typeof value === "string" ? value :
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

const escapeLogLineSeparators = (value: string): string =>
  value.replaceAll("\r", "\\r").replaceAll("\n", "\\n")
    .replaceAll(String.fromCodePoint(0x2028), "\\u2028")
    .replaceAll(String.fromCodePoint(0x2029), "\\u2029")

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT"

const sameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino

// Do not chmod through an arbitrary symlink. Open the already checked directory
// without following its final component, and operate on the handle on POSIX.
const ensurePrivateDirectory = async (directory: string): Promise<void> => {
  await fs.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  })
  const observed = await fs.lstat(directory)
  if (!observed.isDirectory() || observed.isSymbolicLink()) {
    throw new Error("Refusing an unsafe log directory")
  }
  if (process.platform === "win32") return

  const handle = await fs.open(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isDirectory() || !sameFile(observed, opened)) {
      throw new Error("Log directory changed while opening")
    }
    await handle.chmod(0o700)
  } finally {
    await handle.close()
  }
}

const ensureLogDirectory = async (): Promise<void> => {
  await ensurePrivateDirectory(paths.appDir)
  await ensurePrivateDirectory(paths.logsDir)
}

const appendPrivateLog = async (filePath: string, content: string): Promise<void> => {
  const observed = await fs.lstat(filePath).catch((error: unknown) => {
    if (!isMissing(error)) throw error
    return undefined
  })
  if (observed && (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1)) {
    throw new Error("Refusing an unsafe log file")
  }

  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
    | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW)
  const handle = await fs.open(filePath, flags, 0o600)
  try {
    const opened = await handle.stat()
    const current = await fs.lstat(filePath)
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink()
      || !sameFile(opened, current) || (observed && !sameFile(observed, opened))) {
      throw new Error("Log file changed while opening")
    }
    if (process.platform !== "win32") await handle.chmod(0o600)
    await handle.appendFile(content)
  } finally {
    await handle.close()
  }
}

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
  await ensureLogDirectory()
  await cleanupLogsIfDue()
  const line = [new Date().toISOString(), level, values.join(" ")].join(" ")
  // Resolved per write, so a relay running across local midnight starts the next
  // dated file on its own; there is no rotation timer to drift or miss.
  await appendPrivateLog(getLogPath(), `${line}\n`)
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
    if (loggingSuppressed.getStore()) return
    const methodLevel = fileLevelByMethod[level] ?? consolaLevelByName.info
    const writesToFile = methodLevel <= currentLogLevel
    const writesToConsole = methodLevel <= consola.level

    if (!writesToFile && !writesToConsole) {
      return fn(...args)
    }

    // Redact before escaping or bounding: raw separators delimit URLs, and a
    // size cap must never turn a complete registered secret into a leaked prefix.
    const rendered = [boundLogText(args.map((value) =>
      boundLogText(
        escapeLogLineSeparators(scrubLogSecrets(scrubSensitiveUrls(formatLogValue(value)))),
        maxLogArgumentBytes,
      ),
    ).join(" "), maxLogPayloadBytes)]

    if (writesToFile) {
      // File logging must never block the console path or fail a request. If
      // the disk write fails, the original consola call still runs.
      const pending = writeLogFile(level, rendered).catch(() => undefined)
      pendingLogWrites.add(pending)
      void pending.then(() => pendingLogWrites.delete(pending))
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
  await ensureLogDirectory()

  // Calendar arithmetic, not 24-hour intervals: the oldest retained local day
  // may begin 23 or 25 hours before the next midnight at a DST boundary.
  const oldestDay = new Date()
  oldestDay.setHours(0, 0, 0, 0)
  oldestDay.setDate(oldestDay.getDate() - (retentionDays - 1))
  const cutoff = oldestDay.getTime()

  const entries = await fs.readdir(paths.logsDir, { withFileTypes: true })
  await Promise.all(
    entries
      .filter((entry) => entry.isFile()
        && (entry.name === `${paths.logFileBaseName}.log` || datedLogFilePattern.test(entry.name)))
      .map(async (entry) => {
        const filePath = `${paths.logsDir}/${entry.name}`
        const current = await fs.lstat(filePath).catch((error: unknown) => {
          if (!isMissing(error)) throw error
          return undefined
        })
        if (!current?.isFile() || current.nlink !== 1) return
        const fileDate = parseLogFileDate(entry.name)
        // Only the relay's legacy/dated names are ours. Service-manager stderr
        // files and saved diagnostics may share this directory but are not swept.
        const timestamp = fileDate?.getTime() ?? current.mtimeMs
        if (timestamp < cutoff) {
          await fs.rm(filePath, { force: true })
        }
      }),
  )
}

export const log = consola
