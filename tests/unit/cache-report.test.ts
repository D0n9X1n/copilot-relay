import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// paths.ts resolves the home directory when it is imported, so it is redirected first. Node reads
// USERPROFILE on Windows and HOME elsewhere, so both are set.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-cache-report-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

// India Standard Time is UTC+05:30 all year, with no daylight saving. Its local hours start half
// way through UTC hours, so a report that bucketed by UTC would fail the trend tests.
process.env.TZ = "Asia/Kolkata"

const {
  buildCacheReport,
  CacheUsageError,
  parseCompletionLine,
  parseGoal,
  parseSince,
  renderCacheReport,
  resolveCacheOptions,
} = await import("../../src/lib/cache-report")
const { flushLogs } = await import("../../src/lib/log")
const { paths } = await import("../../src/lib/paths")
const { RequestTrace, recordedFetch, withRequestTrace } = await import("../../src/lib/request-trace")
type CacheArguments = import("../../src/lib/cache-report").CacheArguments
type CacheReportOptions = import("../../src/lib/cache-report").CacheReportOptions
type CacheRow = import("../../src/lib/cache-report").CacheRow

// The fixtures replace the logs directory, so it must be the temporary one.
assert.ok(paths.logsDir.startsWith(home), paths.logsDir)

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

// What RequestTrace.create needs. Every upstream response below is a fixture; nothing is sent.
const traceConfig = { host: "127.0.0.1", port: 0, copilotBaseUrl: "https://fixture.invalid", copilotToken: "fixture-token", upstreamTimeoutMs: 1000, vsCodeVersion: "test" }

// 17:30 local time on 2026-10-03, after every fixture entry, and the instant 24 hours earlier.
const now = new Date("2026-10-03T12:00:00.000Z")
const lastDay = new Date("2026-10-02T12:00:00.000Z")

// The relay's own completion entries, ids replaced: one call on each route and one failed call.
const chatLine = "2026-10-03T07:13:20.421Z info request_id=req-1 upstream_request_id=up-1 completion path=/chat/completions http_status=200 body=complete message_id=msg_x model=claude-opus-5.5 finish_reason=tool_calls stop_reason=unknown terminal=true input_tokens=31431 output_tokens=55 cache_read_input_tokens=30924"
const messagesLine = "2026-10-03T06:52:40.772Z info request_id=req-2 upstream_request_id=up-2 completion path=/v1/messages http_status=200 body=complete message_id=msg_y model=claude-opus-5-5 finish_reason=unknown stop_reason=tool_use terminal=true input_tokens=2 output_tokens=55 cache_read_input_tokens=31136 cache_creation_input_tokens=516"
const responsesLine = "2026-10-03T06:54:39.268Z info request_id=req-3 upstream_request_id=up-3 completion path=/responses http_status=200 body=complete model=gpt-5.5-2026-04-23 finish_reason=unknown stop_reason=unknown response_status=completed terminal=true input_tokens=19297 output_tokens=22 cache_read_input_tokens=17920"
const failedLine = "2026-10-03T06:46:23.482Z info request_id=req-4 upstream_request_id=up-4 completion path=/v1/messages http_status=400 body=complete finish_reason=unknown stop_reason=unknown terminal=unknown"

// A completion entry in the form src/lib/request-trace.ts writes.
const completion = (timestamp: string, fields: string): string =>
  `${timestamp} info request_id=req upstream_request_id=up completion ${fields}`

// A Chat Completions call by claude-opus-5.5 with the given usage.
const chatCall = (timestamp: string, usage: string): string =>
  completion(timestamp, `path=/chat/completions http_status=200 body=complete model=claude-opus-5.5 terminal=true ${usage}`)

const dated = (day: string): string => `copilot-relay.${day}.log`

// Complete entries, each ending in the line break the relay writes after it.
const entries = (...lines: Array<string>): string => lines.map((line) => `${line}\n`).join("")

// Replaces the logs directory with exactly these files, so every test starts from its own.
const writeLogs = async (files: Record<string, string>): Promise<void> => {
  await fs.rm(paths.logsDir, { recursive: true, force: true })
  await fs.mkdir(paths.logsDir, { recursive: true })

  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(paths.logsDir, name), content)
  }
}

// The columns most tests check.
const essentials = (rows: Array<CacheRow>) =>
  rows.map((row) => ({
    bucket: row.bucket,
    model: row.model,
    route: row.route,
    requests: row.requests,
    totalInputTokens: row.totalInputTokens,
    cacheReadTokens: row.cacheReadTokens,
  }))

test("reads the completion entry of each upstream route", () => {
  assert.deepEqual(parseCompletionLine(chatLine), {
    timestamp: new Date("2026-10-03T07:13:20.421Z"),
    model: "claude-opus-5.5",
    route: "/chat/completions",
    inputTokens: 31431,
    cacheReadTokens: 30924,
  })
  assert.deepEqual(parseCompletionLine(messagesLine), {
    timestamp: new Date("2026-10-03T06:52:40.772Z"),
    model: "claude-opus-5-5",
    route: "/v1/messages",
    inputTokens: 2,
    cacheReadTokens: 31136,
    cacheWriteTokens: 516,
  })
  assert.deepEqual(parseCompletionLine(responsesLine), {
    timestamp: new Date("2026-10-03T06:54:39.268Z"),
    model: "gpt-5.5-2026-04-23",
    route: "/responses",
    inputTokens: 19297,
    cacheReadTokens: 17920,
  })
  assert.equal(parseCompletionLine(failedLine), undefined)
})

// The relay's own writer, driven through one call on each route: the report must read exactly what
// it logs, and must not count the calls again from the request outcome entry it adds.
test("counts the entries the relay writes, once per upstream call", async () => {
  await writeLogs({})

  const started = Date.now()
  const trace = await RequestTrace.create(
    "10000000-0000-4000-8000-000000000145",
    new Request("http://localhost/v1/messages"),
    traceConfig,
    {},
    false,
  )
  const upstream: Array<[string, Record<string, unknown>]> = [
    ["/chat/completions", { model: "claude-opus-5.5", choices: [{ finish_reason: "tool_calls" }], usage: { prompt_tokens: 31431, completion_tokens: 55, prompt_tokens_details: { cached_tokens: 30924 } } }],
    ["/v1/messages", { type: "message", model: "claude-opus-5-5", stop_reason: "tool_use", usage: { input_tokens: 2, output_tokens: 55, cache_read_input_tokens: 31136, cache_creation_input_tokens: 516 } }],
    ["/responses", { model: "gpt-5.5-2026-04-23", status: "completed", usage: { input_tokens: 19297, output_tokens: 22, input_tokens_details: { cached_tokens: 17920 } } }],
  ]

  await withRequestTrace(trace, async () => {
    for (const [route, body] of upstream) {
      const response = await recordedFetch(
        { method: "POST", path: route, headers: {}, upstreamRequestId: "10000000-0000-4000-8000-000000000146" },
        async () => Response.json(body),
      )
      await response.text()
    }
  })

  // The client response repeats the usage, which the relay logs again as the request outcome.
  trace.handlerSettled()
  await trace.captureResponse(Response.json({ stop_reason: "tool_use", usage: { input_tokens: 2, cache_read_input_tokens: 31136 } })).text()
  await trace.finished
  await flushLogs()

  const files = await fs.readdir(paths.logsDir)
  const written = (await Promise.all(files.map((name) => fs.readFile(path.join(paths.logsDir, name), "utf8")))).join("")

  assert.equal(written.match(/ completion path=/g)?.length, 3)
  assert.match(written, / request outcome .*cache_read_input_tokens=31136/)

  const rows = await buildCacheReport({ view: "summary", since: new Date(started - 60_000), goal: 95 })

  assert.deepEqual(essentials(rows), [
    { bucket: null, model: "claude-opus-5-5", route: "/v1/messages", requests: 1, totalInputTokens: 31654, cacheReadTokens: 31136 },
    { bucket: null, model: "claude-opus-5.5", route: "/chat/completions", requests: 1, totalInputTokens: 31431, cacheReadTokens: 30924 },
    { bucket: null, model: "gpt-5.5-2026-04-23", route: "/responses", requests: 1, totalInputTokens: 19297, cacheReadTokens: 17920 },
  ])
})

test("total input includes cached input on every route", async () => {
  await writeLogs({ [dated("2026-10-03")]: entries(chatLine, messagesLine, responsesLine, failedLine) })

  const rows = await buildCacheReport({ view: "summary", since: lastDay, goal: 95 })

  assert.deepEqual(rows, [
    {
      bucket: null,
      model: "claude-opus-5-5",
      route: "/v1/messages",
      requests: 1,
      unknownCacheRequests: 0,
      zeroCacheReadRequests: 0,
      // Messages input_tokens leaves cached input out: 2 + 31,136 read + 516 written.
      totalInputTokens: 31654,
      cacheReadTokens: 31136,
      uncachedInputTokens: 518,
      cacheWriteTokens: 516,
      hitRate: 31136 / 31654,
      belowGoal: false,
    },
    {
      bucket: null,
      model: "claude-opus-5.5",
      route: "/chat/completions",
      requests: 1,
      unknownCacheRequests: 0,
      zeroCacheReadRequests: 0,
      // Chat Completions input_tokens already includes the cached input.
      totalInputTokens: 31431,
      cacheReadTokens: 30924,
      uncachedInputTokens: 507,
      cacheWriteTokens: null,
      hitRate: 30924 / 31431,
      belowGoal: false,
    },
    {
      bucket: null,
      model: "gpt-5.5-2026-04-23",
      route: "/responses",
      requests: 1,
      unknownCacheRequests: 0,
      zeroCacheReadRequests: 0,
      // So does Responses input_tokens.
      totalInputTokens: 19297,
      cacheReadTokens: 17920,
      uncachedInputTokens: 1377,
      cacheWriteTokens: null,
      hitRate: 17920 / 19297,
      belowGoal: true,
    },
  ])
})

test("counts only successful completion entries that report input_tokens", async () => {
  // The relay is still writing the last entry, so its count may be cut short.
  const unfinished = chatCall("2026-10-03T07:29:00.000Z", "input_tokens=90")

  await writeLogs({
    [dated("2026-10-03")]: entries(
      chatLine,
      failedLine,
      // The client request's outcome repeats the call's usage; counting it would count the call twice.
      "2026-10-03T07:13:21.000Z info request_id=req-1 request outcome http_status=200 body=complete model=claude-opus-5.5 finish_reason=tool_calls stop_reason=unknown terminal=true input_tokens=31431 output_tokens=55 cache_read_input_tokens=30924",
      completion("2026-10-03T07:20:00.000Z", "path=/chat/completions http_status=500 body=complete model=claude-opus-5.5 terminal=unknown input_tokens=900 cache_read_input_tokens=800"),
      completion("2026-10-03T07:21:00.000Z", "path=/models http_status=200 body=complete finish_reason=unknown stop_reason=unknown terminal=unknown"),
      completion("2026-10-03T07:22:00.000Z", "path=/embeddings http_status=200 body=complete model=claude-opus-5.5 input_tokens=900 cache_read_input_tokens=800"),
      completion("2026-10-03T07:23:00.000Z", "path=/chat/completions http_status=200 body=cancelled model=claude-opus-5.5 terminal=unknown"),
      // Malformed: an impossible date, a count that is not a whole number, a repeated key, a cache
      // read larger than the input that contains it, and lines that are not completion entries.
      chatCall("2026-02-30T07:24:00.000Z", "input_tokens=900 cache_read_input_tokens=800"),
      chatCall("2026-10-03T07:25:00.000Z", "input_tokens=9e2 cache_read_input_tokens=800"),
      chatCall("2026-10-03T07:26:00.000Z", "input_tokens=900 input_tokens=90000 cache_read_input_tokens=800"),
      chatCall("2026-10-03T07:27:00.000Z", "input_tokens=900 cache_read_input_tokens=901"),
      "2026-10-03T07:28:00.000Z info Copilot web search completion path=/chat/completions http_status=200 input_tokens=900 cache_read_input_tokens=800",
      "completion path=/chat/completions http_status=200 input_tokens=900 cache_read_input_tokens=800",
      "",
    ) + unfinished,
    // The undated pre-rotation file and files of other names are not read.
    "copilot-relay.log": entries(chatLine),
    "notes.txt": entries(chatLine),
  })

  const rows = await buildCacheReport({ view: "summary", since: lastDay, goal: 95 })

  assert.deepEqual(essentials(rows), [
    {
      bucket: null,
      model: "claude-opus-5.5",
      route: "/chat/completions",
      requests: 1,
      totalInputTokens: 31431,
      cacheReadTokens: 30924,
    },
  ])
})

// A log is read in 64 KiB chunks, so an entry can be split across two of them. A run without a line
// break that grows past 1 MiB is dropped, and the entry after it still counts.
test("reads a log far larger than one read chunk, entry by entry", async () => {
  const entry = chatCall("2026-10-03T07:00:00.000Z", "input_tokens=100 cache_read_input_tokens=90")
  const batch = Array.from({ length: 1000 }, () => entry)
  const overlong = `${entry} padding=${"x".repeat(1536 * 1024)}`

  await writeLogs({ [dated("2026-10-03")]: entries(...batch, overlong, ...batch) })

  const rows = await buildCacheReport({ view: "summary", since: lastDay, goal: 95 })

  assert.deepEqual(rows.map((row) => [row.requests, row.totalInputTokens, row.cacheReadTokens]), [[2000, 200000, 180000]])
})

test("a call that logged no cache read is unknown, not a zero read", async () => {
  await writeLogs({
    [dated("2026-10-03")]: entries(
      chatCall("2026-10-03T07:00:00.000Z", "input_tokens=1000 cache_read_input_tokens=900"),
      chatCall("2026-10-03T07:01:00.000Z", "input_tokens=500 cache_read_input_tokens=0"),
      // Usage arrived but the cache read did not.
      chatCall("2026-10-03T07:02:00.000Z", "input_tokens=4000"),
      completion("2026-10-03T07:03:00.000Z", "path=/v1/messages http_status=200 body=cancelled model=claude-opus-5-5 terminal=unknown input_tokens=3 cache_creation_input_tokens=700"),
    ),
  })

  const options: CacheReportOptions = { view: "summary", since: lastDay, goal: 95 }
  const rows = await buildCacheReport(options)

  assert.deepEqual(rows, [
    {
      bucket: null,
      model: "claude-opus-5-5",
      route: "/v1/messages",
      requests: 1,
      unknownCacheRequests: 1,
      zeroCacheReadRequests: 0,
      totalInputTokens: 0,
      cacheReadTokens: 0,
      uncachedInputTokens: 0,
      cacheWriteTokens: null,
      hitRate: null,
      belowGoal: false,
    },
    {
      bucket: null,
      model: "claude-opus-5.5",
      route: "/chat/completions",
      requests: 3,
      unknownCacheRequests: 1,
      zeroCacheReadRequests: 1,
      // The unknown call's 4,000 tokens stay out, so the rate is 900 of 1,500.
      totalInputTokens: 1500,
      cacheReadTokens: 900,
      uncachedInputTokens: 600,
      cacheWriteTokens: null,
      hitRate: 900 / 1500,
      belowGoal: true,
    },
  ])

  // The line under the table counts the calls of unknown caching in every row: one in each here.
  assert.ok(renderCacheReport(rows, options).includes("HIT RATE leaves out 2 calls that logged no cache_read_input_tokens."))
  assert.ok(renderCacheReport(rows.slice(0, 1), options).includes("HIT RATE leaves out 1 call that logged no cache_read_input_tokens."))

  // A row whose calls all have unknown caching has no rate: a dash, gray on a color terminal, never
  // a rate of 0.
  assert.deepEqual(renderCacheReport(rows, options), [
    "Prompt-cache hit rate since 2026-10-02 17:30 local time, goal 95%",
    "",
    "  MODEL            ROUTE              REQUESTS  HIT RATE",
    "  claude-opus-5-5  /v1/messages              1         -",
    "  claude-opus-5.5  /chat/completions         3    60.00%",
    "",
    "HIT RATE leaves out 2 calls that logged no cache_read_input_tokens.",
  ])

  const colored = renderCacheReport(rows, options, true).join("\n")
  assert.ok(colored.includes("\u001b[90m       -\u001b[0m"))
  assert.ok(colored.includes("\u001b[31m  60.00%\u001b[0m"))
})

test("hourly and daily trends bucket by local time", async () => {
  await writeLogs({
    [dated("2026-09-30")]: entries(chatCall("2026-09-30T10:00:00.000Z", "input_tokens=50 cache_read_input_tokens=50")),
    // 23:45 local time.
    [dated("2026-10-02")]: entries(chatCall("2026-10-02T18:15:00.000Z", "input_tokens=100 cache_read_input_tokens=90")),
    [dated("2026-10-03")]: entries(
      // 00:30 local time on 2026-10-03, while UTC is still on 2026-10-02.
      chatCall("2026-10-02T19:00:00.000Z", "input_tokens=200 cache_read_input_tokens=100"),
      // 12:00 and 12:59 local time: one local hour, which UTC would split at 07:00.
      chatCall("2026-10-03T06:30:00.000Z", "input_tokens=300 cache_read_input_tokens=270"),
      chatCall("2026-10-03T07:29:00.000Z", "input_tokens=400 cache_read_input_tokens=360"),
      // 13:15 local time, in the same UTC hour as 12:59.
      chatCall("2026-10-03T07:45:00.000Z", "input_tokens=500 cache_read_input_tokens=0"),
    ),
  })

  const hourly = await buildCacheReport({ view: "hourly", since: lastDay, goal: 95 })
  const daily = await buildCacheReport({ view: "daily", goal: 95 })
  const trend = (rows: Array<CacheRow>) =>
    rows.map((row) => [row.bucket, row.requests, row.totalInputTokens, row.cacheReadTokens])

  // The last 24 hours leave 2026-09-30 out.
  assert.deepEqual(trend(hourly), [
    ["2026-10-02 23:00", 1, 100, 90],
    ["2026-10-03 00:00", 1, 200, 100],
    ["2026-10-03 12:00", 2, 700, 630],
    ["2026-10-03 13:00", 1, 500, 0],
  ])

  // Without a window, the daily trend covers every retained day.
  assert.deepEqual(trend(daily), [
    ["2026-09-30", 1, 50, 50],
    ["2026-10-02", 1, 100, 90],
    ["2026-10-03", 4, 1400, 730],
  ])
})

test("the daily table leads with the local day, and colors only the rate", async () => {
  await writeLogs({
    [dated("2026-09-30")]: entries(chatCall("2026-09-30T10:00:00.000Z", "input_tokens=50 cache_read_input_tokens=50")),
    [dated("2026-10-03")]: entries(chatCall("2026-10-03T06:30:00.000Z", "input_tokens=400 cache_read_input_tokens=300")),
  })

  const options: CacheReportOptions = { view: "daily", goal: 95 }
  const rows = await buildCacheReport(options)

  assert.deepEqual(renderCacheReport(rows, options), [
    "Prompt-cache hit rate by local day across all retained logs, goal 95%",
    "",
    "  DAY         MODEL            ROUTE              REQUESTS  HIT RATE",
    "  2026-09-30  claude-opus-5.5  /chat/completions         1   100.00%",
    "  2026-10-03  claude-opus-5.5  /chat/completions         1    75.00%",
  ])

  const colored = renderCacheReport(rows, options, true).join("\n")
  assert.ok(colored.includes("  2026-09-30  claude-opus-5.5  /chat/completions         1  \u001b[32m 100.00%\u001b[0m"))
  assert.ok(colored.includes("  2026-10-03  claude-opus-5.5  /chat/completions         1  \u001b[31m  75.00%\u001b[0m"))
})

// The suite runs in Asia/Kolkata, which has no daylight saving. These tests need other zones.
const inTimeZone = async (zone: string, run: () => Promise<void>): Promise<void> => {
  process.env.TZ = zone

  try {
    await run()
  } finally {
    process.env.TZ = "Asia/Kolkata"
  }
}

// When clocks go back, one local hour happens twice. Each real hour keeps its own row, told apart
// by its UTC offset, so the trend still shows when the rate changed.
test("an hour that repeats when clocks go back keeps one row per real hour", async () => {
  await inTimeZone("America/New_York", async () => {
    // Daylight saving time ends at 02:00 local time on 2026-11-01, which is 06:00 UTC.
    await writeLogs({
      [dated("2026-11-01")]: entries(
        // 00:30 and 01:30 EDT, then 01:30 and 02:30 EST.
        chatCall("2026-11-01T04:30:00.000Z", "input_tokens=100 cache_read_input_tokens=90"),
        chatCall("2026-11-01T05:30:00.000Z", "input_tokens=100 cache_read_input_tokens=100"),
        chatCall("2026-11-01T06:30:00.000Z", "input_tokens=100 cache_read_input_tokens=0"),
        chatCall("2026-11-01T07:30:00.000Z", "input_tokens=100 cache_read_input_tokens=50"),
      ),
    })

    const rows = await buildCacheReport({ view: "hourly", since: new Date("2026-11-01T00:00:00.000Z"), goal: 95 })

    assert.deepEqual(rows.map((row) => [row.bucket, row.requests, row.cacheReadTokens]), [
      ["2026-11-01 00:00", 1, 90],
      ["2026-11-01 01:00 UTC-04:00", 1, 100],
      ["2026-11-01 01:00 UTC-05:00", 1, 0],
      ["2026-11-01 02:00", 1, 50],
    ])
  })
})

// Pacific/Chatham goes back 45 minutes past the hour, from 03:45 to 02:45, so the 02:00 and 03:00
// labels both repeat. Subtracting a call's minutes would date the second 02:00 to 13:15 UTC, the
// start of the first 03:00, and sort the two hours out of order.
test("hours that repeat when clocks go back mid-hour stay in the order they happened", async () => {
  await inTimeZone("Pacific/Chatham", async () => {
    // Daylight saving time ends at 03:45 local time on 2026-04-05, which is 14:00 UTC on 2026-04-04.
    await writeLogs({
      [dated("2026-04-05")]: entries(
        // 02:15 and 03:15 at UTC+13:45, then 02:50 and 03:15 at UTC+12:45.
        chatCall("2026-04-04T12:30:00.000Z", "input_tokens=100 cache_read_input_tokens=10"),
        chatCall("2026-04-04T13:30:00.000Z", "input_tokens=100 cache_read_input_tokens=20"),
        chatCall("2026-04-04T14:05:00.000Z", "input_tokens=100 cache_read_input_tokens=30"),
        chatCall("2026-04-04T14:30:00.000Z", "input_tokens=100 cache_read_input_tokens=40"),
      ),
    })

    const rows = await buildCacheReport({ view: "hourly", since: new Date("2026-04-04T00:00:00.000Z"), goal: 95 })

    assert.deepEqual(rows.map((row) => [row.bucket, row.cacheReadTokens]), [
      ["2026-04-05 02:00 UTC+13:45", 10],
      ["2026-04-05 03:00 UTC+13:45", 20],
      ["2026-04-05 02:00 UTC+12:45", 30],
      ["2026-04-05 03:00 UTC+12:45", 40],
    ])
  })
})

test("--since and --model narrow the report", async () => {
  await writeLogs({
    // 10:30 local time on 2026-10-02: older than the default 24 hours, inside 2d.
    [dated("2026-10-02")]: entries(chatCall("2026-10-02T05:00:00.000Z", "input_tokens=1000 cache_read_input_tokens=500")),
    [dated("2026-10-03")]: entries(chatLine, messagesLine, responsesLine),
  })

  const report = async (args: CacheArguments): Promise<Array<CacheRow>> =>
    await buildCacheReport(resolveCacheOptions({ goal: "95", ...args }, now))
  const modelsOf = async (args: CacheArguments): Promise<Array<string>> =>
    (await report(args)).map((row) => row.model)

  assert.deepEqual(essentials(await report({ model: "claude-opus-5.5" })), [
    {
      bucket: null,
      model: "claude-opus-5.5",
      route: "/chat/completions",
      requests: 1,
      totalInputTokens: 31431,
      cacheReadTokens: 30924,
    },
  ])
  assert.deepEqual(essentials(await report({ model: "claude-opus-5.5", since: "2d" })), [
    {
      bucket: null,
      model: "claude-opus-5.5",
      route: "/chat/completions",
      requests: 2,
      totalInputTokens: 32431,
      cacheReadTokens: 31424,
    },
  ])

  // An ISO time without an offset is local: 12:23 here is 06:53 UTC.
  assert.deepEqual(await modelsOf({ since: "2026-10-03T12:23" }), ["claude-opus-5.5", "gpt-5.5-2026-04-23"])

  // --model matches part of a name, ignoring case.
  assert.deepEqual(await modelsOf({ model: "OPUS" }), ["claude-opus-5-5", "claude-opus-5.5"])
  assert.deepEqual(await modelsOf({ model: "5.5" }), ["claude-opus-5.5", "gpt-5.5-2026-04-23"])
})

// After a time-zone change, an entry can sit in the file for the day before its local date.
test("the window also reads the file dated the day before it starts", async () => {
  await writeLogs({
    [dated("2026-10-02")]: entries(chatCall("2026-10-02T19:00:00.000Z", "input_tokens=100 cache_read_input_tokens=90")),
  })

  // Local midnight starting 2026-10-03; the entry is 30 minutes later.
  const rows = await buildCacheReport({ view: "summary", since: new Date("2026-10-02T18:30:00.000Z"), goal: 95 })

  assert.deepEqual(rows.map((row) => row.requests), [1])
})

// UTC offsets span 26 hours, from UTC-12 to UTC+14. After a move across the date line, an entry
// can sit in a file dated two days before the local date the window starts on.
test("the window reads files dated up to two days before it starts", async () => {
  await inTimeZone("Pacific/Kiritimati", async () => {
    await writeLogs({
      // Written at UTC-12, where 11:30 UTC on 2026-10-01 is still 2026-09-30.
      [dated("2026-09-30")]: entries(chatCall("2026-10-01T11:30:00.000Z", "input_tokens=100 cache_read_input_tokens=90")),
    })

    // 01:00 on 2026-10-02 at UTC+14, half an hour before the entry.
    const rows = await buildCacheReport({ view: "summary", since: new Date("2026-10-01T11:00:00.000Z"), goal: 95 })

    assert.deepEqual(rows.map((row) => row.requests), [1])
  })
})

// File dates compare as dates. As text, the unpadded year 999 would sort after 2026.
test("a window that starts before the year 1000 still reads every later file", async () => {
  await writeLogs({ [dated("2026-10-03")]: entries(chatLine) })

  const rows = await buildCacheReport({ view: "summary", since: parseSince("1000-01-01", now), goal: 95 })

  assert.deepEqual(rows.map((row) => row.requests), [1])
})

test("--since takes a duration or an ISO date or time", () => {
  assert.deepEqual(parseSince("6h", now), new Date("2026-10-03T06:00:00.000Z"))
  assert.deepEqual(parseSince("2d", now), new Date("2026-10-01T12:00:00.000Z"))
  assert.deepEqual(parseSince("30m", now), new Date("2026-10-03T11:30:00.000Z"))
  assert.deepEqual(parseSince(" 2D ", now), new Date("2026-10-01T12:00:00.000Z"))

  // A date, or a time without Z or an offset, is local, like every other time in the report.
  assert.deepEqual(parseSince("2026-10-03", now), new Date("2026-10-02T18:30:00.000Z"))
  assert.deepEqual(parseSince("2026-10-03T09:00", now), new Date("2026-10-03T03:30:00.000Z"))
  assert.deepEqual(parseSince("2026-10-03 09:00:30", now), new Date("2026-10-03T03:30:30.000Z"))
  assert.deepEqual(parseSince("2026-10-03T09:00:00Z", now), new Date("2026-10-03T09:00:00.000Z"))
  assert.deepEqual(parseSince("2026-10-03T09:00:00+02:00", now), new Date("2026-10-03T07:00:00.000Z"))

  for (const value of [
    "",
    "yesterday",
    "6",
    "6w",
    "-1d",
    "1.5h",
    "99999999999999999999d",
    "2026-02-30",
    "2026-13-01",
    "0026-10-03",
    "26-10-03",
    "2026-10-03T24:00",
    "2026-10-03T09:60",
    "2026-10-03T09:00:00+25:00",
  ]) {
    assert.throws(() => parseSince(value, now), CacheUsageError, value)
  }
})

test("--goal takes a percentage from 0 to 100 with at most two decimals", () => {
  assert.equal(parseGoal("95"), 95)
  assert.equal(parseGoal("97.5"), 97.5)
  assert.equal(parseGoal("95.45"), 95.45)
  assert.equal(parseGoal("90%"), 90)
  assert.equal(parseGoal("0"), 0)
  assert.equal(parseGoal("100"), 100)

  // The report prints and compares rates in hundredths of a percent.
  for (const value of ["", "high", "-5", "100.5", "1e2", ".5", "95%%", "97.125"]) {
    assert.throws(() => parseGoal(value), CacheUsageError, value)
  }
})

test("the flags resolve to a view, a window and a goal", () => {
  assert.deepEqual(resolveCacheOptions({ goal: "95" }, now), { view: "summary", goal: 95, since: lastDay })
  assert.deepEqual(resolveCacheOptions({ goal: "95", hourly: true }, now), { view: "hourly", goal: 95, since: lastDay })

  // The daily trend reads every retained day unless --since is given.
  assert.deepEqual(resolveCacheOptions({ goal: "95", daily: true }, now), { view: "daily", goal: 95 })
  assert.deepEqual(
    resolveCacheOptions({ goal: "97.5", daily: true, since: "2d", model: " opus " }, now),
    { view: "daily", goal: 97.5, since: new Date("2026-10-01T12:00:00.000Z"), model: "opus" },
  )

  // citty passes "" for a string flag given without a value, and an array for a repeated one.
  for (const args of [
    { hourly: true, daily: true },
    { model: "" },
    { model: "  " },
    { since: "" },
    { since: ["6h", "2d"] },
    { goal: "" },
    { goal: "101" },
  ]) {
    assert.throws(() => resolveCacheOptions(args, now), CacheUsageError, JSON.stringify(args))
  }
})

test("--json rows keep one stable key set", async () => {
  await writeLogs({ [dated("2026-10-03")]: entries(chatLine) })

  const rows = await buildCacheReport({ view: "hourly", since: lastDay, goal: 95 })
  const parsed = JSON.parse(JSON.stringify(rows)) as Array<Record<string, unknown>>

  assert.deepEqual(parsed, [
    {
      bucket: "2026-10-03 12:00",
      model: "claude-opus-5.5",
      route: "/chat/completions",
      requests: 1,
      unknownCacheRequests: 0,
      zeroCacheReadRequests: 0,
      totalInputTokens: 31431,
      cacheReadTokens: 30924,
      uncachedInputTokens: 507,
      cacheWriteTokens: null,
      hitRate: 30924 / 31431,
      belowGoal: false,
    },
  ])
  assert.deepEqual(Object.keys(parsed[0]), [
    "bucket",
    "model",
    "route",
    "requests",
    "unknownCacheRequests",
    "zeroCacheReadRequests",
    "totalInputTokens",
    "cacheReadTokens",
    "uncachedInputTokens",
    "cacheWriteTokens",
    "hitRate",
    "belowGoal",
  ])
})

test("the table shows requests and hit rate per model and route, the rate in red below the goal", async () => {
  await writeLogs({ [dated("2026-10-03")]: entries(chatLine, messagesLine, responsesLine) })

  const options: CacheReportOptions = { view: "summary", since: lastDay, goal: 95 }
  const rows = await buildCacheReport(options)

  assert.deepEqual(renderCacheReport(rows, options), [
    "Prompt-cache hit rate since 2026-10-02 17:30 local time, goal 95%",
    "",
    "  MODEL               ROUTE              REQUESTS  HIT RATE",
    "  claude-opus-5-5     /v1/messages              1    98.36%",
    "  claude-opus-5.5     /chat/completions         1    98.38%",
    "  gpt-5.5-2026-04-23  /responses                1    92.86%",
  ])

  // On a color terminal the rate below the goal is red, and nothing else marks the row.
  const colored = renderCacheReport(rows, options, true).join("\n")
  assert.ok(colored.includes("\u001b[31m  92.86%\u001b[0m"))
  assert.ok(colored.includes("\u001b[32m  98.38%\u001b[0m"))
  assert.ok(!colored.includes("below goal"))

  // Against a lower goal, no rate is red.
  const relaxed: CacheReportOptions = { ...options, goal: 90 }
  assert.ok(!renderCacheReport(await buildCacheReport(relaxed), relaxed, true).join("\n").includes("\u001b[31m"))
})

test("a row on the goal is not flagged, and a row just below it never prints as the goal", async () => {
  await writeLogs({
    [dated("2026-10-03")]: entries(
      completion("2026-10-03T07:00:00.000Z", "path=/chat/completions http_status=200 body=complete model=at-goal terminal=true input_tokens=2000 cache_read_input_tokens=1900"),
      completion("2026-10-03T07:01:00.000Z", "path=/chat/completions http_status=200 body=complete model=under-goal terminal=true input_tokens=100000 cache_read_input_tokens=94999"),
    ),
  })

  const options: CacheReportOptions = { view: "summary", since: lastDay, goal: 95 }
  const rows = await buildCacheReport(options)
  const text = renderCacheReport(rows, options).join("\n")

  assert.deepEqual(rows.map((row) => [row.model, row.belowGoal]), [["at-goal", false], ["under-goal", true]])
  assert.match(text, /^ {2}at-goal .* 95\.00%$/m)

  // 94.999% is truncated to 94.99%, not rounded up to the goal it misses.
  assert.match(text, /^ {2}under-goal .* 94\.99%$/m)
})

// A goal with decimals is compared exactly. In binary floating point, 95.4 * 10,500 comes out a
// little above 1,001,700, which would put a row that sits on the goal below it.
test("a decimal goal flags exactly the rows whose printed rate is below it", async () => {
  await writeLogs({
    [dated("2026-10-03")]: entries(
      completion("2026-10-03T07:00:00.000Z", "path=/chat/completions http_status=200 body=complete model=at-goal terminal=true input_tokens=10500 cache_read_input_tokens=10017"),
      completion("2026-10-03T07:01:00.000Z", "path=/chat/completions http_status=200 body=complete model=under-goal terminal=true input_tokens=10500 cache_read_input_tokens=10016"),
    ),
  })

  const options: CacheReportOptions = { view: "summary", since: lastDay, goal: 95.4 }
  const rows = await buildCacheReport(options)
  const text = renderCacheReport(rows, options).join("\n")

  assert.deepEqual(rows.map((row) => [row.model, row.belowGoal]), [["at-goal", false], ["under-goal", true]])
  assert.match(text, /^ {2}at-goal .* 95\.40%$/m)
  assert.match(text, /^ {2}under-goal .* 95\.39%$/m)
})

// A caller that builds the options itself gets the --goal rule too. Rows are compared in whole
// hundredths of a percent, so 97.124 would be applied as 97.12 under a heading that claims 97.124.
test("a goal that --goal would refuse is refused, not rounded", async () => {
  await writeLogs({ [dated("2026-10-03")]: entries(chatLine) })

  for (const goal of [97.124, Number.NaN, -1, 101]) {
    await assert.rejects(buildCacheReport({ view: "summary", since: lastDay, goal }), CacheUsageError, String(goal))
  }
})

test("an empty window says there is no data and where the data would come from", async () => {
  await fs.rm(paths.logsDir, { recursive: true, force: true })

  const options: CacheReportOptions = { view: "summary", since: lastDay, goal: 95, model: "opus" }
  const rows = await buildCacheReport(options)

  assert.deepEqual(rows, [])
  assert.deepEqual(renderCacheReport(rows, options), [
    "No prompt-cache data since 2026-10-02 17:30 local time, for models matching \"opus\".",
    `The report reads the upstream completion entries in ${paths.logsDir}.`,
    "They are written at logLevel info or debug, not error, and kept for logRetentionDays.",
  ])
})

test("model names from the log are made safe for the terminal", () => {
  const escaped = chatLine.replace("model=claude-opus-5.5", "model=\u001b[2Kevil‮name")
  const emptied = chatLine.replace("model=claude-opus-5.5", "model=\u001b[2K")

  assert.equal(parseCompletionLine(escaped)?.model, "evilname")

  // A name with nothing printable left reads as unknown, like a missing one.
  assert.equal(parseCompletionLine(emptied)?.model, "unknown")
})
