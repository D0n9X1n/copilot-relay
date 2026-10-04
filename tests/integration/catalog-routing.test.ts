import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import type { ClaudeMessagesPayload } from "../../src/claude/types"
import type { CopilotModel } from "../../src/copilot/models"
import type { ProxyConfig } from "../../src/lib/config"
import type { RecordedRequest } from "../../src/lib/request-trace"

// src/ resolves its paths from the home directory at import time, so redirect it before importing.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-catalog-routing-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { createServer } = await import("../../src/server")
const { createChatCompletions } = await import("../../src/copilot/chat")
const { validateUpstream } = await import("../../src/lib/preflight")
const { runtimeState } = await import("../../src/lib/state")
const { withRecordedTransport } = await import("../../src/lib/request-trace")
const { flushLogs, log } = await import("../../src/lib/log")

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

test.afterEach(() => {
  delete runtimeState.modelRouting
  delete runtimeState.thinkEffort
  delete runtimeState.modelCatalog
  delete runtimeState.upstreamBaseUrl
})

// Chat models that routing by name once skipped as "Unsupported route"; each must now follow the
// endpoints its catalog entry advertises. The endpoint combinations are synthetic capabilities,
// not a live catalog snapshot.
const skippedModels = [
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "grok-4.5",
  "grok-4.6",
  "grok-4.7",
  "mai-code-1.1-flash",
  "future-chat-model",
]

const baseUrl = "https://catalog-routing.invalid"

const configFor = (id: string, capabilities: CopilotModel): ProxyConfig => ({
  host: "localhost",
  port: 0,
  copilotBaseUrl: baseUrl,
  copilotToken: "fixture-only",
  vsCodeVersion: "test",
  upstreamTimeoutMs: 2000,
  modelCatalog: { baseUrl, models: new Map([[id, capabilities]]) },
})

const post = (config: ProxyConfig, payload: Partial<ClaudeMessagesPayload> = {}) =>
  createServer(config).fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "sonnet",
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply OK." }],
      ...payload,
    }),
  }))

const sse = (values: unknown[], done = false) => new Response(
  values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""),
  { headers: { "content-type": "text/event-stream" } },
)

const reply = (request: RecordedRequest): Response => {
  const body = JSON.parse(request.body!)

  if (request.path === "/responses") {
    const response = {
      id: "resp_catalog",
      model: body.model,
      created_at: 1,
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }

    if (body.stream) {
      return sse([
        { type: "response.created", response: { ...response, output: [] } },
        { type: "response.output_text.delta", output_index: 0, delta: "OK" },
        { type: "response.completed", response },
      ])
    }

    return Response.json(response)
  }

  if (request.path === "/v1/messages") {
    return Response.json({
      id: "msg_catalog",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  }

  if (body.stream) {
    return sse([{
      id: "chat_catalog",
      model: body.model,
      created: 1,
      choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
    }], true)
  }

  return Response.json({
    id: "chat_catalog",
    model: body.model,
    created: 1,
    choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

const assertReply = async (response: Response, id: string, stream: boolean) => {
  assert.equal(response.status, 200, await response.clone().text())

  if (stream) {
    const text = await response.text()

    assert.match(text, /event: message_stop/)
    assert.match(text, /"stop_reason":"end_turn"/)
    assert.doesNotMatch(text, /event: error/)
    assert.match(text, new RegExp(`"model":"${id.replaceAll(".", "\\.")}"`))
  } else {
    const body = await response.json() as { model: string; stop_reason: string }

    assert.equal(body.model, id)
    assert.equal(body.stop_reason, "end_turn")
  }
}

for (const id of skippedModels) {
  for (const endpoint of ["/chat/completions", "/responses"] as const) {
    for (const stream of [false, true]) {
      test(`${id} uses its advertised ${endpoint} for ${stream ? "SSE" : "JSON"}`, async () => {
        runtimeState.modelRouting = { gptModel: id, opusModel: "claude-unused" }

        const config = configFor(id, {
          type: "chat",
          supportedEndpoints: [endpoint],
          reasoningEfforts: ["low"],
        })
        const sent: RecordedRequest[] = []

        await withRecordedTransport(
          {
            fetch: async (request) => {
              sent.push(request)
              assert.equal(request.path, endpoint)

              const body = JSON.parse(request.body!)
              assert.equal(body.model, id)
              // Responses nests the effort under `reasoning`; Chat Completions sends it top-level.
              assert.equal(
                endpoint === "/responses" ? body.reasoning?.effort : body.reasoning_effort,
                "low",
              )

              return reply(request)
            },
            refresh: async () => {
              throw new Error("Unexpected refresh")
            },
          },
          async () => {
            const response = await post(config, { stream, output_config: { effort: "low" } })
            await assertReply(response, id, stream)
          },
        )

        assert.equal(sent.length, 1)
      })
    }

    test(`${id} preflight agrees with advertised ${endpoint}`, async () => {
      runtimeState.modelRouting = { gptModel: id, opusModel: "claude-fixture" }

      // The preflight argument, not the process-wide default, is the effort under test.
      runtimeState.thinkEffort = "max"

      const config = configFor(id, {})
      const sent: RecordedRequest[] = []

      await withRecordedTransport(
        {
          fetch: async (request) => {
            if (request.path === "/models") {
              return Response.json({ data: [
                {
                  id,
                  supported_endpoints: [endpoint],
                  capabilities: { type: "chat", supports: { reasoning_effort: ["low"] } },
                },
                { id: "claude-fixture", supported_endpoints: ["/chat/completions"] },
              ] })
            }

            sent.push(request)
            return reply(request)
          },
          refresh: async () => {
            throw new Error("Unexpected refresh")
          },
        },
        () => validateUpstream(config, "low"),
      )

      const sentSummary = sent.map((request) => {
        const body = JSON.parse(request.body!)
        return [request.path, body.model, body.reasoning?.effort ?? body.reasoning_effort]
      })

      assert.deepEqual(sentSummary, [
        [endpoint, id, "low"],
        ["/chat/completions", "claude-fixture", "low"],
      ])
    })
  }
}

for (const endpoint of ["/chat/completions", "/responses", "/v1/messages"] as const) {
  test(`explicit no-effort capability omits the implicit default on ${endpoint}`, async () => {
    const id = endpoint === "/v1/messages" ? "claude-plain" : "plain-chat"
    const config = {
      ...configFor(id, { supportedEndpoints: [endpoint], reasoningEfforts: [] }),
      claudeUpstreamApi: "auto" as const,
    }
    let requestCount = 0

    runtimeState.modelRouting = { gptModel: id, opusModel: id }
    runtimeState.thinkEffort = "max"

    await withRecordedTransport(
      {
        fetch: async (request) => {
          requestCount++
          assert.equal(request.path, endpoint)

          const body = JSON.parse(request.body!)
          assert.equal(body.reasoning_effort, undefined)
          assert.equal(body.reasoning, undefined)
          assert.equal(body.output_config?.effort, undefined)

          return reply(request)
        },
        refresh: async () => {},
      },
      async () => {
        await assertReply(await post(config), id, false)
      },
    )

    assert.equal(requestCount, 1)
  })

  for (const effort of ["low", "none"] as const) {
    for (const stream of [false, true]) {
      test(`explicit ${effort} is rejected before ${endpoint} inference or SSE for a no-effort model`, async () => {
        const id = endpoint === "/v1/messages" ? "claude-plain" : "plain-chat"
        const config = {
          ...configFor(id, { supportedEndpoints: [endpoint], reasoningEfforts: [] }),
          claudeUpstreamApi: "auto" as const,
        }
        let requestCount = 0

        runtimeState.modelRouting = { gptModel: id, opusModel: id }

        await withRecordedTransport(
          {
            fetch: async (request) => {
              requestCount++
              return reply(request)
            },
            refresh: async () => {},
          },
          async () => {
            const response = await post(config, { stream, output_config: { effort } })

            assert.equal(response.status, 400)
            // A JSON body, not an SSE error event: the rejection comes before any stream opens.
            assert.match(response.headers.get("content-type") ?? "", /application\/json/)
            assert.match(await response.text(), /relay_unsupported_effort/)
          },
        )

        assert.equal(requestCount, 0)
      })
    }
  }
}

// Both protocols must omit the configured default for a no-effort model and say so. Copilot also
// signals no effort support by leaving reasoning_effort out of supports.
const noEffortPreflightCases = [
  { id: "plain-chat", endpoint: "/chat/completions", claudeUpstreamApi: undefined, supports: { reasoning_effort: false } },
  { id: "claude-plain", endpoint: "/v1/messages", claudeUpstreamApi: "auto", supports: { reasoning_effort: false } },
  { id: "legacy-chat", endpoint: "/chat/completions", claudeUpstreamApi: undefined, supports: { streaming: true, tool_calls: true } },
] as const

for (const { id, endpoint, claudeUpstreamApi, supports } of noEffortPreflightCases) {
  test(`preflight sends no effort to no-effort model ${id} on ${endpoint} and logs it as omitted`, async (t) => {
    const config = { ...configFor(id, {}), claudeUpstreamApi }
    const infoLines: string[] = []
    let rejectTarget = false

    runtimeState.modelRouting = { gptModel: id, opusModel: "claude-fixture" }
    runtimeState.thinkEffort = "max"
    t.mock.method(log, "info", (message: unknown) => {
      infoLines.push(String(message))
    })

    await withRecordedTransport(
      {
        fetch: async (request) => {
          if (request.path === "/models") {
            return Response.json({ data: [
              {
                id,
                supported_endpoints: [endpoint],
                capabilities: { type: "chat", supports },
              },
              { id: "claude-fixture", supported_endpoints: ["/chat/completions"] },
            ] })
          }

          const body = JSON.parse(request.body!)

          if (body.model === id) {
            // Neither protocol may carry an effort field the model does not accept.
            assert.equal(request.path, endpoint)
            assert.equal(body.reasoning_effort, undefined)
            assert.equal(body.reasoning, undefined)
            assert.equal(body.output_config, undefined)

            if (rejectTarget) {
              return Response.json({ error: { message: "fixture rejection" } }, { status: 400 })
            }
          }

          return reply(request)
        },
        refresh: async () => {},
      },
      async () => {
        await validateUpstream(config, "low")

        // A failure must name the effort actually sent, not the configured default.
        rejectTarget = true
        await assert.rejects(
          validateUpstream(config, "low"),
          new RegExp(`Preflight failed for model=${id} think_effort=omitted: 400`),
        )
      },
    )

    // Both the preflight summary and the per-request model line report the omission.
    assert(infoLines.some((line) => line.includes(`Preflight OK: model=${id} think_effort=omitted`)))
    assert(infoLines.some(
      (line) => line.includes(`upstream_model=${id}`) && line.includes("effective_think_effort=omitted"),
    ))
    assert(!infoLines.some((line) => line.includes("effective_think_effort=unset")))
  })
}

test("an admitted missing-model snapshot is not rediscovered after SSE opens", async () => {
  const id = "future-chat-model"
  const config = configFor("previous-model", {})
  const paths: string[] = []

  runtimeState.modelRouting = { gptModel: id, opusModel: id }

  await withRecordedTransport(
    {
      fetch: async (request) => {
        paths.push(request.path)

        if (request.path === "/models") {
          return Response.json({ data: [{ id: "previous-model" }] })
        }

        return reply(request)
      },
      refresh: async () => {},
    },
    async () => {
      await assertReply(await post(config, { stream: true }), id, true)
    },
  )

  assert.deepEqual(paths, ["/models", "/chat/completions"])
})

// Token recovery retries inside the transport after admission has chosen the route, so
// a refresh must replay the identical request. grok-4.6 sits outside the legacy Responses
// family: re-deriving its route from the name would send the Responses case to Chat.
for (const endpoint of ["/chat/completions", "/responses"] as const) {
  for (const stream of [false, true]) {
    test(`token refresh replays the catalog-selected ${endpoint} request for ${stream ? "SSE" : "JSON"}`, async () => {
      const id = "grok-4.6"
      runtimeState.modelRouting = { gptModel: id, opusModel: "claude-unused" }

      // Recovery only runs when a refresher is configured; the recorded transport
      // then performs the refresh in its place, so this one must never be called.
      const config: ProxyConfig = {
        ...configFor(id, { type: "chat", supportedEndpoints: [endpoint], reasoningEfforts: ["low"] }),
        refreshCopilotToken: async () => {
          throw new Error("Recorded refresh was bypassed")
        },
      }
      const sent: RecordedRequest[] = []
      let refreshes = 0

      await withRecordedTransport(
        {
          fetch: async (request) => {
            sent.push(request)

            // Reject the first attempt as an expired token and accept the replay.
            if (sent.length === 1) {
              return new Response("unauthorized", { status: 401 })
            }

            return reply(request)
          },
          refresh: async () => {
            refreshes++
          },
        },
        async () => {
          const response = await post(config, { stream, output_config: { effort: "low" } })
          await assertReply(response, id, stream)
        },
      )

      // One refresh, then the same endpoint with a byte-identical body: no catalog
      // rediscovery, no route re-selection and the same resolved effort.
      assert.equal(refreshes, 1)
      assert.deepEqual(sent.map((request) => request.path), [endpoint, endpoint])
      assert.equal(sent[1]?.body, sent[0]?.body)
    })
  }
}

test("provider reload cannot change an admitted Responses search final pass", async () => {
  const id = "future-chat-model"
  const config = configFor(id, {
    supportedEndpoints: ["/responses"],
    reasoningEfforts: ["low"],
    limits: {
      max_context_window_tokens: 1000,
      max_prompt_tokens: 900,
      max_output_tokens: 64,
    },
  })
  config.webSearchBackend = id

  runtimeState.modelRouting = { gptModel: id, opusModel: id }
  runtimeState.thinkEffort = "low"

  const app = createServer(config)
  const sent: Array<{ path: string; body: Record<string, any> }> = []

  await withRecordedTransport(
    {
      fetch: async (request) => {
        const body = JSON.parse(request.body!)
        sent.push({ path: request.path, body })

        if (sent.length === 1) {
          // Reload after admission, while the decision stream still owns the old snapshot.
          config.copilotBaseUrl = "https://new-provider.invalid"
          config.modelCatalog = {
            baseUrl: config.copilotBaseUrl,
            models: new Map([[id, {
              supportedEndpoints: ["/chat/completions"],
              reasoningEfforts: [],
            }]]),
          }
          runtimeState.thinkEffort = "high"
          runtimeState.modelRouting = { gptModel: "other-model", opusModel: "other-model" }

          return sse([
            { type: "response.created", response: { id: "resp_search_decision", model: id, output: [] } },
            {
              type: "response.completed",
              response: {
                id: "resp_search_decision",
                model: id,
                status: "completed",
                output: [{
                  type: "function_call",
                  id: "fc_search",
                  call_id: "call_search",
                  name: "WebSearch",
                  arguments: '{"query":"fixture"}',
                }],
              },
            },
          ])
        }

        if (body.tools?.some((tool: { type: string }) => tool.type === "web_search_preview")) {
          return Response.json({
            id: "resp_retrieval",
            model: id,
            status: "completed",
            output: [
              { type: "web_search_call", status: "completed", action: { query: "fixture" } },
              { type: "message", content: [{ type: "output_text", text: "Source https://example.com/reference" }] },
            ],
          })
        }

        return reply(request)
      },
      refresh: async () => {},
    },
    async () => {
      const response = await app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "sonnet",
          stream: true,
          max_tokens: 128,
          messages: [{ role: "user", content: "Find a reference" }],
          tools: [{
            name: "WebSearch",
            input_schema: { type: "object", properties: { query: { type: "string" } } },
          }],
        }),
      }))

      await assertReply(response, id, true)
    },
  )

  // The decision, retrieval and final passes all keep the admitted route, model and effort.
  assert.equal(sent.length, 3)

  for (const request of sent) {
    assert.equal(request.path, "/responses")
    assert.equal(request.body.model, id)
    assert.equal(request.body.reasoning.effort, "low")
  }

  assert.equal(sent[0].body.max_output_tokens, 64)
  assert.equal(sent[2].body.max_output_tokens, 64)
  assert.equal(config.copilotBaseUrl, "https://new-provider.invalid")
})

const fallbackEndpointCases = [
  undefined,
  ["/chat/completions"],
  ["/chat/completions", "/responses"],
]

for (const mode of [undefined, "chat-completions", "auto"] as const) {
  for (const endpoints of fallbackEndpointCases) {
    for (const isClaude of [false, true]) {
      test(`unsupported-api recovery respects ${isClaude ? "Claude" : "other"} ${mode ?? "default"} ${JSON.stringify(endpoints)}`, async () => {
        const id = isClaude ? "claude-fixture" : "future-chat-model"
        const config = {
          ...configFor(id, { supportedEndpoints: endpoints }),
          claudeUpstreamApi: mode,
        }
        const sent: RecordedRequest[] = []
        const errorBytes = new TextEncoder().encode(JSON.stringify({
          error: { code: "unsupported_api_for_model" },
        }))
        let cancelled = false

        runtimeState.modelRouting = { gptModel: id, opusModel: id }

        await withRecordedTransport(
          {
            fetch: async (request) => {
              sent.push(request)

              if (request.path === "/responses") {
                return reply(request)
              }

              const response = new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(errorBytes)
                  },
                  cancel() {
                    cancelled = true
                  },
                }),
                { status: 400, headers: { "content-type": "application/json" } },
              )

              // Isolate cancellation from tee behavior; real HTTP capture/replay tests cover tees.
              Object.defineProperty(response, "clone", {
                value: () => new Response(errorBytes, { status: 400, headers: response.headers }),
              })

              return response
            },
            refresh: async () => {},
          },
          async () => {
            const allowsFallback = (!isClaude || mode === "auto")
              && (endpoints === undefined || endpoints.includes("/responses"))
            const run = () => createChatCompletions(config, {
              model: id,
              max_tokens: 16,
              messages: [{ role: "user", content: "fixture" }],
            })

            if (allowsFallback) {
              const result = await run()

              assert("choices" in result)
              assert.equal(result.choices[0]?.message.content, "OK")
              // The error body never closes; falling back must cancel it, not leave it open.
              assert.equal(cancelled, true)
            } else {
              await assert.rejects(run(), error => error instanceof Error && "response" in error)
            }

            const expectedPaths = allowsFallback
              ? ["/chat/completions", "/responses"]
              : ["/chat/completions"]

            assert.deepEqual(sent.map((request) => request.path), expectedPaths)
          },
        )
      })
    }
  }
}

for (const outcome of ["http-400", "refusal", "partial-stream"]) {
  test(`${outcome} never triggers protocol fallback`, async () => {
    const id = "future-chat-model"
    const config = configFor(id, { supportedEndpoints: ["/responses", "/chat/completions"] })
    const paths: string[] = []

    runtimeState.modelRouting = { gptModel: id, opusModel: id }

    await withRecordedTransport(
      {
        fetch: async (request) => {
          paths.push(request.path)

          if (outcome === "http-400") {
            return Response.json({ error: { code: "invalid_parameter" } }, { status: 400 })
          }

          if (outcome === "partial-stream") {
            return sse([{
              id: "partial",
              model: id,
              choices: [{ index: 0, delta: { content: "Partial" }, finish_reason: null }],
            }])
          }

          return Response.json({
            id: "refused",
            model: id,
            choices: [{
              index: 0,
              message: { role: "assistant", content: "Refused" },
              finish_reason: "content_filter",
            }],
          })
        },
        refresh: async () => {},
      },
      async () => {
        const response = await post(config, { stream: outcome === "partial-stream" })
        const body = await response.text()

        if (outcome === "http-400") {
          assert.equal(response.status, 400)
        } else if (outcome === "refusal") {
          assert.match(body, /"stop_reason":"refusal"/)
        } else {
          assert.match(body, /event: error/)
          assert.doesNotMatch(body, /event: message_stop/)
        }
      },
    )

    assert.deepEqual(paths, ["/chat/completions"])
  })
}

// Native forwards every control, so any effort control is rejected. Translated history
// rejects clear_at as an unsupported control first, and a pending translated marker
// does not yet request effort for this turn.
const expectedControlRejection = (native: boolean, position: string): RegExp | undefined => {
  if (native || position === "active") {
    return /relay_unsupported_effort/
  }

  return position === "clear-at" ? /Translated system controls/ : undefined
}

for (const position of ["active", "pending", "clear-at"] as const) {
  for (const native of [false, true]) {
    test(`${native ? "native" : "translated"} no-effort controls remain explicit at ${position}`, async () => {
      const id = native ? "claude-plain" : "plain-chat"
      const config = {
        ...configFor(id, {
          supportedEndpoints: [native ? "/v1/messages" : "/chat/completions"],
          reasoningEfforts: [],
        }),
        claudeUpstreamApi: "auto" as const,
      }
      const control = {
        role: "system" as const,
        content: [],
        output_config: { effort: "low" as const },
        ...(position === "clear-at" && { clear_at: "next_user_message" as const }),
      }
      const user = { role: "user" as const, content: "Fixture" }
      const messages = position === "pending" ? [user, control] : [control, user]
      const rejection = expectedControlRejection(native, position)
      let requestCount = 0

      runtimeState.modelRouting = { gptModel: id, opusModel: id }

      await withRecordedTransport(
        {
          fetch: async (request) => {
            requestCount++
            return reply(request)
          },
          refresh: async () => {},
        },
        async () => {
          const response = await post(config, { messages, stream: true })
          const text = await response.text()

          assert.equal(response.status, rejection ? 400 : 200)

          if (rejection) {
            assert.match(text, rejection)
          } else {
            assert.match(text, /event: message_stop/)
          }
        },
      )

      assert.equal(requestCount, rejection ? 0 : 1)
    })
  }
}

test("catalog Responses preserves cache key and prefix across appended turns and effort changes", async () => {
  const id = "grok-4.7"
  const config = configFor(id, {
    supportedEndpoints: ["/responses"],
    reasoningEfforts: ["low", "high"],
  })
  const sent: Array<Record<string, any>> = []
  const firstHistory = [{ role: "user" as const, content: "First turn" }]
  const appendedHistory = [
    ...firstHistory,
    { role: "assistant" as const, content: "OK" },
    { role: "user" as const, content: "Next turn" },
  ]

  runtimeState.modelRouting = { gptModel: id, opusModel: id }

  await withRecordedTransport(
    {
      fetch: async (request) => {
        sent.push(JSON.parse(request.body!))
        return reply(request)
      },
      refresh: async () => {},
    },
    async () => {
      for (const [messages, effort] of [[firstHistory, "low"], [appendedHistory, "high"]] as const) {
        const response = await post(config, {
          messages,
          output_config: { effort },
          metadata: { user_id: "fixture-session" },
          system: "Stable prefix",
        })

        await assertReply(response, id, false)
      }
    },
  )

  assert.equal(sent[0].prompt_cache_key, sent[1].prompt_cache_key)
  assert.match(sent[0].prompt_cache_key, /^cr-/)
  assert.deepEqual(sent[1].input.slice(0, sent[0].input.length), sent[0].input)
  assert.equal(sent[0].reasoning.effort, "low")
  assert.equal(sent[1].reasoning.effort, "high")
})

for (const stream of [false, true]) {
  test(`a Chat-pinned Claude model without Chat reports a policy conflict before ${stream ? "SSE" : "JSON"}`, async () => {
    const id = "claude-responses-only"
    const config = configFor(id, { supportedEndpoints: ["/responses"] })
    let requestCount = 0

    runtimeState.modelRouting = { gptModel: id, opusModel: id }

    await withRecordedTransport(
      {
        fetch: async (request) => {
          requestCount++
          return reply(request)
        },
        refresh: async () => {},
      },
      async () => {
        const response = await post(config, { stream })
        const body = await response.text()

        assert.equal(response.status, 400)
        assert.match(response.headers.get("content-type") ?? "", /application\/json/)
        assert.match(body, /relay_unsupported_endpoint/)
        assert.match(body, /protocol-policy-conflict/)
      },
    )

    assert.equal(requestCount, 0)
  })
}

const incompatibleModels = [
  [{ supportedEndpoints: [] }, "no-advertised-endpoint"],
  [{ supportedEndpoints: ["/future/private-endpoint"] }, "unsupported-relay-endpoint"],
  [{ supportedEndpoints: ["/v1/messages"] }, "unsupported-relay-endpoint"],
  [{ type: "embeddings", supportedEndpoints: ["/responses"] }, "unsupported-model-type"],
] as const

for (const [capabilities, reason] of incompatibleModels) {
  for (const stream of [false, true]) {
    test(`incompatible model ${reason} fails locally before ${stream ? "SSE" : "JSON"}`, async () => {
      const id = "incompatible-model"
      const config = configFor(id, {
        ...capabilities,
        // The `as const` case list is readonly; the catalog entry takes a mutable copy.
        supportedEndpoints: [...capabilities.supportedEndpoints],
      })
      let requestCount = 0

      runtimeState.modelRouting = { gptModel: id, opusModel: id }

      await withRecordedTransport(
        {
          fetch: async (request) => {
            requestCount++
            return reply(request)
          },
          refresh: async () => {},
        },
        async () => {
          const response = await post(config, { stream })

          assert.equal(response.status, 400)
          assert.match(await response.text(), new RegExp(reason))
        },
      )

      assert.equal(requestCount, 0)
    })
  }
}
