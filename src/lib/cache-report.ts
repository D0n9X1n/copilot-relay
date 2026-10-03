// Prompt-cache hit rates read back from the relay's own logs, for `copilot-relay cache`.
//
// The source is the `completion` entry that src/lib/request-trace.ts writes at info for every
// upstream call. Each is one physical line, shown wrapped here:
//
//   <utc time> info request_id=... upstream_request_id=... completion path=/v1/messages
//   http_status=200 body=complete ... input_tokens=2 cache_read_input_tokens=31136 ...
//
// The `request outcome` entry reports usage again, for the client request, so it is never read:
// counting it would count every call twice.
//
// This module only reads. It writes no file, reads no config, and opens no connection.
import { createReadStream, type Dirent } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

import { formatLogDate, paths } from "~/lib/paths"
import { colorText, terminalText, type TerminalTone } from "~/lib/terminal"

const completionRoutes = ["/chat/completions", "/responses", "/v1/messages"] as const

/** The upstream routes whose input_tokens the report knows how to read. */
export type CompletionRoute = typeof completionRoutes[number]

/** A summary of the window, or a trend by local hour or local day. */
export type CacheView = "summary" | "hourly" | "daily"

/** One successful upstream call, as its completion entry recorded it. */
export interface CompletionRecord {
  timestamp: Date
  /** Made terminal-safe when the line is read. */
  model: string
  route: CompletionRoute
  /** As reported: on /v1/messages it excludes cached input, on the other routes it includes it. */
  inputTokens: number
  /** Absent when the entry did not report it, which makes the call's caching unknown, not zero. */
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/**
 * One model on one upstream route, for the whole window or for one hour or day of a trend.
 *
 * The token columns and hitRate cover only the calls whose caching is known, so hitRate is always
 * cacheReadTokens / totalInputTokens of the same row.
 */
export interface CacheRow {
  /**
   * Local "YYYY-MM-DD HH:00" or "YYYY-MM-DD" in a trend; null in the summary. When clocks go back,
   * the rows of each hour that repeats end in their UTC offset, such as " UTC-04:00".
   */
  bucket: string | null
  model: string
  route: CompletionRoute
  /** Every counted call, including those whose caching is unknown. */
  requests: number
  /** Calls whose entry carried no cache_read_input_tokens. */
  unknownCacheRequests: number
  /** Calls that reported a cache read of exactly 0. */
  zeroCacheReadRequests: number
  /** Input including cached input, whatever the route reports. */
  totalInputTokens: number
  cacheReadTokens: number
  uncachedInputTokens: number
  /** null when no call in the row reported cache_creation_input_tokens. */
  cacheWriteTokens: number | null
  /** A fraction from 0 to 1; null when the row has no input of known caching. */
  hitRate: number | null
  belowGoal: boolean
}

export interface CacheReportOptions {
  view: CacheView
  /** Only entries at or after this instant; every retained entry when absent. */
  since?: Date
  /** Only models whose name contains this text, ignoring case. */
  model?: string
  /** The hit-rate goal, in percent, with at most two decimals; buildCacheReport refuses others. */
  goal: number
}

/** A flag the command cannot use. The message is shown to the user as it is. */
export class CacheUsageError extends Error {}

export const defaultGoal = 95

// The exact form Date#toISOString writes at the start of every entry.
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const fieldPattern = /^([A-Za-z0-9_]+)=(\S+)$/
const countPattern = /^\d+$/
const countFields = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]

const isCompletionRoute = (value: string | undefined): value is CompletionRoute =>
  completionRoutes.some((route) => route === value)

const parseTimestamp = (text: string): Date | undefined => {
  if (!timestampPattern.test(text)) {
    return undefined
  }

  const date = new Date(text)

  // Date rolls an impossible day such as 02-30 into the next month instead of rejecting it.
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) {
    return undefined
  }

  return date
}

const isCount = (value: string | undefined): boolean =>
  value !== undefined && countPattern.test(value) && Number.isSafeInteger(Number(value))

// The count in a field that isCount accepted, or undefined when the field is absent.
const countField = (fields: Map<string, string>, key: string): number | undefined => {
  const value = fields.get(key)

  return value === undefined ? undefined : Number(value)
}

/**
 * The completion entry on a log line, or undefined for any other line.
 *
 * Only a successful call is returned: an info entry for HTTP 200 on one of the three routes, with
 * a numeric input_tokens. A line that is not exactly what the relay writes is skipped rather than
 * guessed at, since one bad count would skew a whole row.
 */
export const parseCompletionLine = (line: string): CompletionRecord | undefined => {
  // Nearly every entry is something else, so it is turned away before any splitting.
  if (!line.includes(" completion path=")) {
    return undefined
  }

  const tokens = line.split(" ")
  const timestamp = parseTimestamp(tokens[0])
  const marker = tokens.indexOf("completion", 2)

  if (timestamp === undefined || tokens[1] !== "info" || marker === -1) {
    return undefined
  }

  // The tokens before the marker are key=value ids, so a message that merely contains
  // "completion path=" does not pass for an entry.
  if (!tokens.slice(2, marker).every((token) => fieldPattern.test(token))) {
    return undefined
  }

  const fields = new Map<string, string>()

  for (const token of tokens.slice(marker + 1)) {
    const field = fieldPattern.exec(token)

    if (field === null || fields.has(field[1])) {
      return undefined
    }

    fields.set(field[1], field[2])
  }

  // A count that is present but not a whole number marks a damaged line, not an unknown one.
  if (countFields.some((key) => fields.has(key) && !isCount(fields.get(key)))) {
    return undefined
  }

  const route = fields.get("path")
  const inputTokens = countField(fields, "input_tokens")
  const cacheReadTokens = countField(fields, "cache_read_input_tokens")
  const cacheWriteTokens = countField(fields, "cache_creation_input_tokens")

  if (!isCompletionRoute(route) || fields.get("http_status") !== "200" || inputTokens === undefined) {
    return undefined
  }

  // Chat Completions and Responses count cached input inside input_tokens, so a cache read larger
  // than the input cannot have come from a real response.
  if (route !== "/v1/messages" && cacheReadTokens !== undefined && cacheReadTokens > inputTokens) {
    return undefined
  }

  // Model names come from upstream responses. The writer already limits them to a safe character
  // set, but a log file can be edited, so they are made terminal-safe before anything groups or
  // prints them. terminalText is sanitizeTerminalString plus C1 controls, bidi overrides and line
  // separators.
  const model = terminalText(fields.get("model") ?? "") || "unknown"

  return {
    timestamp,
    model,
    route,
    inputTokens,
    ...(cacheReadTokens !== undefined && { cacheReadTokens }),
    ...(cacheWriteTokens !== undefined && { cacheWriteTokens }),
  }
}

// Dated files only, as getLogPath names them. The undated pre-rotation file has not been written
// since rotation arrived, which was before completion entries existed, so it holds none.
const datedLogFilePattern = new RegExp(`^${paths.logFileBaseName}\\.(\\d{4})-(\\d{2})-(\\d{2})\\.log$`)

// A calendar day as one number, so days compare as dates. formatLogDate does not pad a year below
// 1000, and as text "999-12-30" sorts after "2026-10-03".
const dayNumber = (year: number, month: number, day: number): number => year * 10_000 + month * 100 + day

// Entries are capped at 64 KiB by log.ts, so a run without a line break that grows past 1 MiB did
// not come from the relay. It is dropped rather than held in memory.
const maxLineLength = 1024 * 1024

const isMissing = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException).code === "ENOENT"

const readLogDirectory = async (): Promise<Array<Dirent>> => {
  try {
    return await fs.readdir(paths.logsDir, { withFileTypes: true })
  } catch (error) {
    // Nothing has been logged yet, which the report states as having no data.
    if (isMissing(error)) {
      return []
    }

    throw error
  }
}

/**
 * The dated log files that can hold entries at or after `since`; all of them without it.
 *
 * A file is named for the local date its entries were written on. UTC offsets span 26 hours, from
 * UTC-12 to UTC+14, so after a time-zone change an entry can sit in a file dated up to two days
 * before the date the current zone gives `since`. Those days are read too, and every entry is then
 * checked against `since` itself.
 */
const listLogFiles = async (since: Date | undefined): Promise<Array<string>> => {
  let earliestDay = Number.NEGATIVE_INFINITY

  if (since !== undefined) {
    const twoDaysBefore = new Date(since.getTime())
    twoDaysBefore.setDate(twoDaysBefore.getDate() - 2)

    // A window that starts at the very beginning of the Date range has no earlier day to read.
    if (!Number.isNaN(twoDaysBefore.getTime())) {
      earliestDay = dayNumber(twoDaysBefore.getFullYear(), twoDaysBefore.getMonth() + 1, twoDaysBefore.getDate())
    }
  }

  const entries = await readLogDirectory()

  return entries
    .filter((entry) => {
      const date = datedLogFilePattern.exec(entry.name)

      if (!entry.isFile() || date === null) {
        return false
      }

      return dayNumber(Number(date[1]), Number(date[2]), Number(date[3])) >= earliestDay
    })
    .map((entry) => path.join(paths.logsDir, entry.name))
}

// The relay writes "\n", but a file that passed through a Windows tool may end lines in "\r\n".
const withoutCarriageReturn = (line: string): string => (line.endsWith("\r") ? line.slice(0, -1) : line)

/**
 * The complete lines of a file. A last line without its line break is dropped: the relay may still
 * be appending it, and half an entry can hold a cut-off count that still parses as a number.
 */
async function* readLines(filePath: string): AsyncGenerator<string> {
  const stream: AsyncIterable<string> = createReadStream(filePath, { encoding: "utf8" })
  let partial = ""
  let oversized = false

  for await (const chunk of stream) {
    const pieces = chunk.split("\n")
    const unfinished = pieces.pop() ?? ""

    for (const piece of pieces) {
      if (!oversized) {
        yield withoutCarriageReturn(partial + piece)
      }

      partial = ""
      oversized = false
    }

    if (!oversized) {
      partial += unfinished
    }

    if (partial.length > maxLineLength) {
      partial = ""
      oversized = true
    }
  }
}

const isInWindow = (record: CompletionRecord, since: Date | undefined): boolean =>
  since === undefined || record.timestamp.getTime() >= since.getTime()

async function* readCompletionRecords(since: Date | undefined): AsyncGenerator<CompletionRecord> {
  for (const filePath of await listLogFiles(since)) {
    try {
      for await (const line of readLines(filePath)) {
        const record = parseCompletionLine(line)

        if (record !== undefined && isInWindow(record, since)) {
          yield record
        }
      }
    } catch (error) {
      // Retention can delete a file between the listing and the read.
      if (!isMissing(error)) {
        throw error
      }
    }
  }
}

/** Where a record falls in the report. */
interface Bucket {
  /** CacheRow.bucket: a local hour or day, or null in the summary. */
  label: string | null
  /** For an hour, the UTC offset it was in. With the label, it names one real hour. */
  utcOffset?: string
}

type CacheTotals = Omit<CacheRow, "uncachedInputTokens" | "hitRate" | "belowGoal"> & {
  utcOffset?: string
  /** When the earliest call counted in the row was made. */
  firstCall: number
}

const emptyTotals = (bucket: Bucket, record: CompletionRecord): CacheTotals => ({
  bucket: bucket.label,
  ...(bucket.utcOffset !== undefined && { utcOffset: bucket.utcOffset }),
  firstCall: record.timestamp.getTime(),
  model: record.model,
  route: record.route,
  requests: 0,
  unknownCacheRequests: 0,
  zeroCacheReadRequests: 0,
  totalInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: null,
})

const addRecord = (totals: CacheTotals, record: CompletionRecord): void => {
  totals.requests += 1
  totals.firstCall = Math.min(totals.firstCall, record.timestamp.getTime())

  // Without a cache read the call's caching is unknown, not zero. It stays out of every token
  // column, so that hitRate is always the row's cache read over the row's input.
  if (record.cacheReadTokens === undefined) {
    totals.unknownCacheRequests += 1
    return
  }

  // Chat Completions and Responses count cached input inside input_tokens; Messages reports it
  // apart, in the two cache fields.
  const totalInput =
    record.route === "/v1/messages" ?
      record.inputTokens + record.cacheReadTokens + (record.cacheWriteTokens ?? 0)
    : record.inputTokens

  totals.totalInputTokens += totalInput
  totals.cacheReadTokens += record.cacheReadTokens

  if (record.cacheReadTokens === 0) {
    totals.zeroCacheReadRequests += 1
  }

  if (record.cacheWriteTokens !== undefined) {
    totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + record.cacheWriteTokens
  }
}

// The hit rate in hundredths of a percent, truncated: the rate the report prints, as an integer.
// BigInt keeps it exact however large the token totals grow.
const hitBasisPoints = (cacheReadTokens: number, totalInputTokens: number): number =>
  Number((BigInt(cacheReadTokens) * 10_000n) / BigInt(totalInputTokens))

const toRow = (totals: CacheTotals, goal: number): CacheRow => {
  const hasInput = totals.totalInputTokens > 0

  return {
    bucket: totals.bucket,
    model: totals.model,
    route: totals.route,
    requests: totals.requests,
    unknownCacheRequests: totals.unknownCacheRequests,
    zeroCacheReadRequests: totals.zeroCacheReadRequests,
    totalInputTokens: totals.totalInputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    uncachedInputTokens: totals.totalInputTokens - totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    hitRate: hasInput ? totals.cacheReadTokens / totals.totalInputTokens : null,
    // Both sides are whole hundredths of a percent, so a row is flagged exactly when its printed
    // rate is below the goal. In floating point, 95.4 * 10,500 comes out a little above 1,001,700,
    // which put a row that sits on that goal below it.
    belowGoal: hasInput && hitBasisPoints(totals.cacheReadTokens, totals.totalInputTokens) < Math.round(goal * 100),
  }
}

const twoDigits = (value: number): string => String(value).padStart(2, "0")

// "UTC-04:00" for the offset of the zone in effect at `timestamp`.
const formatUtcOffset = (timestamp: Date): string => {
  const minutes = -timestamp.getTimezoneOffset()
  const sign = minutes < 0 ? "-" : "+"
  const absolute = Math.abs(minutes)

  return `UTC${sign}${twoDigits(Math.floor(absolute / 60))}:${twoDigits(absolute % 60)}`
}

// Local time, matching the dates in the log file names.
const bucketOf = (timestamp: Date, view: CacheView): Bucket => {
  if (view === "daily") {
    return { label: formatLogDate(timestamp) }
  }

  if (view === "hourly") {
    // When clocks go back, a local hour happens twice, first at one UTC offset and then at another,
    // so the offset tells the two apart where the label cannot.
    return {
      label: `${formatLogDate(timestamp)} ${twoDigits(timestamp.getHours())}:00`,
      utcOffset: formatUtcOffset(timestamp),
    }
  }

  return { label: null }
}

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1
  }

  return left > right ? 1 : 0
}

// The rows of one hour, day or summary: the label, and for an hour the UTC offset.
const segmentOf = (totals: CacheTotals): string => JSON.stringify([totals.bucket, totals.utcOffset ?? null])

// Oldest hour or day first, so the latest one ends the table, then by model and route. Hours and
// days sort by their earliest call, not by label, so hours that repeat when clocks go back stay in
// the order they happened. A call's own minutes cannot date its hour: Pacific/Chatham goes back at
// 45 minutes past, so its second 02:00 begins at 02:45.
const sortTotals = (groups: Array<CacheTotals>): Array<CacheTotals> => {
  const firstCalls = new Map<string, number>()

  for (const totals of groups) {
    const segment = segmentOf(totals)
    firstCalls.set(segment, Math.min(firstCalls.get(segment) ?? totals.firstCall, totals.firstCall))
  }

  const firstCallOf = (totals: CacheTotals): number => firstCalls.get(segmentOf(totals)) ?? totals.firstCall

  return [...groups].sort((left, right) =>
    firstCallOf(left) - firstCallOf(right)
    || compareText(left.model, right.model)
    || compareText(left.route, right.route))
}

// When clocks go back, the rows of each hour that repeats end in their UTC offset, so the table
// and --json tell the two hours apart.
const labelRepeatedHours = (sorted: Array<CacheTotals>): void => {
  const offsetsByLabel = new Map<string, Set<string>>()

  for (const totals of sorted) {
    if (totals.utcOffset !== undefined && totals.bucket !== null) {
      const offsets = offsetsByLabel.get(totals.bucket) ?? new Set<string>()
      offsets.add(totals.utcOffset)
      offsetsByLabel.set(totals.bucket, offsets)
    }
  }

  for (const totals of sorted) {
    const offsets = totals.bucket === null ? undefined : offsetsByLabel.get(totals.bucket)

    if (totals.utcOffset !== undefined && offsets !== undefined && offsets.size > 1) {
      totals.bucket = `${totals.bucket} ${totals.utcOffset}`
    }
  }
}

/** Reads the retained logs and returns one row per bucket, model and route. */
export const buildCacheReport = async (options: CacheReportOptions): Promise<Array<CacheRow>> => {
  // Options built in code follow the --goal rule too. Rows are compared in whole hundredths of a
  // percent, so a finer goal would be applied rounded under a heading that shows it unrounded.
  parseGoal(String(options.goal))

  const modelFilter = options.model?.toLowerCase()
  const groups = new Map<string, CacheTotals>()

  for await (const record of readCompletionRecords(options.since)) {
    if (modelFilter !== undefined && !record.model.toLowerCase().includes(modelFilter)) {
      continue
    }

    const bucket = bucketOf(record.timestamp, options.view)
    const key = JSON.stringify([bucket.label, bucket.utcOffset ?? null, record.model, record.route])
    let totals = groups.get(key)

    if (totals === undefined) {
      totals = emptyTotals(bucket, record)
      groups.set(key, totals)
    }

    addRecord(totals, record)
  }

  const sorted = sortTotals([...groups.values()])
  labelRepeatedHours(sorted)

  return sorted.map((totals) => toRow(totals, options.goal))
}

const minuteMs = 60 * 1000
const hourMs = 60 * minuteMs
const dayMs = 24 * hourMs
const durationUnits: Record<string, number> = { m: minuteMs, h: hourMs, d: dayMs }
const durationPattern = /^(\d+)([mhd])$/i
const isoTimePattern =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/i
const sinceUsage =
  "--since needs a duration such as 30m, 6h or 2d, or an ISO date or time such as 2026-10-03 or 2026-10-03T09:00."
// At most two decimals: the report prints and compares rates in hundredths of a percent.
const goalPattern = /^(\d+(?:\.\d{1,2})?)%?$/
const goalUsage = "--goal needs a percentage from 0 to 100 with at most two decimals, such as --goal 95 or --goal 97.5."

const isCalendarDate = (year: number, month: number, day: number): boolean => {
  const date = new Date(year, month - 1, day)

  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
}

const parseIsoTime = (text: string): Date | undefined => {
  const match = isoTimePattern.exec(text)

  if (match === null) {
    return undefined
  }

  const [, year, month, day, hour, minute, second = "00"] = match

  if (!isCalendarDate(Number(year), Number(month), Number(day))) {
    return undefined
  }

  // A bare date is local midnight. Date.parse would read it as UTC midnight.
  if (hour === undefined) {
    return new Date(Number(year), Number(month) - 1, Number(day))
  }

  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) {
    return undefined
  }

  // Date.parse reads a date and time without Z or an offset as local time, and rejects an offset
  // it cannot represent.
  const time = Date.parse(text.toUpperCase().replace(" ", "T"))

  return Number.isNaN(time) ? undefined : new Date(time)
}

/**
 * The start of the window for --since: a duration counted back from `now`, or an ISO date or
 * time. A date, or a time without Z or an offset, is local, like every other time in the report.
 */
export const parseSince = (value: string, now: Date): Date => {
  const text = value.trim()
  const duration = durationPattern.exec(text)

  if (duration !== null) {
    const unit = durationUnits[duration[2].toLowerCase()]
    const start = new Date(now.getTime() - Number(duration[1]) * unit)

    if (Number.isNaN(start.getTime())) {
      throw new CacheUsageError(sinceUsage)
    }

    return start
  }

  const time = parseIsoTime(text)

  if (time === undefined) {
    throw new CacheUsageError(sinceUsage)
  }

  return time
}

/** The hit-rate goal for --goal, in percent with at most two decimals, with or without a trailing "%". */
export const parseGoal = (value: string): number => {
  const match = goalPattern.exec(value.trim())

  if (match === null || Number(match[1]) > 100) {
    throw new CacheUsageError(goalUsage)
  }

  return Number(match[1])
}

/** The command's flags as citty parses them. */
export interface CacheArguments {
  daily?: unknown
  goal?: unknown
  hourly?: unknown
  model?: unknown
  since?: unknown
}

// citty hands over a repeated string flag as an array of its values.
const singleValue = (value: unknown, flag: string): string | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== "string") {
    throw new CacheUsageError(`Give ${flag} once.`)
  }

  return value
}

/**
 * The report options for the command's flags.
 *
 * The summary and the hourly trend cover the last 24 hours by default, and the daily trend every
 * retained day. --since replaces either default.
 */
export const resolveCacheOptions = (args: CacheArguments, now: Date): CacheReportOptions => {
  if (args.hourly && args.daily) {
    throw new CacheUsageError("Choose one of --hourly and --daily.")
  }

  let view: CacheView = "summary"

  if (args.hourly) {
    view = "hourly"
  } else if (args.daily) {
    view = "daily"
  }

  const sinceText = singleValue(args.since, "--since")
  const goalText = singleValue(args.goal, "--goal")
  const model = singleValue(args.model, "--model")?.trim()
  let since: Date | undefined

  if (sinceText !== undefined) {
    since = parseSince(sinceText, now)
  } else if (view !== "daily") {
    since = new Date(now.getTime() - dayMs)
  }

  if (model === "") {
    throw new CacheUsageError("--model needs part of a model name, such as --model opus.")
  }

  return {
    view,
    goal: goalText === undefined ? defaultGoal : parseGoal(goalText),
    ...(since !== undefined && { since }),
    ...(model !== undefined && { model }),
  }
}

interface Column {
  header: string
  alignRight: boolean
  cell: (row: CacheRow) => string
  tone?: (row: CacheRow) => TerminalTone
}

const formatCount = (value: number): string => value.toLocaleString("en-US")

// Truncated rather than rounded, so a row below the goal never prints as the goal itself. The same
// integer decides belowGoal, so the flag always agrees with the printed rate.
const formatHitRate = (row: CacheRow): string => {
  if (row.hitRate === null) {
    return "-"
  }

  const basisPoints = hitBasisPoints(row.cacheReadTokens, row.totalInputTokens)

  return `${Math.floor(basisPoints / 100)}.${twoDigits(basisPoints % 100)}%`
}

const hitRateTone = (row: CacheRow): TerminalTone => {
  if (row.hitRate === null) {
    return "muted"
  }

  return row.belowGoal ? "bad" : "good"
}

const bucketColumns: Record<CacheView, Array<Column>> = {
  summary: [],
  hourly: [{ header: "HOUR", alignRight: false, cell: (row) => row.bucket ?? "" }],
  daily: [{ header: "DAY", alignRight: false, cell: (row) => row.bucket ?? "" }],
}

const dataColumns: Array<Column> = [
  { header: "MODEL", alignRight: false, cell: (row) => row.model },
  { header: "ROUTE", alignRight: false, cell: (row) => row.route },
  { header: "REQUESTS", alignRight: true, cell: (row) => formatCount(row.requests) },
  { header: "UNKNOWN", alignRight: true, cell: (row) => formatCount(row.unknownCacheRequests) },
  { header: "0-READ", alignRight: true, cell: (row) => formatCount(row.zeroCacheReadRequests) },
  { header: "INPUT", alignRight: true, cell: (row) => formatCount(row.totalInputTokens) },
  { header: "CACHE READ", alignRight: true, cell: (row) => formatCount(row.cacheReadTokens) },
  { header: "UNCACHED", alignRight: true, cell: (row) => formatCount(row.uncachedInputTokens) },
  {
    header: "CACHE WRITE",
    alignRight: true,
    cell: (row) => (row.cacheWriteTokens === null ? "-" : formatCount(row.cacheWriteTokens)),
  },
  { header: "HIT RATE", alignRight: true, cell: formatHitRate, tone: hitRateTone },
]

const renderTable = (rows: Array<CacheRow>, view: CacheView, color: boolean): Array<string> => {
  const columns = [...bucketColumns[view], ...dataColumns]
  const cells = rows.map((row) => columns.map((column) => column.cell(row)))
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...cells.map((rowCells) => rowCells[index].length)))
  const pad = (text: string, index: number): string =>
    columns[index].alignRight ? text.padStart(widths[index]) : text.padEnd(widths[index])

  const header = columns.map((column, index) => pad(column.header, index)).join("  ")
  const body = rows.map((row, rowIndex) => {
    const rendered = columns.map((column, index) => {
      const text = pad(cells[rowIndex][index], index)

      return column.tone === undefined ? text : colorText(text, column.tone(row), color)
    })

    // Spelled out as well as colored, so the flag survives NO_COLOR and a pipe.
    const marker = row.belowGoal ? `  ${colorText("below goal", "bad", color)}` : ""

    return `  ${rendered.join("  ")}${marker}`
  })

  return [`  ${header}`, ...body]
}

const viewTitles: Record<CacheView, string> = {
  summary: "Prompt-cache hit rate",
  hourly: "Prompt-cache hit rate by local hour",
  daily: "Prompt-cache hit rate by local day",
}

const formatLocalTime = (date: Date): string =>
  `${formatLogDate(date)} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`

const describeScope = (options: CacheReportOptions): string => {
  const span =
    options.since === undefined ?
      "across all retained logs"
    : `since ${formatLocalTime(options.since)} local time`

  // The filter is the user's own text, echoed back to the terminal.
  const model = options.model === undefined ? "" : `, for models matching "${terminalText(options.model)}"`

  return `${span}${model}`
}

const unknownNote =
  "UNKNOWN calls logged no cache_read_input_tokens; they are left out of the token columns and HIT RATE."

/** The report as text lines. Kept free of IO, so it is tested without a terminal. */
export const renderCacheReport = (
  rows: Array<CacheRow>,
  options: CacheReportOptions,
  color = false,
): Array<string> => {
  if (rows.length === 0) {
    return [
      `No prompt-cache data ${describeScope(options)}.`,
      `The report reads the upstream completion entries in ${paths.logsDir}.`,
      "They are written at logLevel info or debug, not error, and kept for logRetentionDays.",
    ]
  }

  const lines = [
    `${viewTitles[options.view]} ${describeScope(options)}, goal ${options.goal}%`,
    "",
    ...renderTable(rows, options.view, color),
  ]

  if (rows.some((row) => row.unknownCacheRequests > 0)) {
    lines.push("", unknownNote)
  }

  return lines
}
