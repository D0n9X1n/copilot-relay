import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { encode } from "gpt-tokenizer/encoding/o200k_base"

import type { ChatCompletionsPayload, ContentPart, ToolCall } from "../../src/copilot/types"
import { refuseExternalConnections } from "../fixtures/network"

const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay-image-tokens-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { getTokenCount } = await import("../../src/lib/tokenizer")

test.after(async () => {
  await fs.rm(tempHome, { recursive: true, force: true })
})

const fetch = test.mock.method(globalThis, "fetch", () => {
  assert.fail("Token estimation must not fetch image data or URLs")
})

// The relay's own network calls go through undici's dispatcher rather than fetch (#153), so a
// socket to any other host throws as well.
const restoreConnections = refuseExternalConnections()

// Also pin the count, in case the code under test swallows the mock's failure.
test.after(() => {
  assert.equal(fetch.mock.callCount(), 0)
  test.mock.restoreAll()
  restoreConnections()
})

const model = { id: "test-model", capabilities: { tokenizer: "o200k_base" } }
const image = (url: string): ContentPart => ({ type: "image_url", image_url: { url } })

test("small and multi-megabyte image data each add 4096 tokens to unchanged text counts", async () => {
  const text = "Describe the screenshot."
  const textPart: ContentPart = { type: "text", text }
  const baseline = { input: 7 + encode(text).length, output: 0 }

  for (const content of [text, [textPart]]) {
    assert.deepEqual(await getTokenCount({
      model: model.id,
      messages: [{ role: "user", content }],
    }, model), baseline)
  }

  for (const data of ["AQID", "AQID".repeat(1024 * 1024)]) {
    const result = await getTokenCount({
      model: model.id,
      messages: [{ role: "user", content: [textPart, image(`data:image/png;base64,${data}`)] }],
    }, model)

    assert.deepEqual(result, { input: baseline.input + 4096, output: 0 })
  }
})

test("multiple images add independently without changing text, tool definitions, or tool calls", async () => {
  const prompt = "Describe the screenshots."
  const answer = "Inspecting the screenshots."
  const toolCall: ToolCall = {
    id: "call_image",
    type: "function",
    function: { name: "Inspect", arguments: "{}" },
  }
  const payload: ChatCompletionsPayload = {
    model: model.id,
    messages: [
      { role: "user", content: [{ type: "text", text: prompt }] },
      { role: "assistant", content: [{ type: "text", text: answer }], tool_calls: [toolCall] },
    ],
    tools: [{ type: "function", function: { name: "Inspect", parameters: { type: "object" } } }],
  }

  const baseline = await getTokenCount(payload, model)
  assert.deepEqual(baseline, {
    input: 7 + encode(prompt).length + 7 + encode("Inspect:").length + encode("type:object").length + 12,
    output: 7 + encode(answer).length + 7 + encode(JSON.stringify(toolCall)).length + 12,
  })

  const result = await getTokenCount({
    ...payload,
    messages: payload.messages.map((message) => ({
      ...message,
      content: [
        ...(message.content as Array<ContentPart>),
        image("https://example.invalid/screenshot.png"),
        ...(message.role === "user" ? [image("data:image/png;base64,AQID")] : []),
      ],
    })),
  }, model)

  // Two images on the user message, one on the assistant's.
  assert.deepEqual(result, { input: baseline.input + 2 * 4096, output: baseline.output + 4096 })
})

test("estimates an image without reading its URL or encoded payload", async () => {
  const unreadableImage: ContentPart = {
    type: "image_url",
    image_url: {
      get url(): string {
        return assert.fail("Token estimation must not read image data or URLs")
      },
    },
  }

  assert.deepEqual(await getTokenCount({
    model: model.id,
    messages: [{ role: "user", content: [unreadableImage] }],
  }, model), { input: 7 + 4096, output: 0 })
})
