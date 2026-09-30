import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { encode } from "gpt-tokenizer/encoding/o200k_base"
import { Hono } from "hono"

import { astraLimits, modelCatalogPayload, opusLimits, opus55Limits } from "../fixtures/model-limits"
import type { ProxyConfig, ProxyEnv } from "../../src/lib/config"
import type { ClaudeMessagesPayload, ClaudeStreamEventData } from "../../src/claude/types"

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay-long-text-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome
process.env.CONSOLA_LEVEL = "0"

const { createServer } = await import("../../src/server")
const { claudeRoutes } = await import("../../src/routes/claude")
const { loadCopilotModelCatalog } = await import("../../src/copilot/models")
const { runtimeState } = await import("../../src/lib/state")

const { flushLogs } = await import("../../src/lib/log")
test.after(async () => { await flushLogs(); await fs.rm(tempHome, { recursive: true, force: true }) })
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
        models: new Map([["claude-opus-5.5", { limits: opus55Limits, tokenizer }]]),
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

for (const claudeUpstreamApi of ["auto", "messages"] as const) {
  test(`native ${claudeUpstreamApi} counts system controls locally without changing the Messages payload`, async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = []
    const upstream = createHttpServer(async (request, response) => {
      let raw = ""
      for await (const chunk of request) raw += chunk
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {}
      requests.push({ path: request.url ?? "/", body })
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({
        id: "msg_count", type: "message", role: "assistant", model: body.model,
        content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }))
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    assert.ok(address && typeof address === "object")
    const config: ProxyConfig = {
      copilotBaseUrl: `http://127.0.0.1:${address.port}`, copilotToken: "test-token",
      host: "127.0.0.1", port: 0, upstreamTimeoutMs: 1000, vsCodeVersion: "1.99.3", claudeUpstreamApi,
    }
    config.modelCatalog = {
      baseUrl: config.copilotBaseUrl,
      models: new Map([["claude-opus-5.5", {
        tokenizer: "o200k_base",
        supportedEndpoints: claudeUpstreamApi === "auto" ? ["/v1/messages"] : ["/chat/completions"],
      }]]),
    }
    const payload: ClaudeMessagesPayload = {
      model: "opus", max_tokens: 16, system: "Global instruction.", output_config: { effort: "low" },
      messages: [
        { role: "user", content: "first question" },
        { role: "system", content: "Think carefully.", output_config: { effort: "high" } },
        { role: "assistant", content: "first answer" },
        { role: "system", content: [{ type: "text", text: "Be brief." }, { type: "text", text: "Keep context." }], clear_at: "next_user_message" },
        { role: "system", content: "Follow up instruction.", output_config: { effort: "low" }, clear_at: "next_user_message" },
        { role: "user", content: "second question" },
        { role: "assistant", content: "second answer" },
        { role: "system", content: "Remember the question.", clear_at: "next_user_message" },
      ],
    }
    const original = structuredClone(payload)
    const inputTexts = ["Global instruction.", "first question", "Think carefully.", "Be brief.\n\nKeep context.", "Follow up instruction.", "second question", "Remember the question."]
    const expectedTokens = inputTexts.reduce((tokens, text) => tokens + encode(text).length + 4, 3)
      + encode("first answer").length + encode("second answer").length + 11
    const app = createServer(config)
    const post = (body: unknown, route = "/v1/messages/count_tokens") => app.fetch(new Request(`http://localhost${route}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }))
    try {
      // Read Hono's cached JSON after the actual count handler to observe its
      // input object, not just a separate caller-side serialization.
      const countApp = new Hono<ProxyEnv>()
      let afterCount: unknown
      countApp.use("*", async (c, next) => {
        c.set("config", config)
        await next()
        afterCount = await c.req.json()
      })
      countApp.route("/v1", claudeRoutes)
      const directCount = await countApp.fetch(new Request("http://localhost/v1/messages/count_tokens", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      }))
      assert.equal(directCount.status, 200, await directCount.clone().text())
      assert.deepEqual(await directCount.json(), { input_tokens: expectedTokens })
      assert.deepEqual(afterCount, original)
      assert.equal(requests.length, 0)

      const response = await post(payload)
      assert.equal(response.status, 200, await response.clone().text())
      const count = await response.json() as { input_tokens: number }
      assert.equal(count.input_tokens, expectedTokens)
      assert.equal(requests.length, 0)

      const plain = { ...payload, messages: payload.messages.map(({ role, content }) => ({ role, content })) }
      assert.deepEqual(await (await post(plain)).json(), count)
      assert.equal(requests.length, 0)

      for (const invalid of [
        { ...payload, output_config: { effort: "invalid" } },
        { ...payload, output_config: undefined, reasoning_effort: "invalid" },
        { ...payload, messages: [{ role: "system", content: [{ type: "image", source: {} }], clear_at: "next_user_message" }] },
        { ...payload, messages: [{ role: "unsupported", content: "invalid role" }] },
      ]) {
        const rejected = await post(invalid)
        assert.equal(rejected.status, 400)
        assert.equal((await rejected.json() as { error: { type: string } }).error.type, "invalid_request_error")
      }
      for (const mode of [undefined, "chat-completions"] as const) {
        config.claudeUpstreamApi = mode
        assert.equal((await post(payload)).status, 400)
      }
      config.claudeUpstreamApi = claudeUpstreamApi
      assert.equal((await post({ ...payload, model: "sonnet" })).status, 400)
      assert.equal(requests.length, 0)

      assert.equal((await post(payload, "/v1/messages")).status, 200)
      assert.deepEqual(requests, [{ path: "/v1/messages", body: { ...original, model: "claude-opus-5.5", stream: false } }])
      assert.deepEqual(payload, original)
    } finally {
      upstream.closeAllConnections()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
}

for (const model of ["gpt-6-astra", "claude-opus-5", "claude-opus-5.5"]) {
  for (const stream of [false, true]) {
    test(`${model} preserves full prompt/output limits with stream=${stream}`, async () => {
      const limits = model === "gpt-6-astra" ? astraLimits : model === "claude-opus-5.5" ? opus55Limits : opusLimits
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
      runtimeState.modelRouting = { gptModel: "gpt-6-astra", opusModel: model === "gpt-6-astra" ? "claude-opus-5.5" : model }
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
          assert.equal(sent.body.max_tokens, limits.max_output_tokens)
          assert.equal(sent.body.stream, true)
        }
      } finally {
        upstream.closeAllConnections()
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
      }
    })
  }
}
