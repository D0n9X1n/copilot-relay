import assert from "node:assert/strict"
import test from "node:test"
import { stripVTControlCharacters } from "node:util"

import { renderReplay, type ReplayResult } from "../../src/replay"
import { displayWidth } from "../../src/lib/terminal"

const matched: ReplayResult = {
  verdict: "MATCH",
  exitCode: 0,
  differences: [],
  summary: {
    method: "POST",
    path: "/v1/messages",
    status: 200,
    routes: ["/models", "/chat/completions"],
    outcome: "end_turn",
    exchanges: [
      { order: 1, path: "/models", status: 200, outcome: "unreported", usage: {} },
      { order: 2, path: "/chat/completions", status: 200, outcome: "stop", usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 1024 } },
    ],
    contentBlocks: ["text", "tool_use"],
    toolCalls: 1,
  },
}

test("a matching replay reads as a heading, a marked verdict, the request and a table of exchanges", () => {
  assert.deepEqual(renderReplay(matched, false, true), [
    "Replay · POST /v1/messages",
    "",
    "  ✓ MATCH       the relay reproduces the recording",
    "    request     status 200 · outcome end_turn · 1 tool call",
    "    blocks      text, tool_use",
    "",
    "  #  UPSTREAM           STATUS  OUTCOME        IN  OUT  CACHED  WRITTEN",
    "  1  /models               200  unreported      –    –       –        –",
    "  2  /chat/completions     200  stop        1,200   30   1,024        –",
  ])
})

test("a diff lists each changed field under the table, and the verdict is marked as a failure", () => {
  const lines = renderReplay({
    ...matched,
    verdict: "DIFF",
    exitCode: 2,
    differences: [
      { path: "upstream[1].body.model", reason: "Value differs" },
      { path: "client.body[2].data.delta.text", reason: "Value differs" },
    ],
  }, false, true)

  assert.equal(lines[2], "  ✗ DIFF        the relay's current handling differs from the recording")
  assert.deepEqual(lines.slice(-4), [
    "Differences (2)",
    "",
    "  upstream[1].body.model          Value differs",
    "  client.body[2].data.delta.text  Value differs",
  ])
})

test("a missing capture has no summary, so it prints the verdict and its reason alone", () => {
  assert.deepEqual(renderReplay({
    verdict: "MISSING",
    exitCode: 1,
    differences: [{ path: "capture", reason: "Capture not found" }],
  }, false, false), [
    "Replay",
    "",
    "  x MISSING     no complete capture was found for that target",
    "",
    "Differences (1)",
    "",
    "  capture  Capture not found",
  ])
})

test("a long list of differences is cut, and every line fits 80 columns", () => {
  const differences = Array.from({ length: 45 }, (_, index) => ({ path: `client.body[${index}].data`, reason: "Value differs" }))
  const lines = renderReplay({ ...matched, verdict: "DIFF", exitCode: 2, differences }, true, true)

  assert.equal(stripVTControlCharacters(lines.at(-1)!), "  … and 15 more")
  for (const line of lines) {
    assert.ok(displayWidth(stripVTControlCharacters(line)) <= 80, line)
  }
})
