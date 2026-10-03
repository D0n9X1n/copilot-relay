import assert from "node:assert/strict"
import test from "node:test"

import { translateErrorToClaudeErrorEvent } from "../../src/claude/stream"
import { toPromptTooLongError } from "../../src/copilot/client"
import { HTTPError, PromptTooLongError } from "../../src/lib/error"

// #158: Copilot rejects a prompt over the model's max_prompt_tokens in its own wording. Claude
// Code 2.1.288 recognizes an overflow only by these phrases and reads both counts with this
// pattern, so the tests check the relay's message against the client's own checks.
const isClaudeCodeOverflow = (text: string): boolean => {
  const lower = text.toLowerCase()
  return lower.includes("prompt is too long") || lower.includes("input is too long for requested model")
}

const claudeCodeCounts = (text: string): Array<string> | undefined =>
  /prompt is too long[^0-9]*(\d+)\s*tokens?\s*>\s*(\d+)/i.exec(text)?.slice(1)

const copilotOverflow = (message?: string): string =>
  JSON.stringify({ error: { message, code: "model_max_prompt_tokens_exceeded" } })

const anthropicError = (type: string, message: string): string =>
  JSON.stringify({ type: "error", error: { type, message }, request_id: "req_fixture" })

const copilotMessage = "prompt token count of 131008 exceeds the limit of 128000"
const overflowMessage = "prompt is too long: 131008 tokens > 128000 maximum"

test("Copilot's prompt overflow becomes Anthropic's prompt-too-long error", async () => {
  const error = toPromptTooLongError(400, copilotOverflow(copilotMessage))

  assert.ok(error instanceof PromptTooLongError)
  assert.ok(error instanceof HTTPError)
  assert.equal(error.message, overflowMessage)
  // Copilot's own wording stays in the log detail; the client never sees it.
  assert.equal(error.detail, copilotMessage)
  assert.equal(error.response.status, 400)
  assert.match(error.response.headers.get("content-type") ?? "", /application\/json/)
  assert.deepEqual(await error.response.json(), {
    type: "error",
    error: { type: "invalid_request_error", message: overflowMessage },
  })

  // A caller's own detail wins over the upstream wording.
  assert.equal(toPromptTooLongError(400, copilotOverflow(copilotMessage), "caller detail")?.detail, "caller detail")
})

test("Claude Code reads both counts from every form the mapped error reaches it in", async () => {
  const error = toPromptTooLongError(400, copilotOverflow(copilotMessage))
  assert.ok(error)

  // Streaming: the route appends the relay request id, and Claude Code's SDK makes the error
  // event's whole JSON its message, because the event has no top-level message.
  const event = translateErrorToClaudeErrorEvent(error)
  assert.ok(event.type === "error")
  event.error.message += " (request_id=3b241101-e2bb-4255-8caf-4136c566a962)"

  // Non-streaming: the SDK prefixes the status to the JSON body for the same reason.
  const body = await error.response.text()

  for (const text of [error.message, event.error.message, JSON.stringify(event), `400 ${body}`]) {
    assert.ok(isClaudeCodeOverflow(text), text)
    assert.deepEqual(claudeCodeCounts(text), ["131008", "128000"], text)
  }
})

test("an overflow whose counts cannot be read is still reported as a prompt too long", () => {
  for (const message of [
    undefined,
    "prompt token count exceeds the limit",
    `prompt token count of ${"9".repeat(20)} exceeds the limit of 128000`,
    `${copilotMessage} for gpt-5-mini`,
  ]) {
    const error = toPromptTooLongError(400, copilotOverflow(message))

    assert.ok(error instanceof PromptTooLongError, String(message))
    assert.equal(error.message, "prompt is too long")
    assert.ok(isClaudeCodeOverflow(error.message))
    assert.equal(claudeCodeCounts(error.message), undefined)
  }

  // The request id the route appends is not misread as a count.
  assert.equal(claudeCodeCounts("prompt is too long (request_id=3b241101-e2bb-4255-8caf-4136c566a962)"), undefined)
})

test("the native route's own prompt-too-long error is rebuilt from its counts", async () => {
  const native = toPromptTooLongError(
    400,
    anthropicError("invalid_request_error", "prompt is too long: 208310 tokens > 200000 maximum"),
  )

  assert.ok(native instanceof PromptTooLongError)
  assert.equal(native.message, "prompt is too long: 208310 tokens > 200000 maximum")

  // Text beyond the recognized wording is never forwarded; only the overflow itself is.
  const extended = toPromptTooLongError(
    400,
    anthropicError("invalid_request_error", "prompt is too long: 208310 tokens > 200000 maximum. Private fixture detail"),
  )

  assert.ok(extended instanceof PromptTooLongError)
  assert.equal(extended.message, "prompt is too long")
  assert.doesNotMatch(await extended.response.text(), /Private fixture detail/)
})

test("other upstream errors are not mistaken for a prompt overflow", () => {
  const cases: Array<[number, string]> = [
    // Only HTTP 400 is an overflow.
    [413, copilotOverflow(copilotMessage)],
    [500, copilotOverflow(copilotMessage)],
    // Copilot's wording without its code, and another Copilot rejection.
    [400, JSON.stringify({ error: { message: copilotMessage, code: "invalid_request_body" } })],
    [400, JSON.stringify({ error: { message: "Invalid schema for function 'Read'.", code: "invalid_request_body" } })],
    // Anthropic's envelope with another type or another message, and the inner error without the envelope.
    [400, anthropicError("api_error", overflowMessage)],
    [400, anthropicError("invalid_request_error", "messages.1: content is empty")],
    [400, JSON.stringify({ error: { type: "invalid_request_error", message: overflowMessage } })],
    // Bodies that are not a JSON error object.
    [400, "prompt is too long"],
    [400, ""],
    [400, "null"],
    [400, "[]"],
    [400, JSON.stringify({ error: "prompt is too long" })],
  ]

  for (const [status, body] of cases) {
    assert.equal(toPromptTooLongError(status, body), undefined, `${status} ${body}`)
  }
})

test("a streamed overflow keeps Anthropic's error type and any other error stays generic", () => {
  assert.deepEqual(translateErrorToClaudeErrorEvent(toPromptTooLongError(400, copilotOverflow(copilotMessage))), {
    type: "error",
    error: { type: "invalid_request_error", message: overflowMessage },
  })

  const upstream = new HTTPError(
    "Failed to create chat completions",
    Response.json({ error: { message: "Private fixture detail" } }, { status: 400 }),
    "Private fixture detail",
  )

  assert.deepEqual(translateErrorToClaudeErrorEvent(upstream), {
    type: "error",
    error: { type: "api_error", message: "An unexpected error occurred during streaming." },
  })
})
