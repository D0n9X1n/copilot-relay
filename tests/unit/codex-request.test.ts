import assert from "node:assert/strict"
import test from "node:test"

import {
  clampReasoningEffort,
  contextOverflowStream,
  getCodexInitiator,
  includesImage,
  parseCodexPayload,
  prepareCodexPayload,
  resolveCodexModel,
} from "../../src/codex/request"
import { pinCopilotModelCatalog, type CopilotModel } from "../../src/copilot/models"
import type { ProxyConfig } from "../../src/lib/config"
import { HTTPError } from "../../src/lib/error"
import { runtimeState } from "../../src/lib/state"

const baseUrl = "https://codex-fixture.invalid"

const configWith = (models: Array<[string, CopilotModel]>): ProxyConfig => ({
  host: "localhost",
  port: 0,
  copilotBaseUrl: baseUrl,
  copilotToken: "fixture",
  vsCodeVersion: "test",
  upstreamTimeoutMs: 1000,
  modelCatalog: { baseUrl, models: new Map(models) },
})

const errorCode = async (pending: Promise<unknown> | (() => unknown)): Promise<string | undefined> => {
  try {
    await (typeof pending === "function" ? pending() : pending)
  } catch (error) {
    assert(error instanceof HTTPError)
    const body = await error.response.json() as { error: { code: string } }
    return body.error.code
  }

  return undefined
}

test.afterEach(() => {
  delete runtimeState.modelRouting
})

test("parseCodexPayload accepts a model with string or array input and refuses anything else", async () => {
  assert.deepEqual(parseCodexPayload('{"model":"gpt-6-astra","input":"hi"}'), { model: "gpt-6-astra", input: "hi" })
  assert.equal(parseCodexPayload('{"model":"gpt-6-astra","input":[]}').model, "gpt-6-astra")
  assert.equal(await errorCode(() => parseCodexPayload("{")), "invalid_json")
  assert.equal(await errorCode(() => parseCodexPayload('{"input":"hi"}')), "missing_model")
  assert.equal(await errorCode(() => parseCodexPayload('{"model":" ","input":"hi"}')), "missing_model")
  assert.equal(await errorCode(() => parseCodexPayload('{"model":"gpt-6-astra"}')), "missing_input")
})

test("clampReasoningEffort keeps an advertised level and lowers one the model does not take", () => {
  const astra = ["low", "medium", "high", "xhigh", "max"]

  assert.equal(clampReasoningEffort("high", astra), "high")
  assert.equal(clampReasoningEffort("ultra", astra), "max")
  assert.equal(clampReasoningEffort("none", astra), "low")
  assert.equal(clampReasoningEffort("minimal", ["none", "low"]), "none")
})

test("clampReasoningEffort uses Copilot's accepted levels when the catalog lists none", () => {
  assert.equal(clampReasoningEffort("ultra", undefined), "max")
  assert.equal(clampReasoningEffort("medium", undefined), "medium")
})

test("clampReasoningEffort removes the effort for a model that advertises no levels", () => {
  assert.equal(clampReasoningEffort("high", []), undefined)
})

test("clampReasoningEffort forwards a level it does not know", () => {
  assert.equal(clampReasoningEffort("turbo", ["low", "high"]), "turbo")
})

test("prepareCodexPayload removes only what Copilot rejects", () => {
  const custom = { type: "custom", name: "apply_patch", format: { type: "grammar", syntax: "lark", definition: "start: x" } }
  const payload = {
    model: "codex-auto-review",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "thread-1",
    client_metadata: { session_id: "s" },
    service_tier: "priority",
    reasoning: { effort: "ultra", summary: "auto" },
    tools: [custom, { type: "image_generation", output_format: "png" }, { type: "web_search" }],
  }

  const prepared = prepareCodexPayload(payload, "gpt-6-astra", { reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] })

  assert.deepEqual(prepared.removed, ["service_tier", "image_generation"])
  assert.equal(prepared.requestedEffort, "ultra")
  assert.equal(prepared.effectiveEffort, "max")
  assert.deepEqual(prepared.payload, {
    model: "gpt-6-astra",
    input: payload.input,
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "thread-1",
    client_metadata: { session_id: "s" },
    reasoning: { effort: "max", summary: "auto" },
    tools: [custom, { type: "web_search" }],
  })

  // The caller's object is left as it was.
  assert.equal(payload.service_tier, "priority")
  assert.equal(payload.reasoning.effort, "ultra")
})

test("prepareCodexPayload leaves a body Copilot accepts unchanged apart from the model", () => {
  const payload = { model: "gpt-6-astra", input: "hi", reasoning: { effort: "high" }, tools: [] }
  const prepared = prepareCodexPayload(payload, "gpt-6-astra", { reasoningEfforts: ["low", "high"] })

  assert.deepEqual(prepared.payload, payload)
  assert.deepEqual(prepared.removed, [])
})

test("prepareCodexPayload drops the effort for a model without effort levels and keeps the summary", () => {
  const prepared = prepareCodexPayload(
    { model: "m", input: "hi", reasoning: { effort: "high", summary: "auto" } },
    "m",
    { reasoningEfforts: [] },
  )

  assert.deepEqual(prepared.payload.reasoning, { summary: "auto" })
  assert.equal(prepared.effectiveEffort, undefined)
})

test("getCodexInitiator is user only when the last input item is a user message", () => {
  const user = { type: "message", role: "user", content: [] }
  const bareUser = { role: "user", content: "hi" }
  const toolOutput = { type: "function_call_output", call_id: "c", output: "ok" }
  const customOutput = { type: "custom_tool_call_output", call_id: "c", output: "ok" }

  assert.equal(getCodexInitiator("hi", undefined), "user")
  assert.equal(getCodexInitiator([user], undefined), "user")
  assert.equal(getCodexInitiator([bareUser], undefined), "user")
  assert.equal(getCodexInitiator([user, toolOutput], undefined), "agent")
  assert.equal(getCodexInitiator([user, customOutput], undefined), "agent")
  assert.equal(getCodexInitiator([user, { type: "reasoning", summary: [] }], undefined), "agent")
  assert.equal(getCodexInitiator([], undefined), "agent")
})

test("getCodexInitiator is agent for every Codex subagent", () => {
  const user = { type: "message", role: "user", content: [] }

  for (const subagent of ["review", "compact", "memory_consolidation", "collab_spawn"]) {
    assert.equal(getCodexInitiator([user], subagent), "agent", subagent)
  }
})

test("includesImage finds images in messages and in tool output", () => {
  const image = { type: "input_image", image_url: "data:image/png;base64,AA" }

  assert.equal(includesImage([{ type: "message", role: "user", content: [image] }]), true)
  assert.equal(includesImage([{ type: "function_call_output", call_id: "c", output: [image] }]), true)
  assert.equal(includesImage([{ type: "message", role: "user", content: [{ type: "input_text", text: "input_image" }] }]), false)
  assert.equal(includesImage("input_image"), false)
})

test("resolveCodexModel sends a listed GPT model as named to /responses", async () => {
  const config = configWith([["gpt-6-astra", { supportedEndpoints: ["/responses"], type: "chat" }]])

  assert.deepEqual(await resolveCodexModel(config, "gpt-6-astra"), { model: "gpt-6-astra", api: "responses" })
})

test("resolveCodexModel sends a listed Claude model with /v1/messages to the Messages translation", async () => {
  const config = configWith([["claude-opus-5.5", { supportedEndpoints: ["/v1/messages", "/chat/completions"], type: "chat" }]])

  assert.deepEqual(await resolveCodexModel(config, "claude-opus-5.5"), { model: "claude-opus-5.5", api: "messages" })
})

test("resolveCodexModel refuses unlisted Claude models and models without a usable endpoint", async () => {
  const config = configWith([
    ["claude-haiku-4.5", { supportedEndpoints: ["/chat/completions"], type: "chat" }],
    ["gpt-4o", { supportedEndpoints: ["/chat/completions"], type: "chat" }],
    ["text-embedding-3-small", { type: "embeddings" }],
  ])
  // A pinned catalog is not refreshed, so the unlisted name is decided without a network call.
  pinCopilotModelCatalog(config)

  assert.equal(await errorCode(resolveCodexModel(config, "claude-opus-9")), "relay_unsupported_model")
  assert.equal(await errorCode(resolveCodexModel(config, "claude-haiku-4.5")), "relay_unsupported_endpoint")
  assert.equal(await errorCode(resolveCodexModel(config, "gpt-4o")), "relay_unsupported_endpoint")
  assert.equal(await errorCode(resolveCodexModel(config, "text-embedding-3-small")), "relay_unsupported_endpoint")
})

test("resolveCodexModel forwards any non-Claude model when no catalog describes the upstream", async () => {
  const config: ProxyConfig = { ...configWith([]), modelCatalog: undefined }

  assert.deepEqual(await resolveCodexModel(config, "gpt-9-future"), { model: "gpt-9-future", api: "responses" })
})

test("contextOverflowStream is one response.failed event with code context_length_exceeded", () => {
  const text = contextOverflowStream("req-1", "prompt is too long: 9 tokens > 8 maximum")
  const [eventLine, dataLine, ...rest] = text.split("\n")

  assert.equal(eventLine, "event: response.failed")
  assert.deepEqual(rest, ["", ""])

  const event = JSON.parse(dataLine!.slice("data: ".length))
  assert.equal(event.type, "response.failed")
  assert.equal(event.response.id, "resp_relay_req-1")
  assert.equal(event.response.status, "failed")
  assert.deepEqual(event.response.error, { code: "context_length_exceeded", message: "prompt is too long: 9 tokens > 8 maximum" })
})

test("prepareCodexPayload removes the relay's Claude thinking and keeps GPT's reasoning", () => {
  const claudeThinking = `copilot-relay.claude-thinking.v1:${Buffer.from(JSON.stringify({ type: "thinking", thinking: "t", signature: "s" })).toString("base64url")}`
  const gptReasoning = { type: "reasoning", summary: [], encrypted_content: "gAAAA-openai" }
  const payload = {
    model: "gpt-6-astra",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "reasoning", summary: [], encrypted_content: claudeThinking },
      gptReasoning,
    ],
  }
  const prepared = prepareCodexPayload(payload, "gpt-6-astra", undefined)

  assert.deepEqual((prepared.payload.input as Array<unknown>).slice(1), [gptReasoning])
  assert.deepEqual(prepared.removed, ["claude_reasoning"])
})
