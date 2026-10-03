import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-upstream-error-log-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { createChatCompletions } = await import("../../src/copilot/chat")
const { flushLogs, withoutConsoleLogging } = await import("../../src/lib/log")
const { getLogPath } = await import("../../src/lib/paths")

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

const sentinel = "UPSTREAM_BODY_SENTINEL"

const readErrorEntry = async (): Promise<string> => {
  // File writes are fire-and-forget so logging never blocks a request.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await flushLogs()
    const content = await fs.readFile(getLogPath(), "utf8").catch(() => "")
    const entry = content.split("\n").find((line) => line.includes("Failed to create chat completions"))
    if (entry) {
      return entry
    }

    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  throw new Error("the upstream error was never logged")
}

// #144: a gpt-5.4 failure entry hit the argument bound inside the request, so the
// upstream body that explained the HTTP 400 never reached the log.
test("a request longer than the log bound keeps the upstream body in the entry", async (t) => {
  const upstream = createServer((request, response) => {
    request.resume()
    response.writeHead(400, { "content-type": "text/plain" })
    response.end(`${sentinel}\n`)
  })

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })
  const address = upstream.address()
  assert(address && typeof address !== "string")

  // Twelve 3000-character descriptions put the request well past the 16 KiB argument bound.
  const tools = Array.from({ length: 12 }, (_, index) => ({
    type: "function" as const,
    function: { name: `Tool${index}`, description: "d".repeat(3000), parameters: { type: "object" } },
  }))

  // The file entry is the subject. Node's test runner reports over stdout, so keep the console quiet.
  await assert.rejects(withoutConsoleLogging(() => createChatCompletions({
    host: "127.0.0.1", port: 0, copilotBaseUrl: `http://127.0.0.1:${address.port}`,
    copilotToken: "fixture-only", upstreamTimeoutMs: 3000, vsCodeVersion: "1.99.3",
  }, { model: "gpt-4.1", messages: [{ role: "user", content: "Hi" }], tools })))

  const entry = await readErrorEntry()
  const responseAt = entry.indexOf("response: {")

  assert.match(entry, /\[truncated\]$/)
  assert.ok(entry.includes(sentinel), "the upstream body was cut from the entry")
  assert.ok(responseAt >= 0 && responseAt < entry.indexOf("request: {"), "the request is logged ahead of the response")
})
