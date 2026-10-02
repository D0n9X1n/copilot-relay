import assert from "node:assert/strict"
import test from "node:test"
import { stripVTControlCharacters } from "node:util"

import { colorEnabled, terminalText } from "../../src/lib/terminal"
import { probeColumnWidth, renderProbeDetails, renderProbeHeader, renderProbeRow, renderProbeSummary, type ProbeRow } from "../../src/lib/model-probe-output"

const row: ProbeRow = {
  id: "claude-opus-5.5", status: "PASS", sent: true, endpoint: "/chat/completions", reported: "claude-opus-5.5",
  latency: 1200, detail: "completed-text", maxTokens: 4096, effort: "low", unverified: false,
}

for (const [env, tty, expected] of [
  [{}, true, true], [{}, false, false], [{ CI: "true" }, false, false],
  [{ FORCE_COLOR: "1" }, false, true], [{ FORCE_COLOR: "0" }, true, false],
  [{ FORCE_COLOR: "1", NO_COLOR: "1" }, true, false],
  [{ TERM: "dumb" }, true, false],
  [{ FORCE_COLOR: "false" }, true, false], [{ FORCE_COLOR: "no" }, true, false],
  [{ FORCE_COLOR: "" }, false, true],
] as const) {
  test(`terminal color policy ${JSON.stringify(env)} tty=${tty}`, () => {
    assert.equal(colorEnabled(env, tty), expected)
  })
}

test("probe table has stable plain text beneath status colors", () => {
  const width = probeColumnWidth([row.id], 80)
  const plain = renderProbeRow(row, width, false).join("\n")
  assert.equal(plain, "claude-opus-5.5  PASS          1.2s  Ready")
  assert.equal(stripVTControlCharacters(renderProbeRow(row, width, true).join("\n")), plain)
  assert.match(renderProbeRow(row, width, true).join("\n"), /\u001b\[32mPASS\u001b\[0m/)
  assert.match(renderProbeHeader(width), /MODEL\s+STATUS\s+TIME\s+RESULT/)
})

for (const columns of [60, 80, 120]) {
  test(`long model IDs remain readable at ${columns} columns`, () => {
    const longRow = { ...row, id: "claude-" + "x".repeat(110), status: "INCOMPLETE" as const, detail: "output-budget-exhausted-usage-unreported", unverified: true }
    const width = probeColumnWidth([longRow.id], columns)
    const lines = renderProbeRow(longRow, width, true, columns).map(stripVTControlCharacters)
    assert(lines.every((line) => line.length <= columns), JSON.stringify(lines))
    assert.equal(lines.map((line) => line.slice(0, width).trimEnd()).join(""), longRow.id)
  })
}

test("details include failure location without hiding unknown evidence", () => {
  const details = renderProbeDetails(row, {
    requestId: "10000000-0000-4000-8000-000000000001", status: 502, terminal: false,
    capture: { state: "off" }, refreshes: [], exchanges: [{
      order: 1, path: "/responses", status: 200, responseState: "complete",
      responseStatus: "incomplete", incompleteReason: "max_output_tokens", model: "gpt-6-astra", discarded: false,
    }],
  }).join("\n")
  assert.match(details, /client_http=502/)
  assert.match(details, /upstream_http=200/)
  assert.match(details, /upstream_request_id=unknown/)
  assert.match(details, /upstream_model=gpt-6-astra/)
  assert.match(details, /incomplete_reason=max_output_tokens/)
})

test("large configured timeouts keep the duration column bounded", () => {
  for (const latency of [999_999, 3_600_000, 2_147_483_000]) {
    const text = renderProbeRow({ ...row, latency }, 14, false, 60).join("\n")
    assert(text.split("\n").every((line) => line.length <= 60))
    assert.match(text, /\b[\d.]+[smh]\b/)
  }
})

test("terminal strings and result messages cannot inject control sequences", () => {
  const dirty = "model\u001b[2K\r\n\u0085" + String.fromCodePoint(0x202e) + "-id"
  assert.equal(terminalText(dirty), "model-id")
  const text = renderProbeRow({ ...row, id: dirty, detail: "PRIVATE_ERROR\u001b[31m" }, 14, false).join("\n")
  assert.doesNotMatch(text, /\u001b|PRIVATE_ERROR/)
  assert.match(text, /Unknown result/)
})

for (const state of ["off", "pending", "incomplete", "failed", "complete"] as const) {
  test(`replay hint requires a completed capture: ${state}`, () => {
    const details = renderProbeDetails(row, { requestId: "10000000-0000-4000-8000-000000000001", status: 200, terminal: true, exchanges: [], refreshes: [], capture: { state } }).join("\n")
    assert.equal(details.includes("Offline replay: copilot-relay replay"), state === "complete")
    assert.match(details, new RegExp(`capture=${state}`))
  })
}

test("summaries distinguish all outcomes without zero-filled boilerplate", () => {
  assert.equal(renderProbeSummary([]), "Summary: no models to test")
  assert.equal(renderProbeSummary([row]), "Summary: 1 passed")
  const rows = ["PASS", "FAIL", "INCOMPLETE", "SKIPPED", "NOT_TESTED"].map((status) => ({ ...row, status } as ProbeRow))
  assert.equal(renderProbeSummary(rows), "Summary: 1 passed · 1 failed · 1 incomplete · 1 skipped · 1 not tested")
})
