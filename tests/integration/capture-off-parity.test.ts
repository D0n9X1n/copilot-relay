// A normal request, with debug capture off, must log and count exactly what v0.7.1 did. The golden
// was recorded once by running this same scenario against v0.7.1's src/. It pins the outward
// effect of the code a capture-off request still runs through:
// - the request wrapper that admits the request and sets its trace,
// - the response observer that reads each upstream reply's outcome and usage,
// - the manifest whose state and outcome the `request outcome` entry reports,
// - the admission snapshots of config and runtime state each pass routes with,
// - partial-upload cancellation, which must not hold back or alter a request that completes.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer as createHttpServer, type IncomingMessage } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// paths.ts resolves the home directory when it is imported, so every home variable is redirected
// before src/ loads. Node reads USERPROFILE on Windows and HOME elsewhere.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-capture-off-parity-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CODEX_HOME = path.join(home, ".codex")
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude")
process.env.CONSOLA_LEVEL = "0"

const { createServer } = await import("../../src/server")
const { runtimeState } = await import("../../src/lib/state")
const { flushLogs, isDebugLogging } = await import("../../src/lib/log")
const { withTraceObserver } = await import("../../src/lib/request-trace")
const { buildCacheReport } = await import("../../src/lib/cache-report")
const { readLogs } = await import("../fixtures/logs")
type RequestTrace = import("../../src/lib/request-trace").RequestTrace
type CacheRow = import("../../src/lib/cache-report").CacheRow

interface Golden {
  lines: Array<string>
  cacheRows: Array<CacheRow>
}

const golden = JSON.parse(
  await fs.readFile(new URL("../fixtures/capture-off-parity.golden.json", import.meta.url), "utf8"),
) as Golden

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

const readJsonBody = async (request: IncomingMessage): Promise<{ model?: string; tools?: Array<unknown> }> => {
  let body = ""
  for await (const chunk of request) {
    body += String(chunk)
  }

  return JSON.parse(body) as { model?: string; tools?: Array<unknown> }
}

// Copilot for one WebSearch turn: the decision pass calls web_search, the search runs on
// /responses, and the final pass, which carries no tools, answers. Each reply has its own usage,
// with cached input, so a swapped or dropped count shows in the log and in the cache totals.
const startMockCopilot = async () => {
  const upstreamPaths: Array<string> = []
  const server = createHttpServer(async (request, response) => {
    const upstreamPath = request.url ?? "/"
    const body = await readJsonBody(request)
    upstreamPaths.push(upstreamPath)
    response.setHeader("content-type", "application/json")

    if (upstreamPath === "/chat/completions" && body.tools?.length) {
      response.end(JSON.stringify({
        id: "chat_decision",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_web_search_1",
                  type: "function",
                  function: { name: "web_search", arguments: JSON.stringify({ query: "GitHub Copilot docs" }) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 40,
          total_tokens: 1240,
          prompt_tokens_details: { cached_tokens: 1000 },
        },
      }))
      return
    }

    if (upstreamPath === "/responses") {
      response.end(JSON.stringify({
        id: "resp_search",
        created_at: 1,
        model: body.model,
        output: [
          {
            type: "web_search_call",
            status: "completed",
            action: { type: "search", query: "GitHub Copilot docs" },
          },
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "1. GitHub Copilot documentation - https://docs.github.com/en/copilot",
              },
            ],
          },
        ],
        usage: {
          input_tokens: 300,
          output_tokens: 60,
          total_tokens: 360,
          input_tokens_details: { cached_tokens: 100 },
        },
      }))
      return
    }

    if (upstreamPath === "/chat/completions") {
      response.end(JSON.stringify({
        id: "chat_final",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "Copilot docs are at docs.github.com." },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 1500,
          completion_tokens: 25,
          total_tokens: 1525,
          prompt_tokens_details: { cached_tokens: 1400 },
        },
      }))
      return
    }

    response.statusCode = 404
    response.end(JSON.stringify({ error: "not found" }))
  })

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve)
  })

  const address = server.address()
  assert.ok(address && typeof address === "object")

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
    upstreamPaths,
  }
}

// The turn's request-scoped entries, with what changes on every run replaced: the leading
// timestamp, the relay request ID, and each upstream request ID, numbered in the order logged.
const normalizedTurnLines = (logText: string, requestId: string): Array<string> => {
  const upstreamIds = new Map<string, string>()

  return logText
    .split("\n")
    .filter((line) => line.includes(`request_id=${requestId} `))
    .filter((line) => line.includes(" completion path=") || line.includes(" request outcome "))
    .map((line) => line
      .replace(/^\S+ /, "<time> ")
      .replaceAll(requestId, "<request-id>")
      .replace(/upstream_request_id=(\S+)/, (_match, id: string) => {
        if (!upstreamIds.has(id)) {
          upstreamIds.set(id, `<upstream-request-id-${upstreamIds.size + 1}>`)
        }

        return `upstream_request_id=${upstreamIds.get(id)}`
      }))
}

test("a capture-off WebSearch turn logs and counts what v0.7.1 did", async () => {
  runtimeState.thinkEffort = "xhigh"
  runtimeState.modelRouting = { gptModel: "gpt-5.5", opusModel: "claude-opus-4.8" }
  const mock = await startMockCopilot()
  const started = Date.now()
  let trace: RequestTrace | undefined

  try {
    assert.equal(isDebugLogging(), false)
    const app = createServer({
      copilotBaseUrl: mock.baseUrl,
      copilotToken: "test-token",
      host: "127.0.0.1",
      port: 0,
      upstreamTimeoutMs: 180_000,
      vsCodeVersion: "1.99.3",
    })
    const response = await withTraceObserver(
      (value) => {
        trace = value
      },
      () => app.fetch(new Request("http://localhost/v1/messages", {
        body: JSON.stringify({
          max_tokens: 16,
          messages: [{ role: "user", content: "search the web for copilot docs" }],
          model: "opus",
          tools: [{ name: "web_search", type: "web_search_20250305", max_uses: 1 }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })),
    )

    assert.equal(response.status, 200)
    assert.match(await response.text(), /"web_search_tool_result"/)
    assert.ok(trace)
    await trace.finished
    await flushLogs()

    assert.equal(trace.diagnosticSnapshot().capture.state, "off")
    assert.deepEqual(mock.upstreamPaths, ["/chat/completions", "/responses", "/chat/completions"])
    assert.deepEqual(normalizedTurnLines(await readLogs(), trace.requestId), golden.lines)

    // What `cache --json` prints: the summary rows of this home's log, the turn's log only.
    const rows = await buildCacheReport({ view: "summary", since: new Date(started - 60_000), goal: 95 })
    assert.deepEqual(rows, golden.cacheRows)
  } finally {
    delete runtimeState.thinkEffort
    delete runtimeState.modelRouting
    await mock.close()
  }
})
