import assert from "node:assert/strict"
import test from "node:test"

import { foldClaudeToolChanges } from "../../src/claude/tool-changes"
import { validateClaudeMessages } from "../../src/claude/translate"
import type { ClaudeMessagesPayload } from "../../src/claude/types"

// Claude Code sends cache_control and defer_loading, which the Claude types do not declare.
const claudeCode = (payload: object): ClaudeMessagesPayload => payload as ClaudeMessagesPayload

const readTool = { name: "Read", description: "Read a file.", input_schema: { type: "object", properties: {} } }
const worktreeTool = { name: "EnterWorktree", description: "Create a git worktree.", input_schema: { type: "object", properties: { name: { type: "string" } } } }
const byValue = (definition: object) => ({ type: "tool_addition", tool: { type: "tool_definition", definition } })
const byReference = (name: string) => ({ type: "tool_addition", tool: { type: "tool_reference", name } })
const removal = (name: string) => ({ type: "tool_removal", tool: { type: "tool_reference", name } })

test("a payload with no tool defined by value is returned unchanged", () => {
  const payload = claudeCode({
    model: "claude-opus-5.5",
    max_tokens: 16,
    tools: [readTool, { ...worktreeTool, defer_loading: true }],
    messages: [
      { role: "user", content: "Hi" },
      { role: "system", content: [{ type: "text", text: "Now available." }, byReference("EnterWorktree")] },
      { role: "assistant", content: "OK" },
      { role: "user", content: "Again" },
      { role: "system", content: [removal("EnterWorktree")] },
    ],
  })

  assert.equal(foldClaudeToolChanges(payload), payload)
})

test("a tool defined by value joins tools[] and the messages stay as sent", () => {
  const messages = [
    { role: "user", content: "Hi" },
    { role: "system", content: [{ type: "text", text: "EnterWorktree is now available." }, byValue(worktreeTool)] },
  ]
  const payload = claudeCode({ model: "claude-opus-5.5", max_tokens: 16, tools: [readTool], messages })

  const folded = foldClaudeToolChanges(payload)

  assert.deepEqual(folded.tools, [readTool, worktreeTool])
  assert.equal(folded.messages, messages)
  // The caller's payload is not modified.
  assert.equal(payload.tools?.length, 1)
})

test("a tool defined by value needs no top-level tools[]", () => {
  const payload = claudeCode({
    model: "claude-opus-5.5",
    max_tokens: 16,
    messages: [
      { role: "user", content: "Hi" },
      { role: "system", content: [byValue(worktreeTool)] },
    ],
  })

  assert.deepEqual(foldClaudeToolChanges(payload).tools, [worktreeTool])
})

test("a later definition with the same name replaces the earlier one in place", () => {
  const payload = claudeCode({
    model: "claude-opus-5.5",
    max_tokens: 16,
    tools: [readTool],
    messages: [
      { role: "user", content: "Hi" },
      { role: "system", content: [byValue(worktreeTool)] },
      { role: "assistant", content: "OK" },
      { role: "user", content: "Again" },
      {
        role: "system",
        content: [
          byValue({ ...readTool, description: "Read a file, newer description." }),
          byValue({ ...worktreeTool, description: "Second." }),
        ],
      },
    ],
  })

  const folded = foldClaudeToolChanges(payload)

  assert.deepEqual(folded.tools?.map((tool) => [tool.name, tool.description]), [
    ["Read", "Read a file, newer description."],
    ["EnterWorktree", "Second."],
  ])
})

test("new tools are appended in the order they first appear", () => {
  const payload = claudeCode({
    model: "claude-opus-5.5",
    max_tokens: 16,
    tools: [readTool],
    messages: [
      { role: "user", content: "Hi" },
      { role: "system", content: [byValue({ ...readTool, name: "Zeta" }), byValue({ ...readTool, name: "Alpha" })] },
      { role: "assistant", content: "OK" },
      { role: "user", content: "Again" },
      { role: "system", content: [byValue({ ...readTool, name: "Mid" }), byValue({ ...readTool, name: "Zeta", description: "Later." })] },
    ],
  })

  assert.deepEqual(foldClaudeToolChanges(payload).tools?.map((tool) => [tool.name, tool.description]), [
    ["Read", "Read a file."],
    ["Zeta", "Later."],
    ["Alpha", "Read a file."],
    ["Mid", "Read a file."],
  ])
})

test("folding twice gives the same tools as folding once", () => {
  const payload = claudeCode({
    model: "claude-opus-5.5",
    max_tokens: 16,
    tools: [readTool],
    messages: [
      { role: "user", content: "Hi" },
      { role: "system", content: [byValue(worktreeTool)] },
    ],
  })

  const once = foldClaudeToolChanges(payload)

  assert.deepEqual(foldClaudeToolChanges(once).tools, once.tools)
})

test("validation accepts each tool-change shape Claude Code sends", () => {
  const clientSearch = byValue({ name: "WebSearch", description: "Search the web.", input_schema: { type: "object", properties: { query: { type: "string" } } } })
  for (const block of [byValue(worktreeTool), clientSearch, byReference("EnterWorktree"), removal("EnterWorktree")]) {
    for (const native of [false, true]) {
      assert.doesNotThrow(() => validateClaudeMessages(claudeCode({
        messages: [
          { role: "user", content: "Hi" },
          { role: "system", content: [{ type: "text", text: "Note." }, block] },
        ],
      }).messages, native))
    }
  }
})

test("validation accepts a tool change next to a native clear_at reminder", () => {
  assert.doesNotThrow(() => validateClaudeMessages(claudeCode({
    messages: [
      { role: "user", content: "Hi" },
      { role: "system", content: [{ type: "text", text: "Reminder." }], clear_at: "next_user_message" },
      { role: "system", content: [byValue(worktreeTool)] },
    ],
  }).messages, true))
})

const rejection = (block: object): string => {
  try {
    validateClaudeMessages(claudeCode({
      messages: [
        { role: "user", content: "Hi" },
        { role: "system", content: [{ type: "text", text: "Note." }, block] },
      ],
    }).messages, true)
  } catch (error) {
    return (error as Error).message
  }

  return "accepted"
}

test("validation rejects a malformed tool change and names its block type", () => {
  assert.match(rejection({ type: "tool_addition" }), /tool_addition/)
  assert.match(rejection({ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "X" } } }), /tool_addition/)
  assert.match(rejection({ type: "tool_addition", tool: { type: "tool_definition", definition: { input_schema: {} } } }), /tool_addition/)
  assert.match(rejection({ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "X", description: {}, input_schema: {} } } }), /tool_addition/)
  // A typed server tool, or any definition without its schema, cannot be defined in a message.
  assert.match(rejection({ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "X", type: "custom" } } }), /tool_addition/)
  assert.match(rejection({ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "X", type: "unknown_fixture" } } }), /tool_addition/)
  assert.match(rejection({ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "web_search", type: "web_search_20250305", max_uses: 1 } } }), /tool_addition/)
  assert.match(rejection({ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "web_search", type: "web_search_20250305", input_schema: {} } } }), /tool_addition/)
  // An explicit client type is a client tool.
  assert.equal(rejection({ type: "tool_addition", tool: { type: "tool_definition", definition: { ...worktreeTool, type: "custom" } } }), "accepted")
  assert.match(rejection({ type: "tool_addition", tool: { type: "tool_reference" } }), /tool_addition/)
  assert.match(rejection({ type: "tool_addition", tool: { type: "tool_other", name: "X" } }), /tool_addition/)
  assert.match(rejection({ type: "tool_removal", tool: { type: "tool_definition", definition: worktreeTool } }), /tool_removal/)
  assert.match(rejection({ type: "tool_removal", tool: { type: "tool_reference", name: 7 } }), /tool_removal/)
})

test("validation still rejects any other block in a system message, beside valid tool changes too", () => {
  assert.equal(rejection({ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }), "System message content must contain only text.")
  assert.equal(rejection({ type: "tool_use", id: "x", name: "Read", input: {} }), "System message content must contain only text.")
  assert.throws(() => validateClaudeMessages(claudeCode({
    messages: [
      { role: "user", content: "Hi" },
      { role: "system", content: [byValue(worktreeTool), { type: "image", source: {} }] },
    ],
  }).messages, true), /System message content must contain only text/)
})
