import assert from "node:assert/strict"
import test from "node:test"

import { removeBillingLine } from "../../src/claude/billing-line"
import type { ClaudeMessagesPayload } from "../../src/claude/types"

// The first system block Claude Code 2.1.288 sent in #157.
const billingLine = "x-anthropic-billing-header: cc_version=2.1.288.976; cc_entrypoint=sdk-cli;"
const identity = "You are Claude Code, Anthropic's official CLI for Claude."
const instructions = "Answer in one sentence."

const payloadWith = (system: unknown): ClaudeMessagesPayload => ({
  model: "claude-opus-5",
  max_tokens: 64,
  messages: [{ role: "user", content: "Hi" }],
  system: system as ClaudeMessagesPayload["system"],
})

test("drops a block that holds only the billing line and keeps the other blocks with their cache marks", () => {
  const payload = payloadWith([
    { type: "text", text: billingLine },
    { type: "text", text: identity, cache_control: { type: "ephemeral" } },
    { type: "text", text: instructions, cache_control: { type: "ephemeral" } },
  ])

  assert.deepEqual(removeBillingLine(payload).system, [
    { type: "text", text: identity, cache_control: { type: "ephemeral" } },
    { type: "text", text: instructions, cache_control: { type: "ephemeral" } },
  ])
})

for (const separator of ["\n", "\n\n", "\r\n", "\r\n\r\n"]) {
  test(`removes only the billing line from a block that continues after ${JSON.stringify(separator)}`, () => {
    const payload = payloadWith([
      { type: "text", text: `${billingLine}${separator}${identity}`, cache_control: { type: "ephemeral" } },
    ])

    assert.deepEqual(removeBillingLine(payload).system, [
      { type: "text", text: identity, cache_control: { type: "ephemeral" } },
    ])
  })
}

test("removes the billing line from a string system prompt", () => {
  assert.equal(removeBillingLine(payloadWith(`${billingLine}\n\n${identity}`)).system, identity)
})

test("removes a billing line that leads a later block", () => {
  const payload = payloadWith([{ type: "text", text: identity }, { type: "text", text: billingLine }])

  assert.deepEqual(removeBillingLine(payload).system, [{ type: "text", text: identity }])
})

test("leaves out the system prompt when it held only the billing line", () => {
  for (const system of [billingLine, `${billingLine}\n`, [{ type: "text", text: billingLine }]]) {
    const result = removeBillingLine(payloadWith(system))

    assert.equal("system" in result, false)
    assert.deepEqual(result.messages, [{ role: "user", content: "Hi" }])
  }
})

test("returns the payload itself when no text starts with the billing line", () => {
  const unchanged = [
    undefined,
    identity,
    [],
    [{ type: "text", text: identity }],
    [{ type: "text", text: `${identity}\n${billingLine}` }],
    [{ type: "text", text: ` ${billingLine}` }],
  ]

  for (const system of unchanged) {
    const payload = payloadWith(system)
    assert.equal(removeBillingLine(payload), payload)
  }
})

test("does not change the request it was given", () => {
  const system = [{ type: "text", text: billingLine }, { type: "text", text: identity }]
  const payload = payloadWith(system)

  removeBillingLine(payload)

  assert.equal(payload.system, system)
  assert.deepEqual(system, [{ type: "text", text: billingLine }, { type: "text", text: identity }])
})

test("passes malformed values through for validation to reject", () => {
  const payload = payloadWith([null, "text", { type: "image" }, { type: "text", text: 42 }])

  assert.equal(removeBillingLine(payload), payload)
  assert.equal(removeBillingLine(null as unknown as ClaudeMessagesPayload), null)
})
