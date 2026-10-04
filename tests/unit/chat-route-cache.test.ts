import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-chat-cache-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { translateToOpenAI } = await import("../../src/claude/translate")
const { buildResponsesRequestPayload } = await import("../../src/copilot/responses")
const { runtimeState } = await import("../../src/lib/state")
const { createServer: createRelay } = await import("../../src/server")
const { withRecordedTransport } = await import("../../src/lib/request-trace")
const { flushLogs, withoutConsoleLogging } = await import("../../src/lib/log")
type ClaudeMessagesPayload = import("../../src/claude/types").ClaudeMessagesPayload
type Message = import("../../src/copilot/types").Message

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

test.afterEach(() => {
  delete runtimeState.modelRouting
  delete runtimeState.modelCatalog
})

const chatRoute = { endpoint: "/chat/completions" } as const
const reminder = (text: string): Message => ({ role: "user", content: `<system-reminder>\n${text}\n</system-reminder>` })

// Claude Code sends cache_control on content blocks; the Claude types do not declare it.
const claudeCode = (payload: object): ClaudeMessagesPayload => payload as ClaudeMessagesPayload

const unmarked = (message: Message): Message => {
  const copy = { ...message }
  delete copy.copilot_cache_control
  return copy
}

// The request shape Claude Code 2.1.288 sent through the relay, without its text: two
// system blocks with breakpoints and, on every request, a token reminder as the last
// message holding the newest breakpoint. Earlier reminders are replayed as plain strings.
const tokenReminder = (turn: number): string => `<total_tokens>${1000 - turn} tokens left</total_tokens>`

const claudeCodeTurn = (turns: number): ClaudeMessagesPayload => {
  const messages: object[] = [{ role: "user", content: [{ type: "text", text: "Read the fixtures." }] }]
  for (let turn = 1; turn <= turns; turn++) {
    if (turn > 1) {
      messages.push({ role: "assistant", content: [{ type: "tool_use", id: `toolu_${turn}`, name: "Read", input: { file_path: `/fixture-${turn}` } }] })
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${turn}`, content: `Fixture ${turn}.` }] })
    }

    if (turn === turns) {
      messages.push({ role: "system", content: [{ type: "text", text: tokenReminder(turn), cache_control: { type: "ephemeral" } }] })
    } else {
      messages.push({ role: "system", content: tokenReminder(turn) })
    }
  }

  return claudeCode({
    model: "opus",
    max_tokens: 64,
    system: [
      { type: "text", text: "Static instructions.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Session context.", cache_control: { type: "ephemeral" } },
    ],
    tools: [{ name: "Read", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }],
    messages,
  })
}

test("Claude chat route sends mid-conversation system turns as in-place reminder turns", () => {
  const payload: ClaudeMessagesPayload = {
    model: "opus",
    max_tokens: 32,
    system: "Stable prompt.",
    messages: [
      { role: "user", content: "Hi" },
      { role: "system", content: "Operator note." },
      { role: "assistant", content: "Hello" },
      { role: "system", content: [{ type: "text", text: "Part one." }, { type: "text", text: "Part two." }] },
    ],
  }

  const translated = translateToOpenAI(payload, undefined, undefined, chatRoute)

  assert.equal(translated.model, "claude-opus-5.5")
  assert.deepEqual(translated.messages, [
    { role: "system", content: "Stable prompt." },
    { role: "user", content: "Hi" },
    reminder("Operator note."),
    { role: "assistant", content: "Hello" },
    reminder("Part one.\n\nPart two."),
  ])
})

test("system turns keep the system role off the Claude chat route", () => {
  const messages: ClaudeMessagesPayload["messages"] = [
    { role: "user", content: "Hi" },
    { role: "system", content: "Operator note." },
  ]
  const expected = [{ role: "user", content: "Hi" }, { role: "system", content: "Operator note." }]

  // GPT on either translated endpoint, and Claude when the chat endpoint is not selected.
  for (const [model, options] of [
    ["gpt-6-astra", chatRoute],
    ["gpt-6-astra", { endpoint: "/responses" }],
    ["opus", {}],
    ["opus", { endpoint: "/responses" }],
  ] as const) {
    assert.deepEqual(translateToOpenAI({ model, max_tokens: 32, messages }, undefined, undefined, options).messages, expected)
  }

  // The decision uses the resolved upstream model, not the requested alias.
  runtimeState.modelRouting = { opusModel: "gpt-4.1", gptModel: "gpt-4.1" }
  const routed = translateToOpenAI({ model: "claude-opus-5.5", max_tokens: 32, messages }, undefined, undefined, chatRoute)
  assert.equal(routed.model, "gpt-4.1")
  assert.deepEqual(routed.messages, expected)
})

test("cache breakpoints become copilot_cache_control only on the Claude chat route", () => {
  const payload = claudeCode({
    model: "opus",
    max_tokens: 32,
    system: [
      { type: "text", text: "Static prompt.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Session prompt.", cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "Read the fixture." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/fixture" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "Fixture.", cache_control: { type: "ephemeral" } }] },
    ],
  })
  const original = structuredClone(payload)

  const translated = translateToOpenAI(payload, undefined, undefined, chatRoute)

  assert.deepEqual(translated.messages.map((message) => message.role), ["system", "user", "assistant", "tool"])
  assert.deepEqual(translated.messages.map((message) => message.copilot_cache_control), [{ type: "ephemeral" }, undefined, undefined, { type: "ephemeral" }])
  assert.deepEqual(payload, original)

  for (const [model, options] of [["opus", {}], ["gpt-6-astra", chatRoute]] as const) {
    const other = translateToOpenAI({ ...payload, model }, undefined, undefined, options)
    assert.ok(other.messages.every((message) => message.copilot_cache_control === undefined))
  }
})

test("a breakpoint on a turn that translates to nothing marks the previous message", () => {
  const translated = translateToOpenAI(claudeCode({
    model: "opus",
    max_tokens: 32,
    output_config: { effort: "low" },
    messages: [
      { role: "user", content: "Hi" },
      { role: "system", content: [{ type: "text", text: "", cache_control: { type: "ephemeral" } }], output_config: { effort: "high" } },
      { role: "user", content: "Continue" },
    ],
  }), undefined, undefined, chatRoute)

  assert.equal(translated.reasoning_effort, "high")
  assert.deepEqual(translated.messages, [
    { role: "user", content: "Hi", copilot_cache_control: { type: "ephemeral" } },
    { role: "user", content: "Continue" },
  ])
})

test("a breakpoint marks the translated message that holds its block", () => {
  const mark = { type: "ephemeral" } as const
  const toolUse = (id: string) => ({ type: "tool_use", id, name: "Read", input: { file_path: `/${id}` } })
  const result = (id: string, marked = false) => ({ type: "tool_result", tool_use_id: id, content: `Result ${id}.`, ...(marked && { cache_control: mark }) })
  const note = (marked = false) => ({ type: "text", text: "Note.", ...(marked && { cache_control: mark }) })

  // handleUserMessage emits one tool message per result, then one user message for the rest.
  const cases: Array<[Array<object>, Array<typeof mark | undefined>]> = [
    [[result("a", true), result("b"), note()], [mark, undefined, undefined]],
    [[result("a"), result("b", true), note()], [undefined, mark, undefined]],
    [[result("a"), result("b"), note(true)], [undefined, undefined, mark]],
    [[result("a", true), result("b", true)], [mark, mark]],
    [[result("a", true), result("b")], [mark, undefined]],
  ]

  for (const [content, expected] of cases) {
    const translated = translateToOpenAI(claudeCode({
      model: "opus",
      max_tokens: 32,
      messages: [
        { role: "user", content: "Read both." },
        { role: "assistant", content: [toolUse("a"), toolUse("b")] },
        { role: "user", content },
      ],
    }), undefined, undefined, chatRoute)
    const trailing = translated.messages.slice(2)

    assert.deepEqual(trailing.map((message) => message.role), ["tool", "tool", "user"].slice(0, expected.length))
    assert.deepEqual(trailing.map((message) => message.copilot_cache_control), expected)
  }
})

test("a null system prompt adds no system message on the Claude chat route", () => {
  // Outside the declared type, but a client may send an absent field as null.
  const translated = translateToOpenAI(claudeCode({
    model: "opus",
    max_tokens: 32,
    system: null,
    messages: [{ role: "user", content: "Hi" }],
  }), undefined, undefined, chatRoute)

  assert.deepEqual(translated.messages, [{ role: "user", content: "Hi" }])
})

test("an empty system turn adds no reminder on the Claude chat route", () => {
  const translated = translateToOpenAI({
    model: "opus",
    max_tokens: 32,
    messages: [{ role: "user", content: "Hi" }, { role: "system", content: "  " }, { role: "user", content: "Continue" }],
  }, undefined, undefined, chatRoute)

  assert.deepEqual(translated.messages, [{ role: "user", content: "Hi" }, { role: "user", content: "Continue" }])
})

test("a text-bearing effort switch still sets effort when its text becomes a reminder", () => {
  const translated = translateToOpenAI({
    model: "opus",
    max_tokens: 32,
    output_config: { effort: "low" },
    messages: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "system", content: [{ type: "text", text: "Review carefully." }], output_config: { effort: "high" } },
      { role: "user", content: "Continue" },
    ],
  }, undefined, undefined, chatRoute)

  assert.equal(translated.reasoning_effort, "high")
  assert.deepEqual(translated.messages, [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello" },
    reminder("Review carefully."),
    { role: "user", content: "Continue" },
  ])
})

test("Claude Code-shaped turns translate to an append-only prefix with no later system turn", () => {
  let previous: Message[] | undefined
  for (let turns = 1; turns <= 4; turns++) {
    const messages = translateToOpenAI(claudeCodeTurn(turns), undefined, undefined, chatRoute).messages

    assert.deepEqual(messages.slice(1).filter((message) => message.role === "system"), [])
    assert.deepEqual(messages[0]?.copilot_cache_control, { type: "ephemeral" })
    assert.deepEqual(messages.at(-1), { ...reminder(tokenReminder(turns)), copilot_cache_control: { type: "ephemeral" } })
    if (previous) {
      assert.deepEqual(messages.slice(0, previous.length).map(unmarked), previous.map(unmarked))
    }

    previous = messages
  }
})

test("the Responses payload carries no copilot_cache_control", () => {
  const translated = translateToOpenAI(claudeCodeTurn(2), undefined, undefined, chatRoute)
  assert.ok(translated.messages.some((message) => message.copilot_cache_control !== undefined))

  const responses = buildResponsesRequestPayload(translated, "low")

  assert.equal(JSON.stringify(responses).includes("copilot_cache_control"), false)
})

test("the relay sends Claude Code turns upstream as an append-only, cache-marked chat prefix", async () => {
  const sent: Array<{ path: string; messages: Message[] }> = []
  const usages: Array<{ input_tokens?: number; cache_read_input_tokens?: number }> = []

  await withRecordedTransport({
    fetch: async (request) => {
      sent.push({ path: request.path, messages: JSON.parse(request.body ?? "{}").messages })
      return Response.json({
        id: "chat_fixture",
        model: "claude-opus-5.5",
        created: 1,
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 1, total_tokens: 1001, prompt_tokens_details: { cached_tokens: 900 } },
      })
    },
    refresh: async () => {},
  }, async () => {
    const app = createRelay({ host: "localhost", port: 0, copilotBaseUrl: "https://fixture.invalid", copilotToken: "fixture", vsCodeVersion: "test", upstreamTimeoutMs: 1000, claudeUpstreamApi: "chat-completions" })
    for (const turns of [1, 2]) {
      const response = await app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(claudeCodeTurn(turns)),
      }))
      assert.equal(response.status, 200)
      const body = await response.json() as { usage: { input_tokens?: number; cache_read_input_tokens?: number } }
      usages.push(body.usage)
    }
  })

  assert.equal(sent.length, 2)
  for (const request of sent) {
    assert.ok(request.path.endsWith("/chat/completions"))
    assert.deepEqual(request.messages.slice(1).filter((message) => message.role === "system"), [])
    assert.deepEqual(request.messages.at(-1)?.copilot_cache_control, { type: "ephemeral" })
  }

  const [first, second] = sent
  assert.ok(first && second)
  assert.deepEqual(second.messages.slice(0, first.messages.length).map(unmarked), first.messages.map(unmarked))

  // Chat usage keeps cached input in cache_read_input_tokens and the rest in input_tokens.
  assert.deepEqual(usages.map((usage) => [usage.input_tokens, usage.cache_read_input_tokens]), [[100, 900], [100, 900]])
})

// In auto mode a Claude model with no native Messages endpoint goes to /chat/completions.
// createChatCompletions retries an unsupported_api_for_model failure on /responses with the
// same translated payload unless the catalog rules /responses out, so only then is the
// history adapted for the chat route.
const autoModeCases: Array<[string[] | undefined, boolean]> = [
  [undefined, false],
  [["/chat/completions", "/responses"], false],
  [["/chat/completions"], true],
]

for (const [supportedEndpoints, adapted] of autoModeCases) {
  test(`auto mode with catalog endpoints ${String(supportedEndpoints)} ${adapted ? "adapts" : "keeps"} Claude chat history`, async () => {
    const sent: Array<{ path: string; body: Record<string, unknown> }> = []
    let status = 0

    await withRecordedTransport({
      fetch: async (request) => {
        sent.push({ path: request.path, body: JSON.parse(request.body ?? "{}") })

        if (request.path.endsWith("/responses")) {
          return Response.json({
            id: "resp_fixture",
            model: "claude-opus-5.5",
            created_at: 1,
            status: "completed",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          })
        }

        // Copilot refuses the chat endpoint for this model.
        return Response.json({ error: { code: "unsupported_api_for_model" } }, { status: 400 })
      },
      refresh: async () => {},
    }, async () => {
      const app = createRelay({
        host: "localhost",
        port: 0,
        copilotBaseUrl: "https://fixture.invalid",
        copilotToken: "fixture",
        vsCodeVersion: "test",
        upstreamTimeoutMs: 1000,
        claudeUpstreamApi: "auto",
        modelCatalog: { baseUrl: "https://fixture.invalid", models: new Map([["claude-opus-5.5", { supportedEndpoints }]]) },
      })
      const response = await withoutConsoleLogging(() => app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(claudeCode({
          model: "opus",
          max_tokens: 32,
          messages: [
            { role: "user", content: "Hi" },
            { role: "system", content: [{ type: "text", text: "Operator note.", cache_control: { type: "ephemeral" } }] },
          ],
        })),
      })))
      await response.text()
      status = response.status
    })

    const [chat, retry] = sent
    // Copilot rejects a chat request that ends on a non-user turn, so the shared chat layer
    // appends a user turn after a trailing system turn. The adapted reminder already is one.
    const expectedChat = adapted
      ? [{ role: "user", content: "Hi" }, { ...reminder("Operator note."), copilot_cache_control: { type: "ephemeral" } }]
      : [{ role: "user", content: "Hi" }, { role: "system", content: "Operator note." }, { role: "user", content: "Continue based on the context above." }]

    assert.ok(chat?.path.endsWith("/chat/completions"))
    assert.deepEqual(chat.body.messages, expectedChat)

    if (adapted) {
      // No retry is possible, so the adapted history never reaches /responses.
      assert.equal(sent.length, 1)
      assert.equal(status, 400)
    } else {
      assert.equal(sent.length, 2)
      assert.equal(status, 200)
      assert.ok(retry?.path.endsWith("/responses"))

      const input = retry.body.input
      assert.ok(Array.isArray(input))
      assert.equal(input.at(-1)?.role, "system")
      assert.ok(JSON.stringify(input.at(-1)).includes("Operator note."))
      assert.equal(JSON.stringify(retry.body).includes("<system-reminder>"), false)
    }
  })
}

test("a retry keeps the initiator of the attempt it replaces", async () => {
  const initiators: Array<string | null> = []
  let lastPath = ""
  // A transient failure, an expired token, then Copilot refusing the chat endpoint for this model.
  const failures = [
    new Response("busy", { status: 503 }),
    new Response("unauthorized", { status: 401 }),
    Response.json({ error: { code: "unsupported_api_for_model" } }, { status: 400 }),
  ]

  await withRecordedTransport({
    fetch: async (request) => {
      initiators.push(new Headers(request.headers).get("x-initiator"))
      lastPath = request.path
      const failure = failures.shift()
      if (failure) {
        return failure
      }

      return Response.json({
        id: "resp_fixture",
        model: "claude-opus-5.5",
        created_at: 1,
        status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "OK" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      })
    },
    refresh: async () => {},
  }, async () => {
    const app = createRelay({
      host: "localhost",
      port: 0,
      copilotBaseUrl: "https://fixture.invalid",
      copilotToken: "fixture",
      vsCodeVersion: "test",
      upstreamTimeoutMs: 30_000,
      refreshCopilotToken: async () => {},
      claudeUpstreamApi: "auto",
      modelCatalog: { baseUrl: "https://fixture.invalid", models: new Map([["claude-opus-5.5", { supportedEndpoints: undefined }]]) },
    })
    const response = await withoutConsoleLogging(() => app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "opus",
        max_tokens: 32,
        messages: [
          { role: "user", content: "Fix the failing test." },
          { role: "assistant", content: "Fixed it." },
          { role: "user", content: "Now add a test." },
        ],
      }),
    })))
    await response.text()
    assert.equal(response.status, 200)
  })

  // The person's prompt stays "user" on the 5xx retry, the token-refresh retry and the /responses fallback.
  assert.deepEqual(initiators, ["user", "user", "user", "user"])
  assert.ok(lastPath.endsWith("/responses"))
})
