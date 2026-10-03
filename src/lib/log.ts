// Central logger: writes to console and ~/.copilot-relay/logs with daily
// rotation and retention cleanup.
import fs, { type FileHandle } from "node:fs/promises"
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
const consoleSuppressed = new AsyncLocalStorage<boolean>()

export const withoutLogging = <T>(run: () => T): T => loggingSuppressed.run(true, run)
export const withoutConsoleLogging = <T>(run: () => T): T => consoleSuppressed.run(true, run)

let currentLogLevel = consolaLevelByName.info
const registeredLogSecrets = new Set<string>()
const logSecretForms = new Set<string>()
let logSecretPattern: RegExp | undefined
const redactedSecret = "[redacted]"
const truncatedMarker = "[truncated]"
const maxLogArgumentBytes = 16 * 1024
// Leave room for the timestamp, level, separating spaces, and final newline.
const maxLogPayloadBytes = 64 * 1024 - 64

// The spellings a secret can take in a log entry: raw, JSON-escaped, and inspect()-quoted with each
// of the three delimiters inspect() may pick.
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
  if (!value || registeredLogSecrets.has(value)) {
    return
  }

  registeredLogSecrets.add(value)

  // Escaped forms of each escaped form too: a token can be escaped twice before it reaches the
  // log, such as inside a JSON string that is then inspected.
  for (const form of escapedSecretForms(value)) {
    for (const nested of escapedSecretForms(form)) {
      logSecretForms.add(nested)
    }
  }

  // Longest first: at each position the first alternative that matches wins, so a form that
  // begins with a shorter one must come first, or the rest of the longer form would stay in
  // the log.
  const alternatives = [...logSecretForms]
    .sort((left, right) => right.length - left.length)
    .map((form) => form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  logSecretPattern = new RegExp(alternatives.join("|"), "g")
}

const scrubLogSecrets = (value: string): string => {
  if (!logSecretPattern) {
    return value
  }

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
  if (Buffer.byteLength(value) <= maxBytes) {
    return value
  }

  const bytes = Buffer.from(value)
  let end = maxBytes - Buffer.byteLength(truncatedMarker)

  // Back up off UTF-8 continuation bytes (10xxxxxx), so the cut never splits a character.
  while ((bytes[end] & 0xc0) === 0x80) {
    end -= 1
  }

  return bytes.subarray(0, end).toString("utf8") + truncatedMarker
}

export const isDebugLogging = (): boolean => currentLogLevel >= consolaLevelByName.debug

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

// One entry, one physical line. U+2028 and U+2029 are escaped too: JavaScript counts them as line
// terminators, and so do some editors and log viewers.
const escapeLogLineSeparators = (value: string): string =>
  value
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")
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
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error
    }
  })

  const observed = await fs.lstat(directory)
  if (!observed.isDirectory() || observed.isSymbolicLink()) {
    throw new Error("Refusing an unsafe log directory")
  }

  // Windows has no O_NOFOLLOW and no POSIX mode bits, so the lstat check above is all it gets.
  if (process.platform === "win32") {
    return
  }

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

interface LogEntry {
  filePath: string
  // Already rendered: wrapFileLog renders each entry once, so the console and the file carry the
  // same redacted text. Inspecting again here would reopen the gap #47 closed.
  line: string
}

interface ActiveLog {
  filePath: string
  handle: FileHandle
  identity: Stats
}

// Entries wait here and are written in call order by one drain at a time, so a burst costs one
// check and one append per file instead of a directory check, open, stat, chmod and close for
// each entry.
let logQueue: Array<LogEntry> = []
let logWriteChain: Promise<void> = Promise.resolve()
let activeLog: ActiveLog | undefined

// FileHandle.appendFile writes a larger buffer in 512 KiB pieces, and another process appending to
// the same file could land between two of them. Each write ends on an entry boundary and every
// entry is under 64 KiB, so an entry is never split.
const maxLogWriteBytes = 256 * 1024

// The open handle is reused only while its path still names the same private file with one link.
// A rename, deletion, replacement, second hard link or loosened mode reopens with the full checks.
const isStillActive = async (active: ActiveLog): Promise<boolean> => {
  const current = await fs.lstat(active.filePath).catch(() => undefined)

  return current !== undefined
    && current.isFile()
    && current.nlink === 1
    && sameFile(current, active.identity)
    && (process.platform === "win32" || (current.mode & 0o777) === 0o600)
}

const openPrivateLog = async (filePath: string): Promise<ActiveLog> => {
  const observed = await fs.lstat(filePath).catch((error: unknown) => {
    if (!isMissing(error)) {
      throw error
    }

    return undefined
  })

  // A symlink or a second hard link would send the append and the chmod to some other file.
  if (observed && (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1)) {
    throw new Error("Refusing an unsafe log file")
  }

  // Node defines no O_NOFOLLOW on Windows.
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
    | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW)
  const handle = await fs.open(filePath, flags, 0o600)
  try {
    const opened = await handle.stat()
    const current = await fs.lstat(filePath)

    // Checked again on the open handle, in case the path was swapped between the lstat and the open.
    if (
      !opened.isFile()
      || opened.nlink !== 1
      || current.isSymbolicLink()
      || !sameFile(opened, current)
      || (observed && !sameFile(observed, opened))
    ) {
      throw new Error("Log file changed while opening")
    }

    if (process.platform !== "win32") {
      await handle.chmod(0o600)
    }

    return { filePath, handle, identity: opened }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

const closeActiveLog = async (): Promise<void> => {
  const closing = activeLog
  activeLog = undefined
  await closing?.handle.close().catch(() => undefined)
}

const openActiveLog = async (filePath: string): Promise<FileHandle> => {
  if (activeLog?.filePath === filePath && await isStillActive(activeLog)) {
    return activeLog.handle
  }

  await closeActiveLog()
  await ensureLogDirectory()
  activeLog = await openPrivateLog(filePath)

  return activeLog.handle
}

const appendLogLines = async (filePath: string, lines: Array<string>): Promise<void> => {
  const handle = await openActiveLog(filePath)
  let chunk = ""
  let chunkBytes = 0
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line)
    if (chunk !== "" && chunkBytes + lineBytes > maxLogWriteBytes) {
      await handle.appendFile(chunk)
      chunk = ""
      chunkBytes = 0
    }

    chunk += line
    chunkBytes += lineBytes
  }

  await handle.appendFile(chunk)
}

const drainLogQueue = async (): Promise<void> => {
  const entries = logQueue
  logQueue = []

  // Retention runs at most hourly; its failure must not cost the entries already queued.
  await cleanupLogsIfDue().catch(() => undefined)

  // Consecutive entries share a dated file, so a batch splits only where it crosses local midnight.
  const groups: Array<{ filePath: string; lines: Array<string> }> = []
  for (const entry of entries) {
    const last = groups.at(-1)
    if (last?.filePath === entry.filePath) {
      last.lines.push(entry.line)
    } else {
      groups.push({ filePath: entry.filePath, lines: [entry.line] })
    }
  }

  for (const group of groups) {
    try {
      await appendLogLines(group.filePath, group.lines)
    } catch {
      // File logging must never fail a request. Dropping the handle makes the next batch reopen
      // with the full checks instead of reusing one in an unknown state.
      await closeActiveLog()
    }
  }
}

// Only the push that finds the queue empty schedules a drain; later entries join that drain or the
// next one. A failed drain must not stop the ones after it.
const queueLogEntry = (entry: LogEntry): void => {
  logQueue.push(entry)
  if (logQueue.length === 1) {
    logWriteChain = logWriteChain.then(drainLogQueue).catch(() => undefined)
  }
}

// Logging stays fire-and-forget on the request path; teardown can explicitly wait for queued
// writes and close the log file before removing a temporary home or exiting. Each call waits only
// for the close it queued: waiting for the shared chain to stop changing made two overlapping calls
// wait for each other's close forever.
export const flushLogs = async (): Promise<void> => {
  let pending = true
  while (pending) {
    const closed = logWriteChain.then(closeActiveLog)
    logWriteChain = closed
    await closed
    // Entries queued while this close was pending are drained after it, so close again.
    pending = logQueue.length > 0
  }
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
    if (loggingSuppressed.getStore()) {
      return
    }

    const methodLevel = fileLevelByMethod[level] ?? consolaLevelByName.info
    const writesToFile = methodLevel <= currentLogLevel
    const quiet = consoleSuppressed.getStore() === true
    const writesToConsole = !quiet && methodLevel <= consola.level

    if (!writesToFile && !writesToConsole) {
      return quiet ? undefined : fn(...args)
    }

    // Redact before escaping or bounding: raw separators delimit URLs, and a
    // size cap must never turn a complete registered secret into a leaked prefix.
    const rendered = [
      boundLogText(
        args
          .map((value) =>
            boundLogText(
              escapeLogLineSeparators(scrubLogSecrets(scrubSensitiveUrls(formatLogValue(value)))),
              maxLogArgumentBytes,
            ),
          )
          .join(" "),
        maxLogPayloadBytes,
      ),
    ]

    if (writesToFile) {
      // File logging must never block the console path or fail a request. If
      // the disk write fails, the original consola call still runs. The entry is
      // stamped and given its dated file here, so entries keep call order and one
      // logged before local midnight lands in that day's file even when it is
      // written after; there is no rotation timer to drift or miss.
      const now = new Date()
      queueLogEntry({
        filePath: getLogPath(now),
        line: `${now.toISOString()} ${level} ${rendered.join(" ")}\n`,
      })
    }

    return quiet ? undefined : fn(...rendered)
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
      // Only the relay's legacy/dated names are ours. Service-manager stderr
      // files and saved diagnostics may share this directory but are not swept.
      .filter((entry) =>
        entry.isFile()
        && (entry.name === `${paths.logFileBaseName}.log` || datedLogFilePattern.test(entry.name)),
      )
      .map(async (entry) => {
        const filePath = `${paths.logsDir}/${entry.name}`
        const current = await fs.lstat(filePath).catch((error: unknown) => {
          if (!isMissing(error)) {
            throw error
          }

          return undefined
        })

        if (!current?.isFile() || current.nlink !== 1) {
          return
        }

        // The legacy undated file has no stamp, so it ages by mtime instead.
        const fileDate = parseLogFileDate(entry.name)
        const timestamp = fileDate?.getTime() ?? current.mtimeMs
        if (timestamp < cutoff) {
          await fs.rm(filePath, { force: true })
        }
      }),
  )
}

export const log = consola
