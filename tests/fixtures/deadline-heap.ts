// Runs in a child started with --expose-gc. It drives relay requests through the in-process app
// with the shipped 180-second upstream deadline, then prints how much the heap grew and how many of
// the sampled request traces are still reachable once every response has ended.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import type { ProxyConfig } from "../../src/lib/config"

// src/lib/paths reads the home directory on import, so redirect HOME and USERPROFILE (Windows) first.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-deadline-heap-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { createServer } = await import("../../src/server")
const { getRequestTrace, withRecordedTransport } = await import("../../src/lib/request-trace")
const { runtimeState } = await import("../../src/lib/state")
const { flushLogs } = await import("../../src/lib/log")

const gc = (globalThis as { gc?: () => void }).gc
if (gc === undefined) {
  throw new Error("Run with --expose-gc.")
}

const provider = "https://heap.invalid"
const model = "gpt-6-astra"
const config: ProxyConfig = {
  host: "127.0.0.1",
  port: 0,
  copilotBaseUrl: provider,
  copilotToken: "fixture-heap-token",
  upstreamTimeoutMs: 180_000,
  vsCodeVersion: "test",
  claudeUpstreamApi: "auto",
}

runtimeState.modelRouting = { gptModel: model, opusModel: "claude-opus-5.5" }
runtimeState.upstreamBaseUrl = provider
const app = createServer(config)

const result = {
  id: "resp_ok",
  model,
  created_at: 1,
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
}

const catalog = () => Response.json({ data: [
  { id: model, supported_endpoints: ["/responses"], capabilities: { type: "chat" } },
  { id: "claude-opus-5.5", supported_endpoints: ["/v1/messages"], capabilities: { type: "chat" } },
] })

const events = (): Response => {
  const lines = [
    { type: "response.created", response: { ...result, status: "in_progress", output: [] } },
    { type: "response.output_text.delta", output_index: 0, delta: "OK" },
    { type: "response.completed", response: result },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  return new Response(lines.join(""), { status: 200, headers: { "content-type": "text/event-stream" } })
}

const sampled: Array<WeakRef<object>> = []
const sampleEvery = 100

const run = async (count: number, stream: boolean, sample: boolean) => {
  for (let index = 0; index < count; index++) {
    await withRecordedTransport({
      fetch: async (request) => {
        if (request.path === "/models") {
          return catalog()
        }

        const trace = getRequestTrace()
        if (sample && trace !== undefined && index % sampleEvery === 0) {
          sampled.push(new WeakRef(trace))
        }

        return stream ? events() : Response.json(result)
      },
      refresh: async () => {
        throw new Error("Unexpected credential refresh")
      },
    }, async () => {
      const response = await app.fetch(new Request("http://127.0.0.1/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, max_tokens: 64, stream, messages: [{ role: "user", content: "hello" }] }),
      }))
      const text = await response.text()
      if (response.status !== 200) {
        throw new Error(`Relay answered ${response.status}: ${text.slice(0, 300)}`)
      }
    })
  }
}

// Log entries are written asynchronously; flush them so the heap holds only what the requests kept.
const settle = async () => {
  await flushLogs()
  for (let round = 0; round < 4; round++) {
    await new Promise((resolve) => setImmediate(resolve))
    gc()
  }
}

await run(50, false, false)
await run(50, true, false)
await settle()
const before = process.memoryUsage().heapUsed

const total = Number(process.env.HEAP_REQUESTS ?? 1000)
await run(total, false, true)
await run(total, true, true)
await settle()
const after = process.memoryUsage().heapUsed

await flushLogs()
process.stdout.write(`${JSON.stringify({
  growthBytes: after - before,
  sampled: sampled.length,
  reachable: sampled.filter((ref) => ref.deref() !== undefined).length,
})}\n`)
await fs.rm(home, { recursive: true, force: true })
process.exit(0)
