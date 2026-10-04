import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

// The CLI runs in a child process against fixture logs in this temporary home. paths.ts resolves
// the home directory when it is imported, so it is redirected first. Node reads USERPROFILE on
// Windows and HOME elsewhere, so both are set.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-cache-command-"))
process.env.HOME = home
process.env.USERPROFILE = home

const { getLogPath, paths } = await import("../../src/lib/paths")

assert.ok(paths.logsDir.startsWith(home), paths.logsDir)

test.after(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

const entry = new URL("../../src/main.ts", import.meta.url)
const cwd = fileURLToPath(new URL("../../", import.meta.url))

// One call on each route an hour or two ago, inside the default 24-hour window, each written to the
// file for its local date in the form the relay writes it.
const calls: Array<[number, string]> = [
  [120, "path=/chat/completions http_status=200 body=complete model=claude-opus-5.5 finish_reason=tool_calls stop_reason=unknown terminal=true input_tokens=31431 output_tokens=55 cache_read_input_tokens=30924"],
  [90, "path=/v1/messages http_status=200 body=complete model=claude-opus-5-5 finish_reason=unknown stop_reason=tool_use terminal=true input_tokens=2 output_tokens=55 cache_read_input_tokens=31136 cache_creation_input_tokens=516"],
  [60, "path=/responses http_status=200 body=complete model=gpt-5.5-2026-04-23 finish_reason=unknown stop_reason=unknown response_status=completed terminal=true input_tokens=19297 output_tokens=22 cache_read_input_tokens=17920"],
]

await fs.mkdir(paths.logsDir, { recursive: true })

for (const [minutesAgo, fields] of calls) {
  const time = new Date(Date.now() - minutesAgo * 60_000)
  await fs.appendFile(getLogPath(time), `${time.toISOString()} info request_id=req upstream_request_id=up completion ${fields}\n`)
}

// Every directory and file under a directory, with each file's content.
const snapshot = async (directory: string): Promise<Array<string>> => {
  const listed: Array<string> = []

  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const itemPath = path.join(directory, item.name)

    if (item.isDirectory()) {
      listed.push(`${itemPath}${path.sep}`, ...(await snapshot(itemPath)))
    } else {
      listed.push(`${itemPath}: ${await fs.readFile(itemPath, "utf8")}`)
    }
  }

  return listed.sort()
}

interface CliResult {
  code: number
  stdout: string
  stderr: string
}

const networkFixture = new URL("../fixtures/network.ts", import.meta.url)

// Runs `copilot-relay <args>` with the temporary home. In the child, fetch throws and so does any
// socket to another host, so a network call fails the run instead of reaching out. GitHub and
// Copilot calls go through undici's dispatcher rather than fetch, hence the socket guard.
const run = async (args: Array<string>): Promise<CliResult> => {
  const before = await snapshot(home)
  const script = `
    const { refuseExternalConnections } = await import(${JSON.stringify(networkFixture.href)});
    refuseExternalConnections();
    globalThis.fetch = async () => {
      throw new Error("UNEXPECTED_NETWORK_ACCESS");
    };
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entry))}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(entry.href)});
  `
  const result = await new Promise<CliResult>((resolve, reject) => {
    const child = execFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd,
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: "1", HOME: home, USERPROFILE: home },
    }, (error, stdout, stderr) => {
      const code = error ? error.code : 0

      if (error?.killed || typeof code !== "number") {
        reject(error ?? new Error("Missing CLI exit code"))
        return
      }

      resolve({ code, stdout, stderr })
    })

    child.stdin?.end()
  })

  // The command only reads: nothing under the home appears, changes or goes away, config included.
  assert.deepEqual(await snapshot(home), before)
  assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_NETWORK_ACCESS/)

  return result
}

test("cache --json prints one row per model and upstream route", async () => {
  const result = await run(["cache", "--json"])

  assert.equal(result.code, 0, result.stderr)

  const rows = JSON.parse(result.stdout) as Array<Record<string, unknown>>
  assert.deepEqual(
    rows.map((row) => [row.model, row.route, row.requests, row.totalInputTokens, row.cacheReadTokens, row.belowGoal]),
    [
      ["claude-opus-5-5", "/v1/messages", 1, 31654, 31136, false],
      ["claude-opus-5.5", "/chat/completions", 1, 31431, 30924, false],
      ["gpt-5.5-2026-04-23", "/responses", 1, 19297, 17920, true],
    ],
  )
})

test("cache --hourly prints one row per hour, model and route, ending in its hit rate", async () => {
  const result = await run(["cache", "--hourly", "--goal", "98.37"])

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^Prompt-cache hit rate by local hour since .+ local time, goal 98\.37%$/m)
  assert.match(result.stdout, /^ {2}HOUR +MODEL +ROUTE +REQUESTS {2}HIT RATE$/m)

  // 98.36% is just under the goal and 98.38% just over it. NO_COLOR is set, so no rate is colored,
  // and nothing else marks the rows below the goal.
  assert.match(result.stdout, /^ {2}\d{4}-\d{2}-\d{2} \d{2}:00 {2}claude-opus-5-5 .* 98\.36%$/m)
  assert.match(result.stdout, /^ {2}\d{4}-\d{2}-\d{2} \d{2}:00 {2}claude-opus-5\.5 .* 98\.38%$/m)
  assert.match(result.stdout, /^ {2}\d{4}-\d{2}-\d{2} \d{2}:00 {2}gpt-5\.5-2026-04-23 .* 92\.86%$/m)
  assert.doesNotMatch(result.stdout, /\u001b\[|below goal/)
})

test("cache explains an unusable flag and exits 1", async () => {
  const result = await run(["cache", "--since", "yesterday"])

  assert.equal(result.code, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /--since needs a duration such as 30m, 6h or 2d/)
})

test("cache says plainly when nothing matches", async () => {
  const result = await run(["cache", "--model", "no-such-model"])

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^No prompt-cache data since .+ local time, for models matching "no-such-model"\.$/m)
  assert.match(result.stdout, /written at logLevel info or debug, not error/)
})
