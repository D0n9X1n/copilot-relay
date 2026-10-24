import assert from "node:assert/strict"
import test from "node:test"

import { StableItemIds } from "../../src/codex/item-ids"

type JsonRecord = Record<string, any>

// One message as Copilot streams it: every event names the item by a new id.
const rotating = [
  { type: "response.created", response: { id: "resp_1", status: "in_progress", output: [] } },
  { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "A", role: "assistant", content: [] } },
  { type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "B", part: { type: "output_text", text: "" } },
  { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "C", delta: "hello" },
  { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "D", delta: " there" },
  { type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "E", text: "hello there" },
  { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "F", role: "assistant", content: [] } },
  { type: "response.completed", response: { id: "resp_1", status: "completed", output: [{ type: "message", id: "G", content: [] }] } },
]

const sse = (events: Array<JsonRecord>, eol = "\n"): string =>
  events.map((event) => `event: ${event.type}${eol}data: ${JSON.stringify(event)}${eol}${eol}`).join("")

const rewrite = (text: string, chunkSize: number): string => {
  const ids = new StableItemIds()
  const bytes = new TextEncoder().encode(text)
  const decoder = new TextDecoder()
  let out = ""
  for (let at = 0; at < bytes.length; at += chunkSize) {
    out += decoder.decode(ids.push(bytes.slice(at, at + chunkSize)), { stream: true })
  }

  return out + decoder.decode(ids.flush())
}

const events = (text: string): Array<JsonRecord> =>
  text.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))

test("every event about an output item names it by the id of its added event", () => {
  for (const chunkSize of [1, 7, 64, 100_000]) {
    const out = events(rewrite(sse(rotating), chunkSize))

    const ids = out.flatMap((event) => [event.item_id, event.item?.id]).filter((id) => id !== undefined)
    assert.deepEqual([...new Set(ids)], ["A"], `chunk size ${chunkSize}`)
    assert.equal(out.at(-1)!.response.output[0].id, "A")
    assert.equal(out.length, rotating.length)
  }
})

test("a stream whose ids already agree passes through byte for byte, CRLF included", () => {
  const stable = rotating.map((event) => JSON.parse(JSON.stringify(event).replaceAll(/"(?:item_)?id":"[B-G]"/g, (match) => match.replace(/[B-G]/, "A"))))
  for (const eol of ["\n", "\r\n"]) {
    const text = sse(stable, eol)
    assert.equal(rewrite(text, 5), text)
  }
})

test("items at different output indexes keep their own ids, and an unfinished frame is passed on as it is", () => {
  const two = [
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "R", summary: [] } },
    { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "FC", call_id: "call_1", name: "exec" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: "X", delta: "{}" },
    { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "Y", summary: [] } },
  ]
  const tail = "data: {\"type\":\"response.output_te"
  const out = rewrite(sse(two) + tail, 9)

  assert.deepEqual(events(out.slice(0, -tail.length)).map((event) => event.item_id ?? event.item?.id), ["R", "FC", "FC", "R"])
  assert.ok(out.endsWith(tail))
})
