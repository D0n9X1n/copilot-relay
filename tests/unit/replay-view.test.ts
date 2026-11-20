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

test("a difference path is never cut; one too long to sit beside its reason gets its own line", () => {
  const name = "upstream[0].request.body.tools[0].function.parameters.name"
  const description = "upstream[0].request.body.tools[0].function.parameters.description"
  const nested = "upstream[0].request.body.tools[0].function.parameters.properties.location.description"
  const lines = renderReplay({
    ...matched,
    verdict: "DIFF",
    exitCode: 2,
    differences: [name, description, nested].map((path) => ({ path, reason: "Value differs" })),
  }, false, true)

  // name fits beside its reason; description and nested would pass 80 columns, so each takes a line.
  assert.deepEqual(lines.slice(-7), [
    "Differences (3)",
    "",
    `  ${name}  Value differs`,
    `  ${description}`,
    "    Value differs",
    `  ${nested}`,
    "    Value differs",
  ])
  for (const line of lines) {
    assert.ok(displayWidth(line) <= 80 || line.trim() === nested, `${displayWidth(line)}: ${line}`)
  }
})

test("without Unicode the count of differences not listed ends in ASCII dots", () => {
  const differences = Array.from({ length: 45 }, (_, index) => ({ path: `client.body[${index}].data`, reason: "Value differs" }))
  const lines = renderReplay({ ...matched, verdict: "DIFF", exitCode: 2, differences }, false, false)

  assert.equal(lines.at(-1), "  ... and 15 more")
})

test("a refusal with its category and token counts fits 80 columns, the category kept", () => {
  for (const unicode of [true, false]) {
    const lines = renderReplay({
      ...matched,
      summary: {
        ...matched.summary!,
        outcome: "refusal",
        exchanges: [
          { order: 1, path: "/chat/completions", status: 200, outcome: "refusal", usage: { input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 1024 }, refusalCategory: "reasoning_extraction" },
        ],
      },
    }, false, unicode)

    assert.ok(lines.some((line) => line.includes("reasoning_extraction")), lines.join("\n"))
    for (const line of lines) {
      assert.ok(displayWidth(line) <= 80, `${displayWidth(line)}: ${line}`)
    }
  }
})

test("twelve tool_use blocks wrap under the blocks label within 80 columns", () => {
  const lines = renderReplay({
    ...matched,
    summary: { ...matched.summary!, contentBlocks: ["text", ...Array.from({ length: 12 }, () => "tool_use")], toolCalls: 12 },
  }, false, true)
  const start = lines.findIndex((line) => line.startsWith("    blocks"))

  assert.ok(lines[start + 1].startsWith(`${" ".repeat(16)}tool_use`), lines.join("\n"))
  assert.equal(lines.join(" ").match(/tool_use/g)?.length, 12)
  for (const line of lines) {
    assert.ok(displayWidth(line) <= 80, `${displayWidth(line)}: ${line}`)
  }
})

test("with color on, the verdict keeps its color", () => {
  const lines = renderReplay(matched, true, true)

  assert.equal(lines[2], "  \u001b[32m✓ MATCH\u001b[0m       the relay reproduces the recording")
})

test("details under a row wrap in printable ASCII within 80 columns", () => {
  const lines = renderReplay({
    ...matched,
    summary: {
      ...matched.summary!,
      outcome: "refusal",
      exchanges: [
        { order: 1, path: "/chat/completions", status: 200, outcome: "refusal", usage: { input_tokens: 1_000_000, output_tokens: 64_000, cache_read_input_tokens: 950_000, cache_creation_input_tokens: 50_000 }, refusalCategory: "reasoning_extraction" },
        { order: 2, path: "/chat/completions", status: 200, outcome: "content_filter", usage: { input_tokens: 10, output_tokens: 5 } },
      ],
    },
  }, false, false)
  const table = lines.slice(lines.findIndex((line) => line.trimStart().startsWith("#")))

  assert.ok(table.some((line) => line.includes("refusal reasoning_extraction")), lines.join("\n"))
  for (const line of table) {
    assert.ok(displayWidth(line) <= 80, `${displayWidth(line)}: ${line}`)
    assert.ok(!line.includes("·"), line)
  }
})
