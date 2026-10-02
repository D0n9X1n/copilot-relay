import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer as createHttpServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// src/ resolves its paths from the home directory at import time, so redirect it before importing.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-opus55-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { createServer } = await import("../../src/server")
const { runtimeState } = await import("../../src/lib/state")
const { opus55Limits } = await import("../fixtures/model-limits")
const { flushLogs } = await import("../../src/lib/log")

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

test.afterEach(() => {
  delete runtimeState.thinkEffort
})

async function fixture(t: import("node:test").TestContext) {
  // Every request the relay sends upstream, in order.
  const requests: Array<{ path: string; body: Record<string, any> }> = []
  const upstream = createHttpServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) {
      raw += chunk
    }

    const body = JSON.parse(raw)
    requests.push({ path: req.url!, body })
    res.setHeader("content-type", "application/json")

    // Copilot rejects forced tool selection for this model; the relay must pass that through.
    if (body.tool_choice === "required" || body.tool_choice?.type === "function") {
      res.writeHead(400)
      res.end(JSON.stringify({
        error: { message: 'tool_choice: type "tool" and "any" are not supported for this model.' },
      }))
      return
    }

    // The WebSearch pass: one search call, then an answer citing the result.
    if (req.url === "/responses") {
      res.end(JSON.stringify({
        id: "resp_search",
        model: body.model,
        status: "completed",
        output: [
          { type: "web_search_call", status: "completed" },
          { type: "message", content: [{ type: "output_text", text: "Docs - https://example.com/docs" }] },
        ],
        usage: { input_tokens: 20, output_tokens: 10 },
      }))
      return
    }

    // Ask for a tool call until a tool result arrives: WebSearch when offered, otherwise echo.
    const tools = body.tools ?? []
    const offersWebSearch = tools.some(
      (tool: { function?: { name?: string } }) => tool.function?.name === "WebSearch",
    )
    const hasToolResult = body.messages.some((message: { role: string }) => message.role === "tool")
    const toolCall = tools.length && !hasToolResult ? {
      id: "call_echo",
      type: "function",
      function: {
        name: offersWebSearch ? "WebSearch" : "echo",
        arguments: offersWebSearch ? '{"query":"public docs"}' : '{"value":"OK"}',
      },
    } : undefined
    const message = toolCall ?
      { role: "assistant", content: null, tool_calls: [toolCall] }
    : { role: "assistant", content: "OK" }
    const finishReason = toolCall ? "tool_calls" : "stop"
    const usage = { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 }

    if (body.stream) {
      res.setHeader("content-type", "text/event-stream")
      const delta = toolCall ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] } : message
      res.end(`data: ${JSON.stringify({
        id: "chat_opus55",
        model: body.model,
        created: 1,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        usage,
      })}\n\ndata: [DONE]\n\n`)
    } else {
      res.end(JSON.stringify({
        id: "chat_opus55",
        model: body.model,
        created: 1,
        choices: [{ index: 0, message, finish_reason: finishReason }],
        usage,
      }))
    }
  })

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  })

  const address = upstream.address()
  assert(address && typeof address === "object")
  const baseUrl = `http://127.0.0.1:${address.port}`
  const app = createServer({
    copilotBaseUrl: baseUrl,
    copilotToken: "fake-token",
    host: "127.0.0.1",
    port: 0,
    upstreamTimeoutMs: 3000,
    vsCodeVersion: "1.99.3",
    modelCatalog: { baseUrl, models: new Map([["claude-opus-5.5", { limits: opus55Limits }]]) },
  })

  const send = (fields: Record<string, unknown>) => app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "opus",
      max_tokens: 4096,
      messages: [{ role: "user", content: "Reply OK" }],
      ...fields,
    }),
  }))

  return { app, send, requests }
}

for (const stream of [false, true]) {
  for (const effort of [undefined, "low", "medium", "high", "xhigh", "max"]) {
    test(`Opus 5.5 default route preserves effort=${effort ?? "default"} stream=${stream}`, async (t) => {
      const relay = await fixture(t)
      // The configured default applies only when the request names no effort.
      runtimeState.thinkEffort = "max"

      const response = await relay.send({ stream, ...(effort && { output_config: { effort } }) })

      assert.equal(response.status, 200)
      const text = await response.text()
      assert.match(text, /claude-opus-5\.5/)
      if (stream) {
        assert.equal((text.match(/event: message_stop/g) ?? []).length, 1)
      } else {
        assert.equal(JSON.parse(text).content[0].text, "OK")
      }

      assert.equal(relay.requests.length, 1)
      assert.equal(relay.requests[0]?.path, "/chat/completions")
      assert.equal(relay.requests[0]?.body.model, "claude-opus-5.5")
      assert.equal(relay.requests[0]?.body.reasoning_effort, effort ?? "max")
      assert.equal(relay.requests[0]?.body.max_tokens, 4096)
    })
  }

  test(`Opus 5.5 automatic tool choice and continuation stream=${stream}`, async (t) => {
    const relay = await fixture(t)
    const tools = [{
      name: "echo",
      input_schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    }]

    const response = await relay.send({ stream, tools })

    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /call_echo/)
    assert.match(text, /tool_use/)
    if (stream) {
      assert.equal((text.match(/event: message_stop/g) ?? []).length, 1)
    }

    const continuation = await relay.send({
      tools,
      messages: [
        { role: "user", content: "Echo OK" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_echo", name: "echo", input: { value: "OK" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_echo", content: "OK" }] },
      ],
    })

    assert.equal(continuation.status, 200)
    assert.equal(
      (await continuation.json() as { content: Array<{ text: string }> }).content[0]?.text,
      "OK",
    )

    // The tool result goes upstream as a `tool` message, and the relay appends a user turn after
    // it because Copilot rejects a conversation that ends on any other role.
    const upstreamMessages = relay.requests[1]?.body.messages
    assert(upstreamMessages.some(
      (message: { role: string; tool_call_id?: string }) =>
        message.role === "tool" && message.tool_call_id === "call_echo",
    ))
    assert.equal(upstreamMessages.at(-1)?.role, "user")
    assert.equal(relay.requests[1]?.body.model, "claude-opus-5.5")
  })
}

for (const stream of [false, true]) {
  test(`Opus 5.5 WebSearch returns to the Opus route stream=${stream}`, async (t) => {
    const relay = await fixture(t)

    const response = await relay.send({
      stream,
      output_config: { effort: "low" },
      tools: [{ name: "WebSearch", input_schema: { type: "object" } }],
    })

    assert.equal(response.status, 200)
    const text = await response.text()
    assert.match(text, /web_search_tool_result/)
    assert.match(text, /https:\/\/example.com\/docs/)
    assert.match(text, /claude-opus-5\.5/)
    if (stream) {
      assert.equal((text.match(/event: message_stop/g) ?? []).length, 1)
    } else {
      assert.equal(JSON.parse(text).model, "claude-opus-5.5")
    }

    // Opus requests the search, /responses runs it, and Opus answers at the requested effort.
    assert.deepEqual(
      relay.requests.map((request) => request.path),
      ["/chat/completions", "/responses", "/chat/completions"],
    )
    assert.equal(relay.requests[2]?.body.model, "claude-opus-5.5")
    assert.equal(relay.requests[2]?.body.reasoning_effort, "low")
    assert.equal(relay.requests[2]?.body.messages.at(-1)?.role, "user")
  })
}

for (const type of ["tool", "any"]) {
  test(`Opus 5.5 preserves upstream rejection for forced ${type} selection`, async (t) => {
    const relay = await fixture(t)

    const response = await relay.send({
      tools: [{ name: "echo", input_schema: { type: "object" } }],
      tool_choice: { type, ...(type === "tool" && { name: "echo" }) },
    })

    assert.equal(response.status, 400)
    assert.match(await response.text(), /not supported for this model/)
    // A single upstream request: the rejection is passed through, not retried.
    assert.equal(relay.requests.length, 1)
    assert.deepEqual(
      relay.requests[0]?.body.tool_choice,
      type === "any" ? "required" : { type: "function", function: { name: "echo" } },
    )
  })
}
