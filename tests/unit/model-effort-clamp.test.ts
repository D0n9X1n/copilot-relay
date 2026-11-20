import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { readLogs } from "../fixtures/logs"

// Redirected before src/ loads: paths.ts reads the home directory at import time.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-effort-clamp-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CODEX_HOME = path.join(home, ".codex")
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude")

const { createServer: createRelay } = await import("../../src/server")
const { runtimeState } = await import("../../src/lib/state")
const { withRecordedTransport } = await import("../../src/lib/request-trace")
const { flushLogs, withoutConsoleLogging } = await import("../../src/lib/log")
type CopilotModel = import("../../src/copilot/models").CopilotModel

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

test.beforeEach(() => {
  runtimeState.modelRouting = { gptModel: "grok-4.7", opusModel: "claude-opus-5.5" }
})

test.afterEach(() => {
  delete runtimeState.modelRouting
})

const baseUrl = "https://fixture.invalid"

const catalogWith = (grokEfforts: Array<string>, opusEfforts: Array<string>) => ({
  baseUrl,
  models: new Map<string, CopilotModel>([
    ["grok-4.7", { type: "chat", supportedEndpoints: ["/responses"], reasoningEfforts: grokEfforts }],
    ["claude-opus-5.5", { type: "chat", supportedEndpoints: ["/v1/messages"], reasoningEfforts: opusEfforts }],
  ]),
})

const advertised = catalogWith(["low", "medium", "high"], ["low", "medium", "high"])

const responsesReply = () => Response.json({
  id: "resp_fixture",
  model: "grok-4.7",
  created_at: 1,
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
})

const messagesReply = () => Response.json({
  id: "msg_fixture",
  type: "message",
  role: "assistant",
  model: "claude-opus-5.5",
  content: [{ type: "text", text: "OK" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
})

interface Sent {
  path: string
  body: Record<string, any>
}

const send = async (catalog: ReturnType<typeof catalogWith>, body: Record<string, unknown>) => {
  const sent: Array<Sent> = []
  let status = 0
  let reply: any

  await withRecordedTransport({
    fetch: async (request) => {
      sent.push({ path: request.path, body: JSON.parse(request.body ?? "{}") })
      return request.path.endsWith("/v1/messages") ? messagesReply() : responsesReply()
    },
    refresh: async () => {},
  }, async () => {
    const app = createRelay({
      host: "localhost",
      port: 0,
      copilotBaseUrl: baseUrl,
      copilotToken: "fixture",
      vsCodeVersion: "test",
      upstreamTimeoutMs: 1000,
      claudeUpstreamApi: "auto",
      modelCatalog: catalog,
    })
    const response = await withoutConsoleLogging(() => app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ max_tokens: 32, ...body }),
    })))
    status = response.status
    reply = await response.json()
  })

  return { status, sent, reply }
}

test("grok-4.7 reaches /responses as grok-4.7 with its effort clamped", async () => {
  const { status, sent } = await send(advertised, {
    model: "grok-4.7",
    output_config: { effort: "max" },
    messages: [{ role: "user", content: "Hi" }],
  })

  assert.equal(status, 200)
  assert.ok(sent[0]?.path.endsWith("/responses"))
  assert.equal(sent[0].body.model, "grok-4.7")
  assert.equal(sent[0].body.reasoning.effort, "high")
})

test("native forwards a clamped effort for the turn and each system message", async () => {
  const { status, sent } = await send(advertised, {
    model: "opus",
    output_config: { effort: "max" },
    messages: [{ role: "user", content: "Hi" }, { role: "system", content: "Note.", output_config: { effort: "max" } }],
  })

  assert.equal(status, 200)
  assert.ok(sent[0]?.path.endsWith("/v1/messages"))
  assert.equal(sent[0].body.output_config.effort, "high")
  assert.equal(sent[0].body.messages[1].output_config.effort, "high")
})

test("advertised levels pass unchanged and an empty list keeps its error", async () => {
  const kept = await send(advertised, {
    model: "grok-4.7",
    output_config: { effort: "medium" },
    messages: [{ role: "user", content: "Hi" }],
  })

  assert.equal(kept.status, 200)
  assert.equal(kept.sent[0]?.body.reasoning.effort, "medium")

  const refused = await send(catalogWith([], []), {
    model: "grok-4.7",
    output_config: { effort: "high" },
    messages: [{ role: "user", content: "Hi" }],
  })

  assert.equal(refused.status, 400)
  assert.equal(refused.reply.error.code, "relay_unsupported_effort")
  assert.equal(refused.sent.length, 0)
})

test("a model advertising only minimal receives minimal on /responses", async () => {
  const { status, sent } = await send(catalogWith(["minimal"], ["low"]), {
    model: "grok-4.7",
    output_config: { effort: "max" },
    messages: [{ role: "user", content: "Hi" }],
  })

  assert.equal(status, 200)
  assert.equal(sent[0]?.body.reasoning.effort, "minimal")
})

test("a native model advertising only minimal receives minimal", async () => {
  const { status, sent } = await send(catalogWith(["low"], ["minimal"]), {
    model: "opus",
    output_config: { effort: "max" },
    messages: [{ role: "user", content: "Hi" }],
  })

  assert.equal(status, 200)
  assert.ok(sent[0]?.path.endsWith("/v1/messages"))
  assert.equal(sent[0].body.output_config.effort, "minimal")
})

test("native logs the clamped effort of the system control that governs the turn", async () => {
  // Earlier tests in this file log native requests too, so only lines written after this point count.
  await flushLogs()
  const logLengthBefore = (await readLogs()).length
  const { status, sent } = await send(catalogWith(["low"], ["low", "high"]), {
    model: "opus",
    output_config: { effort: "low" },
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "system", content: "Think harder.", output_config: { effort: "max" } },
      { role: "user", content: "Continue" },
    ],
  })

  assert.equal(status, 200)
  assert.equal(sent[0]?.body.messages[2].output_config.effort, "high")

  let summary: string | undefined
  for (let attempt = 0; attempt < 100 && summary === undefined; attempt++) {
    await flushLogs()
    summary = (await readLogs()).slice(logLengthBefore).split("\n").find((line) => line.includes("upstream_api=messages"))
    if (summary === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  assert.ok(summary, "No native model request was logged")
  assert.match(summary, /effective_think_effort=high\b/)
})
