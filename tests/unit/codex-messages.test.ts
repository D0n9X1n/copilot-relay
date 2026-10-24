import assert from "node:assert/strict"
import test from "node:test"

import {
  collectCodexResponse,
  CodexToolNames,
  decodeThinking,
  toClaudeRequest,
  toCodexEvents,
} from "../../src/codex/messages"
import type { NativeEvent } from "../../src/copilot/native"

type JsonRecord = Record<string, any>

const opus = { supportedEndpoints: ["/v1/messages"], reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], limits: { max_output_tokens: 64_000, max_prompt_tokens: 1_000_000, max_context_window_tokens: 1_000_000 } }

const userText = (text: string) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] })

const applyPatch = { type: "custom", name: "apply_patch", description: "Edit files.", format: { type: "grammar", syntax: "lark", definition: "start: x" } }
const execCommand = { type: "function", name: "exec_command", description: "Run a command.", strict: false, parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } }

async function* fromArray(events: Array<NativeEvent>): AsyncGenerator<NativeEvent> {
  for (const event of events) {
    yield event
  }
}

const collect = async (events: AsyncIterable<JsonRecord>): Promise<Array<JsonRecord>> => {
  const all: Array<JsonRecord> = []
  for await (const event of events) {
    all.push(event)
  }

  return all
}

test("toClaudeRequest puts instructions and leading developer messages in system and keeps later ones in place", () => {
  const { payload } = toClaudeRequest({
    model: "claude-opus-5.5",
    instructions: "You are Codex.",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Sandbox: workspace-write" }] },
      userText("Hello"),
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Mode changed" }] },
      userText("Continue"),
    ],
  }, "claude-opus-5.5", opus)

  const body = payload as unknown as JsonRecord
  assert.deepEqual(body.system.map((block: JsonRecord) => block.text), ["You are Codex.", "Sandbox: workspace-write"])
  assert.deepEqual(body.messages.map((turn: JsonRecord) => turn.role), ["user", "assistant", "user"])
  assert.deepEqual(body.messages[2].content.map((block: JsonRecord) => block.text), ["Mode changed", "Continue"])
  assert.equal(body.stream, true)
  assert.equal(body.max_tokens, 64_000)
})

test("toClaudeRequest turns function and custom tools into Claude tools and drops hosted ones", () => {
  const { payload, dropped } = toClaudeRequest({
    model: "claude-opus-5.5",
    input: [userText("Go")],
    tools: [execCommand, applyPatch, { type: "web_search" }, { type: "namespace", name: "mcp__fs", description: "", tools: [{ ...execCommand, name: "read.file" }] }],
  }, "claude-opus-5.5", opus)

  const tools = (payload as unknown as JsonRecord).tools
  assert.deepEqual(tools.map((tool: JsonRecord) => tool.name), ["exec_command", "apply_patch", "mcp__fs__read_file"])
  assert.deepEqual(tools[0].input_schema, execCommand.parameters)
  assert.deepEqual(tools[1].input_schema.required, ["input"])
  assert.match(tools[1].description, /start: x/)
  assert.deepEqual(dropped, ["tool:web_search"])
})

test("toClaudeRequest replays calls, outputs and the relay's thinking, and drops foreign reasoning", () => {
  const thinking = { type: "thinking", thinking: "plan", signature: "sig-1" }
  const encoded = `copilot-relay.claude-thinking.v1:${Buffer.from(JSON.stringify(thinking)).toString("base64url")}`
  const { payload, dropped } = toClaudeRequest({
    model: "claude-opus-5.5",
    tools: [execCommand, applyPatch],
    input: [
      userText("Fix it"),
      { type: "reasoning", summary: [], encrypted_content: encoded },
      { type: "reasoning", summary: [], encrypted_content: "gAAAA-openai" },
      { type: "function_call", call_id: "call_1", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" },
      { type: "custom_tool_call", call_id: "call_2", name: "apply_patch", input: "*** Begin Patch" },
      { type: "function_call_output", call_id: "call_1", output: "a.txt" },
      { type: "custom_tool_call_output", call_id: "call_2", output: "" },
    ],
  }, "claude-opus-5.5", opus)

  const turns = (payload as unknown as JsonRecord).messages
  assert.deepEqual(turns[1].content.map((block: JsonRecord) => block.type), ["thinking", "tool_use", "tool_use"])
  assert.deepEqual(turns[1].content[0], thinking)
  assert.deepEqual(turns[1].content[1].input, { cmd: "ls" })
  assert.deepEqual(turns[1].content[2].input, { input: "*** Begin Patch" })
  assert.equal(turns[2].content[0].tool_use_id, "call_1")
  assert.deepEqual(turns[2].content[1].content, [{ type: "text", text: "(no output)" }])
  assert.deepEqual(turns[2].content[1].cache_control, { type: "ephemeral" })
  assert.deepEqual(dropped, ["reasoning"])
})

test("toClaudeRequest places at most four cache breakpoints, never on thinking", () => {
  const { payload } = toClaudeRequest({
    model: "claude-opus-5.5",
    instructions: "sys",
    tools: [execCommand],
    input: [userText("one"), { type: "message", role: "assistant", content: [{ type: "output_text", text: "two" }] }, userText("three")],
  }, "claude-opus-5.5", opus)

  const marked = JSON.stringify(payload).match(/cache_control/g) ?? []
  const body = payload as unknown as JsonRecord
  assert.equal(marked.length, 4)
  assert.deepEqual(body.system.at(-1).cache_control, { type: "ephemeral" })
  assert.deepEqual(body.tools.at(-1).cache_control, { type: "ephemeral" })
  assert.deepEqual(body.messages[2].content.at(-1).cache_control, { type: "ephemeral" })
  assert.deepEqual(body.messages[0].content.at(-1).cache_control, { type: "ephemeral" })
})

test("toClaudeRequest clamps the effort to Claude's levels and sends adaptive thinking", () => {
  const ultra = toClaudeRequest({ model: "m", input: "hi", reasoning: { effort: "ultra" } }, "claude-opus-5.5", opus)
  const none = toClaudeRequest({ model: "m", input: "hi", reasoning: { effort: "none" } }, "claude-opus-5.5", opus)
  const unset = toClaudeRequest({ model: "m", input: "hi" }, "claude-opus-5.5", opus)

  assert.equal(ultra.effectiveEffort, "max")
  assert.deepEqual((ultra.payload as unknown as JsonRecord).thinking, { type: "adaptive" })
  assert.deepEqual((ultra.payload as unknown as JsonRecord).output_config, { effort: "max" })
  assert.equal(none.effectiveEffort, "low")
  assert.equal((unset.payload as unknown as JsonRecord).thinking, undefined)
})

test("toClaudeRequest maps tool_choice and parallel_tool_calls", () => {
  const required = toClaudeRequest({ model: "m", input: "hi", tools: [execCommand], tool_choice: "required", parallel_tool_calls: false }, "claude-opus-5.5", opus)
  const auto = toClaudeRequest({ model: "m", input: "hi", tools: [execCommand], tool_choice: "auto", parallel_tool_calls: true }, "claude-opus-5.5", opus)

  assert.deepEqual((required.payload as unknown as JsonRecord).tool_choice, { type: "any", disable_parallel_tool_use: true })
  assert.deepEqual((auto.payload as unknown as JsonRecord).tool_choice, { type: "auto" })
})

test("CodexToolNames gives sanitized unique names and maps them back", () => {
  const names = new CodexToolNames()
  const first = names.claudeName({ kind: "function", name: "a.b" })
  const second = names.claudeName({ kind: "function", name: "a_b" })

  assert.equal(first, "a_b")
  assert.equal(second, "a_b_2")
  assert.deepEqual(names.target("a_b"), { kind: "function", name: "a.b" })
  assert.equal(names.claudeName({ kind: "function", name: "a.b" }), "a_b")
  assert.deepEqual(names.target("unknown"), { kind: "function", name: "unknown" })
})

const nativeStream: Array<NativeEvent> = [
  { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 5, output_tokens: 1 } } as never },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me look." } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-9" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Patching." } },
  { type: "content_block_stop", index: 1 },
  { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "apply_patch", input: {} } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"input\":\"*** Begin" } },
  { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: " Patch\"}" } },
  { type: "content_block_stop", index: 2 },
  { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_2", name: "mcp__fs__read_file", input: {} } },
  { type: "content_block_delta", index: 3, delta: { type: "input_json_delta", partial_json: "{\"cmd\":\"x\"}" } },
  { type: "content_block_stop", index: 3 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } },
  { type: "message_stop" },
]

const toolNames = () => {
  const names = new CodexToolNames()
  names.claudeName({ kind: "custom", name: "apply_patch" })
  names.claudeName({ kind: "function", name: "read.file", namespace: "mcp__fs" })
  return names
}

test("toCodexEvents turns a Claude stream into the Responses events Codex reads", async () => {
  const events = await collect(toCodexEvents(fromArray(nativeStream), "claude-opus-5.5", toolNames()))
  const types = events.map((event) => event.type)

  assert.equal(types[0], "response.created")
  assert.equal(types.at(-1), "response.completed")
  assert.ok(types.includes("response.output_text.delta"))
  assert.ok(types.includes("response.reasoning_summary_text.delta"))
  assert.ok(types.includes("response.function_call_arguments.done"))

  const done = events.filter((event) => event.type === "response.output_item.done").map((event) => event.item)
  assert.deepEqual(done.map((item) => item.type), ["reasoning", "message", "custom_tool_call", "function_call"])
  assert.deepEqual(decodeThinking(done[0].encrypted_content), { type: "thinking", thinking: "Let me look.", signature: "sig-9" })
  assert.deepEqual(done[0].summary, [{ type: "summary_text", text: "Let me look." }])
  assert.equal(done[1].content[0].text, "Patching.")
  assert.deepEqual([done[2].call_id, done[2].name, done[2].input], ["toolu_1", "apply_patch", "*** Begin Patch"])
  assert.deepEqual([done[3].name, done[3].namespace, done[3].arguments], ["read.file", "mcp__fs", "{\"cmd\":\"x\"}"])

  const response = events.at(-1)!.response
  assert.equal(response.id, "resp_msg_1")
  assert.equal(response.output.length, 4)
  assert.deepEqual(response.usage, {
    input_tokens: 105,
    input_tokens_details: { cached_tokens: 90 },
    output_tokens: 40,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 145,
  })
})

test("toCodexEvents reports max_tokens as response.incomplete and a broken stream as response.failed", async () => {
  const truncated = await collect(toCodexEvents(fromArray([
    nativeStream[0]!,
    { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]), "claude-opus-5.5", new CodexToolNames()))
  assert.equal(truncated.at(-1)!.type, "response.incomplete")
  assert.deepEqual(truncated.at(-1)!.response.incomplete_details, { reason: "max_output_tokens" })

  const broken = await collect(toCodexEvents(fromArray(nativeStream.slice(0, 4)), "claude-opus-5.5", new CodexToolNames()))
  assert.equal(broken.at(-1)!.type, "response.failed")
  assert.equal(broken.at(-1)!.response.error.code, "server_error")
})

test("collectCodexResponse returns the final response", async () => {
  const final = await collectCodexResponse(toCodexEvents(fromArray(nativeStream), "claude-opus-5.5", toolNames())) as JsonRecord

  assert.equal(final.status, "completed")
  assert.equal(final.output.length, 4)
})

test("decodeThinking accepts only the relay's own blocks", () => {
  assert.equal(decodeThinking("gAAAA"), undefined)
  assert.equal(decodeThinking(undefined), undefined)
  assert.equal(decodeThinking("copilot-relay.claude-thinking.v1:not-json"), undefined)
})
