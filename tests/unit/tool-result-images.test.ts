import assert from "node:assert/strict"
import test from "node:test"

import { moveToolImagesToUserMessages } from "../../src/copilot/chat"
import { buildResponsesRequestPayload } from "../../src/copilot/responses"
import type { ChatCompletionsPayload, ContentPart, Message, ToolCall } from "../../src/copilot/types"

const pngA = "data:image/png;base64,AAAA"
const pngB = "data:image/png;base64,BBBB"
const pngC = "data:image/png;base64,CCCC"

const text = (value: string): ContentPart => ({ type: "text", text: value })
const image = (url: string): ContentPart => ({ type: "image_url", image_url: { url } })
const readCall = (id: string): ToolCall => ({ id, type: "function", function: { name: "Read", arguments: "{}" } })

// The function_call_output item that a /responses request carries for one tool result, as sent.
const responsesToolOutput = (content: Message["content"]) => {
  const payload = buildResponsesRequestPayload({
    model: "gpt-6-astra",
    messages: [
      { role: "user", content: "Read the screenshot." },
      { role: "assistant", content: null, tool_calls: [readCall("call_1")] },
      { role: "tool", tool_call_id: "call_1", content },
    ],
  }, undefined)

  return JSON.parse(JSON.stringify(payload)).input.at(-1)
}

test("/responses sends an image-only tool result as an input_image item", () => {
  assert.deepEqual(responsesToolOutput([image(pngA)]), {
    type: "function_call_output",
    call_id: "call_1",
    output: [{ type: "input_image", image_url: pngA, detail: "auto" }],
  })
})

test("/responses keeps the text and images of a tool result in their original order", () => {
  const output = responsesToolOutput([text("Loaded a.png."), image(pngA), text("Loaded b.png."), image(pngB)]).output

  assert.deepEqual(output, [
    { type: "input_text", text: "Loaded a.png." },
    { type: "input_image", image_url: pngA, detail: "auto" },
    { type: "input_text", text: "Loaded b.png." },
    { type: "input_image", image_url: pngB, detail: "auto" },
  ])
})

test("/responses keeps the plain output string for a tool result without images", () => {
  // The same bytes as before, so an existing history keeps its prompt-cache prefix.
  assert.equal(
    JSON.stringify(responsesToolOutput("Loaded notes.txt.")),
    '{"type":"function_call_output","call_id":"call_1","output":"Loaded notes.txt."}',
  )
  assert.equal(responsesToolOutput([text("Part one."), text("Part two.")]).output, "Part one.\n\nPart two.")
  assert.equal(responsesToolOutput(null).output, "")
})

const chatPayload = (messages: Array<Message>, model = "gpt-5-mini"): ChatCompletionsPayload => ({ model, messages })
const label = (id: string): ContentPart => text(`Image output of tool call ${id}:`)
const note = "Image output follows in the next user message."

test("a tool image at the end of the conversation moves to a new user message", () => {
  const payload = chatPayload([
    { role: "user", content: "Read the screenshot." },
    { role: "assistant", content: null, tool_calls: [readCall("call_1")] },
    { role: "tool", tool_call_id: "call_1", content: [image(pngA)] },
  ])
  const original = structuredClone(payload)

  assert.deepEqual(moveToolImagesToUserMessages(payload).messages, [
    { role: "user", content: "Read the screenshot." },
    { role: "assistant", content: null, tool_calls: [readCall("call_1")] },
    { role: "tool", tool_call_id: "call_1", content: note },
    { role: "user", content: [label("call_1"), image(pngA)] },
  ])
  // The adapter returns a copy and leaves the caller's payload as it was.
  assert.deepEqual(payload, original)
})

test("only the tool messages of a run that hold images give them up, in call order", () => {
  const calls = [readCall("call_1"), readCall("call_2"), readCall("call_3")]
  const payload = chatPayload([
    { role: "user", content: "Compare the screenshots." },
    { role: "assistant", content: null, tool_calls: calls },
    { role: "tool", tool_call_id: "call_1", content: [text("Loaded a.png."), image(pngA)] },
    { role: "tool", tool_call_id: "call_2", content: "notes.txt holds no image." },
    { role: "tool", tool_call_id: "call_3", content: [text("Loaded b.png."), text("2 of 2."), image(pngB), image(pngC)] },
    { role: "assistant", content: "Both screenshots show the dialog." },
  ])

  assert.deepEqual(moveToolImagesToUserMessages(payload).messages, [
    { role: "user", content: "Compare the screenshots." },
    { role: "assistant", content: null, tool_calls: calls },
    { role: "tool", tool_call_id: "call_1", content: "Loaded a.png." },
    { role: "tool", tool_call_id: "call_2", content: "notes.txt holds no image." },
    { role: "tool", tool_call_id: "call_3", content: "Loaded b.png.\n\n2 of 2." },
    { role: "user", content: [label("call_1"), image(pngA), label("call_3"), image(pngB), image(pngC)] },
    { role: "assistant", content: "Both screenshots show the dialog." },
  ])
})

test("images move ahead of the content of the user message that follows the run", () => {
  const payload = chatPayload([
    { role: "user", content: "Read the first screenshot." },
    { role: "assistant", content: null, tool_calls: [readCall("call_1")] },
    { role: "tool", tool_call_id: "call_1", content: [image(pngA)] },
    { role: "user", content: "Now read the second." },
    { role: "assistant", content: null, tool_calls: [readCall("call_2")] },
    { role: "tool", tool_call_id: "call_2", content: [text("Loaded b.png."), image(pngB)] },
    { role: "user", content: [text("Compare it with this one."), image(pngC)] },
  ])

  assert.deepEqual(moveToolImagesToUserMessages(payload).messages, [
    { role: "user", content: "Read the first screenshot." },
    { role: "assistant", content: null, tool_calls: [readCall("call_1")] },
    { role: "tool", tool_call_id: "call_1", content: note },
    { role: "user", content: [label("call_1"), image(pngA), text("Now read the second.")] },
    { role: "assistant", content: null, tool_calls: [readCall("call_2")] },
    { role: "tool", tool_call_id: "call_2", content: "Loaded b.png." },
    { role: "user", content: [label("call_2"), image(pngB), text("Compare it with this one."), image(pngC)] },
  ])
})

test("a payload without tool-result images comes back unchanged", () => {
  const textOnly = chatPayload([
    { role: "user", content: "Read the notes." },
    { role: "assistant", content: null, tool_calls: [readCall("call_1")] },
    { role: "tool", tool_call_id: "call_1", content: "The notes hold no image." },
  ])
  // An image in a user turn is not a tool result, and stays where it is.
  const userImage = chatPayload([{ role: "user", content: [text("Describe this."), image(pngA)] }])

  assert.equal(moveToolImagesToUserMessages(textOnly), textOnly)
  assert.equal(moveToolImagesToUserMessages(userImage), userImage)
})

test("a Claude upstream model keeps tool-result images inside the tool message", () => {
  const payload = chatPayload([
    { role: "user", content: "Read the screenshot." },
    { role: "assistant", content: null, tool_calls: [readCall("call_1")] },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: [text("Loaded a.png."), image(pngA)],
      copilot_cache_control: { type: "ephemeral" },
    },
  ], "claude-opus-5.5")

  assert.equal(moveToolImagesToUserMessages(payload), payload)
})
