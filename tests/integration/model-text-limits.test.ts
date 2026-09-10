import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { encode } from "gpt-tokenizer/encoding/o200k_base"

import { astraLimits, modelCatalogPayload, opusLimits } from "../fixtures/model-limits"
import type { ProxyConfig } from "../../src/lib/config"
import type { ClaudeStreamEventData } from "../../src/claude/types"

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay-long-text-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome
process.env.CONSOLA_LEVEL = "0"

const { createServer } = await import("../../src/server")
const { loadCopilotModelCatalog } = await import("../../src/copilot/models")
const { runtimeState } = await import("../../src/lib/state")

test.after(async () => { await fs.rm(tempHome, { recursive: true, force: true }) })
test.afterEach(() => {
  delete runtimeState.modelRouting
  delete runtimeState.modelCatalog
  delete runtimeState.upstreamBaseUrl
})

const textAtTokenLimit = (tokens: number): string => {
  const suffix = " \u4e2d\u6587 \u{1f680}"
  const text = " a".repeat(tokens - encode(suffix).length) + suffix
  assert.equal(encode(text).length, tokens)
  return text
}

test("unknown tokenizer names retain the conservative fallback without errors", async () => {
  for (const tokenizer of ["unknown-tokenizer", "__proto__"]) {
    const baseUrl = "http://127.0.0.1:1"
    const app = createServer({
      copilotBaseUrl: baseUrl, copilotToken: "test-token",
      host: "127.0.0.1", port: 0, upstreamTimeoutMs: 0, vsCodeVersion: "1.99.3",
      modelCatalog: {
        baseUrl,
        models: new Map([["claude-opus-5", { limits: opusLimits, tokenizer }]]),
      },
    })
    const response = await app.fetch(new Request("http://localhost/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "opus", max_tokens: 16, messages: [{ role: "user", content: "hello" }],
      }),
    }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      input_tokens: Math.round((encode("hello").length + 7) * 1.15),
    })
  }
})

for (const model of ["gpt-6-astra", "claude-opus-5"]) {
  for (const stream of [false, true]) {
    test(`${model} preserves full prompt/output limits with stream=${stream}`, async () => {
      const limits = model === "gpt-6-astra" ? astraLimits : opusLimits
      const input = textAtTokenLimit(limits.max_prompt_tokens)
      const output = textAtTokenLimit(limits.max_output_tokens)
      const requests: Array<{ path: string; body: Record<string, unknown> }> = []
      const upstream = createHttpServer(async (request, response) => {
        let raw = ""
        for await (const chunk of request) raw += chunk
        const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
        requests.push({ path: request.url ?? "/", body })
        response.setHeader("content-type", "application/json")
        if (request.url === "/models") {
          response.end(JSON.stringify(modelCatalogPayload))
          return
        }
        const writeEvent = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`)
        const usage = {
          prompt_tokens: limits.max_prompt_tokens,
          completion_tokens: limits.max_output_tokens,
          total_tokens: limits.max_context_window_tokens,
        }
        if (request.url === "/responses") {
          const result = {
            id: "resp_long", created_at: 1, model,
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: output }] }],
            usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens, total_tokens: usage.total_tokens },
            incomplete_details: { reason: "max_output_tokens" },
          }
          if (body.stream) {
            response.setHeader("content-type", "text/event-stream")
            writeEvent({ type: "response.created", response: { ...result, output: [] } })
            for (let index = 0; index < output.length; index += 4096) {
              writeEvent({ type: "response.output_text.delta", output_index: 0, delta: output.slice(index, index + 4096) })
            }
            writeEvent({ type: "response.completed", response: result })
            response.end()
          } else response.end(JSON.stringify(result))
          return
        }
        if (request.url === "/chat/completions") {
          // Opus's native JSON ceiling is lower. The relay must request SSE,
          // even when its own caller requested a completed JSON response.
          if (!body.stream && Number(body.max_tokens) > 16_000) {
            response.statusCode = 400
            response.end(JSON.stringify({ error: { message: "streaming required above 16000 tokens" } }))
            return
          }
          response.setHeader("content-type", "text/event-stream")
          for (let index = 0; index < output.length; index += 4096) {
            writeEvent({
              id: "chat_long", model, created: 1,
              choices: [{ index: 0, delta: { content: output.slice(index, index + 4096) }, finish_reason: null }],
            })
          }
          writeEvent({
            id: "chat_long", model, created: 1,
            choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage,
          })
          response.end("data: [DONE]\n\n")
          return
        }
        response.statusCode = 404
        response.end()
      })
      await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
      const address = upstream.address()
      assert.ok(address && typeof address === "object")
      const config: ProxyConfig = {
        copilotBaseUrl: `http://127.0.0.1:${address.port}`,
        copilotToken: "test-token",
        host: "127.0.0.1", port: 0, upstreamTimeoutMs: 0, vsCodeVersion: "1.99.3",
      }
      runtimeState.modelRouting = { gptModel: "gpt-6-astra", opusModel: "claude-opus-5" }
      runtimeState.upstreamBaseUrl = config.copilotBaseUrl
      try {
        await loadCopilotModelCatalog(config)
        const app = createServer(config)
        const models = await (await app.fetch(new Request("http://localhost/v1/models"))).json() as {
          data: Array<{ id: string; context_window: number; max_input_tokens: number; max_tokens: number }>
        }
        const exposed = models.data.find((entry) => entry.id.startsWith(model))
        assert.ok(exposed)
        assert.equal(exposed.context_window, limits.max_context_window_tokens)
        assert.equal(exposed.max_input_tokens, limits.max_prompt_tokens)
        assert.equal(exposed.max_tokens, limits.max_output_tokens)
        assert.equal(requests.length, 1)

        const countResponse = await app.fetch(new Request("http://localhost/v1/messages/count_tokens", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: exposed.id, max_tokens: 128_000,
            messages: [{ role: "user", content: input }],
          }),
        }))
        const count = await countResponse.json() as { input_tokens: number }
        assert.equal(countResponse.status, 200)
        assert.equal(count.input_tokens, limits.max_prompt_tokens + 7)
        assert.equal(requests.length, 1)

        const response = await app.fetch(new Request("http://localhost/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: exposed.id,
            max_tokens: 128_000,
            stream,
            messages: [{ role: "user", content: input }],
            tools: [{ name: "WebSearch", input_schema: { type: "object" } }],
          }),
        }))
        assert.equal(response.status, 200)
        let returnedText: string
        if (stream) {
          const events = (await response.text()).split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => JSON.parse(line.slice(6)) as ClaudeStreamEventData)
          assert.ok(events.some((event) => event.type === "message_stop"))
          assert.ok(!events.some((event) => event.type === "error"))
          returnedText = events.flatMap((event) =>
            event.type === "content_block_delta" && event.delta.type === "text_delta" ?
              [event.delta.text] : [],
          ).join("")
          const final = events.find((event) => event.type === "message_delta")
          assert.ok(final?.type === "message_delta")
          assert.equal(final.usage?.output_tokens, limits.max_output_tokens)
          assert.equal(final.delta.stop_reason, "max_tokens")
        } else {
          const body = await response.json() as {
            content: Array<{ type: string; text: string }>
            usage: { output_tokens: number }
            stop_reason: string
          }
          returnedText = body.content.filter((block) => block.type === "text").map((block) => block.text).join("")
          assert.equal(body.usage.output_tokens, limits.max_output_tokens)
          assert.equal(body.stop_reason, "max_tokens")
        }
        assert.equal(returnedText, output)
        assert.equal(encode(returnedText).length, limits.max_output_tokens)
        assert.equal(requests.length, 2)
        const sent = requests[1]
        assert.ok(sent)
        if (model === "gpt-6-astra") {
          assert.equal(sent.path, "/responses")
          assert.equal(sent.body.input, input)
          assert.equal(sent.body.max_output_tokens, 128_000)
        } else {
          assert.equal(sent.path, "/chat/completions")
          assert.equal((sent.body.messages as Array<{ content: string }>)[0]?.content, input)
          assert.equal(sent.body.max_tokens, 64_000)
          assert.equal(sent.body.stream, true)
        }
      } finally {
        upstream.closeAllConnections()
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
      }
    })
  }
}
