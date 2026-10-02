import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import type { ClaudeMessage, ClaudeMessagesPayload, ClaudeResponse, ClaudeStreamEventData, ClaudeTool } from "../../src/claude/types"
import type { ChatCompletionsPayload, Message } from "../../src/copilot/types"
import type { ProxyConfig } from "../../src/lib/config"
import type { RecordedRequest } from "../../src/lib/request-trace"

// src/lib/paths reads the home directory on import, so redirect HOME and USERPROFILE (Windows) first.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-model-switch-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { createServer } = await import("../../src/server")
const { runtimeState } = await import("../../src/lib/state")
const { withRecordedTransport } = await import("../../src/lib/request-trace")
const { getTokenCount } = await import("../../src/lib/tokenizer")
const { flushLogs } = await import("../../src/lib/log")

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

// runtimeState is process-wide: clear what a test may set so the next one starts clean.
test.afterEach(() => {
  delete runtimeState.modelRouting
  delete runtimeState.thinkEffort
})

const opus = "claude-opus-5.5"
const gpt = "gpt-6-astra"
const longName = `mcp__fixture__${"long_tool_name_".repeat(6)}`
const tools: ClaudeTool[] = [
  { name: longName, description: "No arguments", input_schema: { type: "object", properties: {} } },
  { name: "Echo", description: "Echo", input_schema: { type: "object", properties: { text: { type: "string" } } } },
]
// Mirrors src/claude/tool-names: non-GPT models cap tool names at 64 characters, so longer
// names are shortened and suffixed with a hash. GPT models allow 128, which longName fits.
const modelName = (model: string, name: string) => model.startsWith("gpt-") || name.length <= 64 ? name
  : `${name.replace(/_+/g, "_").slice(0, 53)}_${createHash("sha1").update(name).digest("hex").slice(0, 10)}`
const selector = (model: string) => model === gpt ? `${gpt}[1m]` : "claude-opus-5-5"
const other = (model: string) => model === opus ? gpt : opus
const limits = (model: string) => ({
  max_context_window_tokens: 100_000, max_prompt_tokens: 90_000,
  max_output_tokens: model.startsWith("gpt-") ? 4096 : 2048,
  ...(model.startsWith("gpt-") ? {} : { max_non_streaming_output_tokens: 512 }),
})
const config = (): ProxyConfig => {
  const baseUrl = "https://model-switch.invalid"
  return {
    host: "localhost", port: 0, copilotBaseUrl: baseUrl, copilotToken: "fixture-only",
    vsCodeVersion: "test", upstreamTimeoutMs: 10_000, claudeUpstreamApi: "chat-completions",
    modelCatalog: {
      baseUrl,
      models: new Map([opus, gpt, "claude-sonnet-4.6", "gpt-5.6-sol"].map((id) => [id, {
        tokenizer: "o200k_base", limits: limits(id),
      }]))
    },
  }
}

const post = async (app: ReturnType<typeof createServer>, payload: ClaudeMessagesPayload, route = "messages") =>
  app.fetch(new Request(`http://localhost/v1/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  }))

const sse = (events: unknown[], done = false) => new Response(
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""),
  { headers: { "content-type": "text/event-stream" } },
)

// A client-side consumer, deliberately not the relay's translator. Closed blocks
// cannot receive deltas; tools are parsed from the bytes actually sent to the client.
async function readReply(response: Response, stream: boolean): Promise<ClaudeResponse> {
  assert.equal(response.status, 200, await response.clone().text())
  if (!stream) {
    return await response.json() as ClaudeResponse
  }

  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/)
  const frames = (await response.text()).split(/\r?\n\r?\n/).filter((frame) => frame.trim())

  let reply: ClaudeResponse | undefined
  const open = new Set<number>()
  const argumentsByIndex = new Map<number, string>()
  let stopped = false
  let deltaSeen = false

  for (const frame of frames) {
    assert.equal(stopped, false, "data after message_stop")

    const lines = frame.split(/\r?\n/)
    const event = JSON.parse(lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")) as ClaudeStreamEventData
    assert.equal(lines.find((line) => line.startsWith("event:"))?.slice(6).trim(), event.type)
    assert.notEqual(event.type, "error", JSON.stringify(event))

    if (event.type === "message_start") {
      assert.equal(reply, undefined)
      reply = { ...event.message, content: [] }
    } else {
      assert.ok(reply, "event before message_start")

      if (event.type === "content_block_start") {
        assert.equal(deltaSeen, false, "content after terminal message_delta")
        assert.equal(open.size, 0, "overlapping content blocks")
        assert.equal(event.index, reply.content.length)
        reply.content.push(structuredClone(event.content_block))
        open.add(event.index)
      } else if (event.type === "content_block_delta") {
        assert.ok(open.has(event.index), "delta targets a closed block")
        const block = reply.content[event.index]
        if (event.delta.type === "text_delta") {
          assert.equal(block.type, "text")
          if (block.type === "text") {
            block.text += event.delta.text
          }
        } else if (event.delta.type === "thinking_delta") {
          assert.equal(block.type, "thinking")
          if (block.type === "thinking") {
            block.thinking += event.delta.thinking
          }
        } else if (event.delta.type === "input_json_delta") {
          assert.ok(block.type === "tool_use" || block.type === "server_tool_use")
          argumentsByIndex.set(event.index, (argumentsByIndex.get(event.index) ?? "") + event.delta.partial_json)
        } else {
          assert.fail("unexpected translated delta")
        }
      } else if (event.type === "content_block_stop") {
        assert.ok(open.delete(event.index), "duplicate block stop")
        const block = reply.content[event.index]
        if (block.type === "tool_use" || block.type === "server_tool_use") {
          const raw = argumentsByIndex.get(event.index)
          assert.ok(raw, "tool must emit parseable argument text")
          block.input = JSON.parse(raw)
        }
      } else if (event.type === "message_delta") {
        assert.equal(open.size, 0)
        assert.equal(deltaSeen, false)
        deltaSeen = true
        reply.stop_reason = event.delta.stop_reason ?? null
        if (event.usage) {
          Object.assign(reply.usage, event.usage)
        }
      } else if (event.type === "message_stop") {
        assert.equal(open.size, 0)
        assert.ok(deltaSeen)
        assert.ok(reply.stop_reason)
        stopped = true
      }
    }
  }

  assert.ok(stopped, "missing message_stop")
  return reply!
}

const barrier = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

type WireCall = { id: string; name: string; arguments: string }
type WireTurn = { role: string; text?: string; calls?: WireCall[]; id?: string }
type WireBody = {
  model: string;
  stream?: boolean;
  reasoning_effort?: string;
  reasoning?: { effort: string };
  max_tokens?: number;
  max_output_tokens?: number;
  messages?: Message[];
  input?: string | Array<{ type?: string; role?: string; content?: string; call_id?: string; name?: string; arguments?: string; output?: string }>;
  tools?: Array<{ type: string; name?: string; function?: { name: string } }>;
  prompt_cache_key?: string;
}

// Reduces either wire format (Chat Completions messages or Responses input) to comparable turns.
function wireTurns(body: WireBody): WireTurn[] {
  if (body.messages) {
    return body.messages.map((message) => ({
      role: message.role,
      text: message.content == null ? "" : String(message.content),
      ...(message.tool_calls && { calls: message.tool_calls.map((call) => ({ id: call.id, ...call.function })) }),
      ...(message.role === "tool" && { id: message.tool_call_id }),
    }))
  }

  if (typeof body.input === "string") {
    return [{ role: "user", text: body.input }]
  }

  return (body.input ?? []).map((item) => {
    if (item.type === "function_call") {
      return { role: "assistant", calls: [{ id: item.call_id!, name: item.name!, arguments: item.arguments! }] }
    }

    if (item.type === "function_call_output") {
      return { role: "tool", id: item.call_id, text: item.output }
    }

    return { role: item.role!, text: item.content }
  })
}

const semanticTurns = (turns: WireTurn[]) => turns.flatMap((turn) => [
  ...(turn.text ? [{ role: turn.role, text: turn.text, ...(turn.id && { id: turn.id }) }] : []),
  ...(turn.calls?.map((call) => ({ role: "assistant", call })) ?? []),
])

function validateWire(request: RecordedRequest, model: string, effort: string, budget: number): WireBody {
  const body = JSON.parse(request.body!) as WireBody
  assert.equal(request.method, "POST")
  assert.equal(body.model, model)

  const responses = model.startsWith("gpt-")
  assert.equal(request.path, responses ? "/responses" : "/chat/completions")
  assert.equal(responses ? body.reasoning?.effort : body.reasoning_effort, effort)
  assert.equal(responses ? body.reasoning_effort : body.reasoning, undefined, "no stale protocol effort field")
  assert.equal(responses ? body.messages : body.input, undefined)
  assert.equal(responses ? body.max_output_tokens : body.max_tokens, budget)
  assert.ok(budget <= limits(model).max_output_tokens)

  const names = body.tools
    ?.filter((tool) => tool.type === "function")
    .map((tool) => responses ? tool.name! : tool.function!.name) ?? []
  for (const name of names) {
    assert.match(name, /^[A-Za-z0-9_-]+$/)
    assert.ok(name.length <= (responses ? 128 : 64))
  }

  const calls = new Set<string>()
  for (const turn of wireTurns(body)) {
    for (const call of turn.calls ?? []) {
      assert.ok(call.id)
      assert.ok(names.includes(call.name), `history tool not in fixture definitions: ${call.name}`)
      assert.equal(typeof call.arguments, "string")
      const input: unknown = JSON.parse(call.arguments)
      assert.ok(input && typeof input === "object" && !Array.isArray(input))
      if (call.name === modelName(model, longName)) {
        assert.equal(call.arguments, "{}")
      }

      calls.add(call.id)
    }

    if (turn.role === "tool") {
      assert.ok(turn.id && calls.has(turn.id), "tool result has no preceding matching call")
    }
  }

  return body
}

// Matching content in two genuine upstream wire formats; empty arguments model #114.
function upstreamReply(body: WireBody, turn: number, call?: { name: string; arguments: string }): Response {
  const text = `answer-${turn}`
  const thinking = `reason-${turn}`
  const id = `${body.model.startsWith("gpt-") ? "call" : "toolu"}_${turn}`

  if (body.model.startsWith("gpt-")) {
    const output = [
      { type: "reasoning", summary: [{ type: "summary_text", text: thinking }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
      ...(call ? [{ type: "function_call", call_id: id, ...call }] : []),
    ]
    const response = {
      id: `resp_${turn}`,
      model: body.model,
      created_at: 1,
      status: "completed",
      output,
      usage: { input_tokens: 10, output_tokens: turn + 1, total_tokens: 11 + turn }
    }

    return body.stream ? sse([
      { type: "response.created", response: { ...response, output: [] } },
      ...output.map((item, output_index) => ({ type: "response.output_item.added", output_index, item })),
      { type: "response.completed", response },
    ]) : Response.json(response)
  }

  const functionCall = call ? [{ id, type: "function", function: call }] : undefined
  const base = { id: `chat_${turn}`, model: body.model, created: 1 }
  const finish_reason = call ? "tool_calls" : "stop"
  const usage = { prompt_tokens: 10, completion_tokens: turn + 1, total_tokens: 11 + turn }

  if (!body.stream) {
    return Response.json({
      ...base,
      choices: [{
        index: 0,
        finish_reason,
        message: { role: "assistant", content: text, reasoning_text: thinking, tool_calls: functionCall }
      }],
      usage
    })
  }

  const chunk = (delta: object, finish: string | null = null) => ({
    ...base,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    ...(finish && { usage })
  })

  return sse([
    chunk({ role: "assistant", reasoning_text: thinking }),
    chunk({ content: text }),
    ...(functionCall ? [chunk({ tool_calls: functionCall.map((tool) => ({ ...tool, index: 0 })) })] : []),
    chunk({}, finish_reason),
  ], true)
}

// Independent expected history for these text/tool fixtures, not translateToOpenAI.
function expectedHistory(messages: ClaudeMessage[], model: string): Message[] {
  return messages.flatMap((message): Message[] => {
    if (typeof message.content === "string") {
      return [{ role: message.role, content: message.content }]
    }

    if (message.role === "system") {
      const text = message.content.map((block) => block.text).join("\n\n")
      return text ? [{ role: "system", content: text }] : []
    }

    if (message.role === "user") {
      return message.content.flatMap((block): Message[] => {
        if (block.type === "tool_result") {
          return [{ role: "tool", tool_call_id: block.tool_use_id, content: typeof block.content === "string" ? block.content : "" }]
        }

        if (block.type === "text") {
          return [{ role: "user", content: block.text }]
        }

        return []
      })
    }

    const content = message.content.flatMap((block) => {
      if (block.type === "text") {
        return [block.text]
      }

      if (block.type === "thinking") {
        return [block.thinking]
      }

      return []
    })

    const calls = message.content.filter((block) => block.type === "tool_use").map((block) => ({
      id: block.id,
      type: "function" as const,
      function: { name: modelName(model, block.name), arguments: JSON.stringify(block.input) },
    }))

    // With tools the existing translated contract puts text before thinking.
    const ordered = calls.length ? [
      ...message.content.filter((block) => block.type === "text").map((block) => block.text),
      ...message.content.filter((block) => block.type === "thinking").map((block) => block.thinking)
    ] : content

    return [{ role: "assistant", content: ordered.join("\n\n") || null, ...(calls.length && { tool_calls: calls }) }]
  })
}

// Counts an independently built payload, so a translator bug cannot cancel out on both sides.
async function assertCount(app: ReturnType<typeof createServer>, payload: ClaudeMessagesPayload, model: string) {
  const expected: ChatCompletionsPayload = {
    model,
    messages: [
      { role: "system", content: String(payload.system) },
      ...expectedHistory(payload.messages, model),
    ],
    tools: payload.tools?.map((tool) => ({
      type: "function",
      function: {
        name: modelName(model, tool.name),
        description: tool.description,
        parameters: tool.input_schema!,
      }
    }))
  }
  const tokens = await getTokenCount(expected, { id: model, capabilities: { tokenizer: "o200k_base" } })

  const response = await post(app, payload, "messages/count_tokens")

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { input_tokens: tokens.input + tokens.output })
  assert.ok(tokens.input + tokens.output > 1)
}

for (const first of [opus, gpt]) {
  for (const mode of ["json", "sse", "buffered"] as const) {
    for (const change of ["model", "effort", "both"] as const) {
      test(`replay real ${mode} history starting ${first}, changing ${change}`, async () => {
        runtimeState.modelRouting = { opusModel: opus, gptModel: gpt }
        runtimeState.thinkEffort = "xhigh"
        const app = createServer(config())

        const messages: ClaudeMessage[] = [{ role: "user", content: "Start." }]
        const seen: WireBody[] = []
        const failures: unknown[] = []
        // The turn loop below advances these; the fake upstream checks each request against them.
        let target = first
        let effort = "low"
        let turn = 0
        const maxTokens = mode === "buffered" ? 8192 : 256

        await withRecordedTransport({
          refresh: async () => assert.fail("no credential refresh expected"),
          fetch: async (request) => {
            try {
              const body = validateWire(request, target, effort, Math.min(maxTokens, limits(target).max_output_tokens))
              // Buffered mode exceeds Opus's 512-token non-streaming limit, so the relay streams upstream.
              assert.equal(body.stream, mode === "sse" || mode === "buffered" && target === opus)
              seen.push(body)
              return upstreamReply(body, turn, turn < 3 ? {
                name: modelName(target, turn === 1 ? "Echo" : longName),
                arguments: turn === 1 ? '{"text":"hi"}' : "",
              } : undefined)
            } catch (error) {
              failures.push(error)
              throw error
            }
          },
        }, async () => {
          for (turn = 0; turn < 4; turn++) {
            target = change === "effort" || turn % 2 === 0 ? first : other(first)
            effort = change === "model" ? "low" : ["low", "high", "max", "medium"][turn]

            const payload: ClaudeMessagesPayload = {
              model: selector(target),
              max_tokens: maxTokens,
              stream: mode === "sse",
              system: "Stable instruction.",
              tools,
              metadata: { user_id: "switch-session" },
              messages,
              output_config: { effort: change === "both" ? "low" : effort as "low" },
              reasoning_effort: "xhigh",
            }
            const original = structuredClone(payload)
            const before = seen.length

            await assertCount(app, payload, target)
            assert.equal(seen.length, before, "counting must not contact upstream")

            const response = await post(app, payload)
            assert.deepEqual(failures, [])
            const reply = await readReply(response, mode === "sse")

            assert.deepEqual(payload, original)
            assert.equal(reply.usage.output_tokens, turn + 1)
            assert.equal(seen.length, before + 1)

            const body = seen.at(-1)!
            const wire = wireTurns(body)
            assert.equal(wire[0].role, "system")
            assert.equal(wire[0].text, "Stable instruction.")

            const expected = expectedHistory(messages, target)
            // Chat appends its documented user continuation after a tool/system
            // tail. Compare semantic history across formats, not differing wire bytes.
            if (target === opus && expected.at(-1)?.role !== "user") {
              expected.push({ role: "user", content: "Continue based on the context above." })
            }

            assert.deepEqual(semanticTurns(wire.slice(1)), semanticTurns(wireTurns({ model: target, messages: expected })))

            for (let earlier = 0; earlier < turn; earlier++) {
              assert.ok(wire.some((item) => item.text?.includes(`answer-${earlier}`)))
              assert.ok(wire.some((item) => item.text?.includes(`reason-${earlier}`)))
              assert.ok(wire.some((item) => item.role === "tool" && item.text === `result-${earlier}`))
            }

            if (turn < 3) {
              const call = reply.content.find((block) => block.type === "tool_use")
              assert.ok(call?.type === "tool_use")
              assert.equal(call.name, turn === 1 ? "Echo" : longName)
              assert.deepEqual(call.input, turn === 1 ? { text: "hi" } : {})

              messages.push({ role: "assistant", content: reply.content })
              if (change === "both") {
                // In "both" mode the next turn's effort arrives as a system control, not output_config.
                messages.push({ role: "system", content: [], output_config: { effort: ["high", "max", "medium"][turn] as "high" } })
              }

              messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: `result-${turn}` }] })
              if (turn === 1) {
                messages.push({ role: "system", content: "Keep the operator instruction here." })
              }

              if (turn === 2) {
                messages.push({ role: "system", content: [], output_config: { effort: "low" } })
              }
            }

            // Per-request effort never changes the process-wide default.
            assert.equal(runtimeState.thinkEffort, "xhigh")
          }
        })

        assert.deepEqual(failures, [])
      })
    }
  }
}

for (const first of [opus, gpt]) {
  for (const stream of [false, true]) {
    test(`switch after translated WebSearch from ${first}, stream=${stream}`, async () => {
      runtimeState.modelRouting = { opusModel: opus, gptModel: gpt }
      runtimeState.thinkEffort = "high"
      const policy = config()
      const app = createServer(policy)

      const entered = barrier()
      const release = barrier()
      const seen: WireBody[] = []
      const failures: unknown[] = []
      const searchTools = [...tools, { name: "WebSearch", input_schema: { type: "object" } }]
      const messages: ClaudeMessage[] = [{ role: "user", content: "Search for the fixture." }]
      let turn = 0
      // Turn 0's retrieval pass goes to the GPT search backend; all other calls to the turn's model.
      const expectedModel = (retrieval: boolean | undefined) => {
        if (turn === 0) {
          return retrieval ? gpt : first
        }

        return other(first)
      }

      await withRecordedTransport({
        refresh: async () => assert.fail("no refresh expected"),
        fetch: async (request) => {
          try {
            const incoming = JSON.parse(request.body!) as WireBody
            const retrieval = incoming.tools?.some((tool) => tool.type === "web_search_preview")
            const target = expectedModel(retrieval)
            const body = validateWire(request, target, turn === 0 ? "high" : "max", 256)
            seen.push(body)

            // The first pass parks until the test has changed the policy, and only then answers
            // with a WebSearch tool call.
            if (seen.length === 1) {
              entered.resolve()
              await release.promise
              return upstreamReply(body, 10, { name: "WebSearch", arguments: '{"query":"fixture"}' })
            }

            if (retrieval) {
              return Response.json({
                id: "resp_search", model: gpt, created_at: 1,
                output: [
                  { type: "web_search_call", status: "completed", action: { type: "search", query: "fixture" } },
                  { type: "message", content: [{ type: "output_text", text: "1. Fixture - https://example.com/fixture" }] },
                ],
                usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
              })
            }

            return upstreamReply(body, turn === 0 ? 11 : 12)
          } catch (error) {
            failures.push(error)
            entered.resolve()
            throw error
          }
        },
      }, async () => {
        const payload: ClaudeMessagesPayload = {
          model: selector(first),
          max_tokens: 256,
          stream,
          system: "Stable instruction.",
          messages,
          tools: searchTools,
          metadata: { user_id: "search-switch" }
        }
        const original = structuredClone(payload)

        const pending = post(app, payload).then((response) => readReply(response, stream))
        await Promise.race([entered.promise, pending.then(() => assert.fail("request finished before the upstream barrier"))])

        // An admitted decision keeps its retrieval backend and effort even when
        // the next request's policy changes before the upstream response arrives.
        runtimeState.thinkEffort = "max"
        policy.webSearchBackend = "gpt-5.6-sol"
        release.resolve()
        const reply = await pending

        assert.deepEqual(failures, [])
        assert.deepEqual(payload, original)
        assert.equal(seen.length, 3)
        assert.ok(reply.content.some((block) => block.type === "server_tool_use"))
        assert.ok(reply.content.some((block) => block.type === "web_search_tool_result"))
        assert.equal(reply.usage.server_tool_use?.web_search_requests, 1)

        // The next request switches model and picks up the effort changed above.
        messages.push({ role: "assistant", content: reply.content }, { role: "user", content: "Continue without another search." })
        turn = 1
        const next = { ...payload, model: selector(other(first)) }
        const countBefore = seen.length

        await assertCount(app, next, other(first))
        assert.equal(seen.length, countBefore)

        await readReply(await post(app, next), stream)

        assert.deepEqual(failures, [])
        assert.equal(seen.length, 4)

        const history = wireTurns(seen.at(-1)!)
        assert.ok(history.some((item) => item.text?.includes("answer-11")))
        assert.ok(history.some((item) => item.text?.includes("reason-11")))
        // Preserve existing translated replay: final answer text, not native
        // bridge blocks or provider-signed search markers.
        assert.equal(history.flatMap((item) => item.calls ?? []).length, 0)
      })
    })
  }
}

for (const stream of [false, true]) {
  test(`admitted turn keeps model and fallback effort across reload, stream=${stream}`, async () => {
    runtimeState.modelRouting = { opusModel: opus, gptModel: gpt }
    runtimeState.thinkEffort = "low"
    const app = createServer(config())

    const entered = barrier()
    const release = barrier()
    const failures: unknown[] = []
    let calls = 0

    await withRecordedTransport({
      refresh: async () => assert.fail("no refresh expected"),
      fetch: async (request) => {
        try {
          const index = calls++
          const body = validateWire(request, index === 0 ? opus : "claude-sonnet-4.6", index === 0 ? "low" : "high", 256)
          if (index === 0) {
            entered.resolve()
            await release.promise
          }

          return upstreamReply(body, index)
        } catch (error) {
          failures.push(error)
          entered.resolve()
          throw error
        }
      },
    }, async () => {
      const payload: ClaudeMessagesPayload = { model: "opus", max_tokens: 256, stream, messages: [{ role: "user", content: "First." }] }

      const pending = post(app, payload).then((response) => readReply(response, stream))
      await Promise.race([entered.promise, pending.then(() => assert.fail("request finished before the upstream barrier"))])

      // Reload routing and the fallback effort while the first request is parked upstream:
      // it must finish with the model and effort it was admitted with.
      runtimeState.modelRouting = { opusModel: "claude-sonnet-4.6", gptModel: "gpt-5.6-sol" }
      runtimeState.thinkEffort = "high"
      release.resolve()
      const first = await pending

      assert.equal(first.model, opus)

      const next = await readReply(await post(app, {
        ...payload,
        messages: [
          ...payload.messages,
          { role: "assistant", content: first.content },
          { role: "user", content: "Next." },
        ]
      }), stream)

      assert.equal(next.model, "claude-sonnet-4.6", "resolved non-Opus target must not route again")
      assert.equal(calls, 2)
      assert.deepEqual(failures, [])
    })
  })
}

for (const model of [opus, gpt]) {
  for (const stream of [false, true]) {
    test(`switch with malformed effort still rejects before upstream, model=${model}, stream=${stream}`, async () => {
      const app = createServer(config())
      let calls = 0

      await withRecordedTransport({
        fetch: async () => {
          calls++
          throw new Error("unexpected upstream")
        },
        refresh: async () => {}
      }, async () => {
        const response = await post(app, {
          model: selector(model),
          max_tokens: 256,
          stream,
          output_config: { effort: "invalid" as "high" },
          messages: [
            { role: "user", content: "First." },
            { role: "assistant", content: "Earlier model answered." },
            { role: "system", content: [], output_config: { effort: "high" } },
            { role: "user", content: "Continue." }
          ],
        })

        assert.equal(response.status, 400)
        assert.match(response.headers.get("content-type") ?? "", /application\/json/)
        assert.equal((await response.json() as { error: { type: string } }).error.type, "invalid_request_error")
      })

      assert.equal(calls, 0)
    })

    test(`upstream unsupported effort stays an error after switching, model=${model}, stream=${stream}`, async () => {
      const app = createServer(config())
      let calls = 0
      const failures: unknown[] = []

      await withRecordedTransport({
        refresh: async () => assert.fail("not an auth failure"),
        fetch: async (request) => {
          try {
            validateWire(request, model, "max", 256)
            calls++
            return Response.json({ error: { code: "unsupported_value", message: "Fixture effort unsupported." } }, { status: 400 })
          } catch (error) {
            failures.push(error)
            throw error
          }
        },
      }, async () => {
        const response = await post(app, {
          model: selector(model),
          max_tokens: 256,
          stream,
          output_config: { effort: "max" },
          messages: [
            { role: "user", content: "First." },
            { role: "assistant", content: "Earlier model answered." },
            { role: "user", content: "Continue." }
          ]
        })

        if (stream) {
          assert.equal(response.status, 200)
          const text = await response.text()
          assert.match(text, /event: error/)
          assert.doesNotMatch(text, /event: message_stop/)
        } else {
          assert.equal(response.status, 400)
          assert.equal((await response.json() as { error: { code: string } }).error.code, "unsupported_value")
        }
      })

      assert.deepEqual(failures, [])
      assert.equal(calls, 1, "do not retry using another model or effort")
    })
  }
}
