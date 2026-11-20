import assert from "node:assert/strict"
import test from "node:test"
import { stripVTControlCharacters } from "node:util"

import { registerLogSecret } from "../../src/lib/log"
import { colorEnabled, displayWidth, terminalText } from "../../src/lib/terminal"
import {
  probeColumnWidth,
  probeHint,
  renderProbeDetails,
  renderProbeHeader,
  renderProbeRow,
  renderProbeSummary,
  type ProbeRow,
} from "../../src/lib/model-probe-output"

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
  // An empty FORCE_COLOR still forces color, as in Node.
  [{ FORCE_COLOR: "" }, false, true],
] as const) {
  test(`terminal color policy ${JSON.stringify(env)} tty=${tty}`, () => {
    assert.equal(colorEnabled(env, tty), expected)
  })
}

test("probe table has stable plain text beneath status colors, and a mark on every status", () => {
  const width = probeColumnWidth([row.id])
  const plain = renderProbeRow(row, width, false, true).join("\n")

  assert.equal(renderProbeHeader(width), "  MODEL            STATUS          TIME  RESULT")
  assert.equal(plain, "  claude-opus-5.5  ✓ PASS          1.2s  Ready")
  assert.equal(stripVTControlCharacters(renderProbeRow(row, width, true, true).join("\n")), plain)
  assert.match(renderProbeRow(row, width, true, true).join("\n"), /\u001b\[32m✓ PASS\u001b\[0m/)

  const marks = (["FAIL", "INCOMPLETE", "SKIPPED", "NOT_TESTED"] as const)
    .map((status) => renderProbeRow({ ...row, status }, width, false, true)[0].slice(2 + width + 2, 2 + width + 2 + 12).trimEnd())
  assert.deepEqual(marks, ["✗ FAIL", "! INCOMPLETE", "– SKIPPED", "– NOT_TESTED"])
  assert.match(renderProbeRow({ ...row, status: "FAIL" }, width, false, false)[0], /^ {2}claude-opus-5\.5 {2}x FAIL /)
})

test("two rows printed one at a time line up under the header", () => {
  const second = { ...row, id: "gpt-6.2-astra", latency: 15_300 }
  const width = probeColumnWidth([row.id, second.id])
  const header = renderProbeHeader(width)
  const first = renderProbeRow(row, width, false, true)[0]
  const next = renderProbeRow(second, width, false, true)[0]

  assert.equal(header.indexOf("STATUS"), first.indexOf("✓"))
  assert.equal(first.indexOf("✓"), next.indexOf("✓"))
  assert.equal(header.indexOf("RESULT"), next.indexOf("Ready"))
})

test("a registered secret inside a long ID prints neither whole nor in pieces", () => {
  const key = "probefixturesecret0003"
  registerLogSecret(key)
  const id = `${"m".repeat(32)}${key}-tail`
  const width = probeColumnWidth([id])
  const printed = renderProbeRow({ ...row, id }, width, false, true).join("\n")

  for (let length = 2; length <= key.length; length += 1) {
    assert.ok(!printed.includes(key.slice(0, length)), `prefix of length ${length} printed: ${printed}`)
  }
})

test("a long ID stays whole on one row, so it can be copied", () => {
  const id = "claude-" + "x".repeat(110)
  const width = probeColumnWidth([id])
  const lines = renderProbeRow({ ...row, id }, width, false, true)

  assert.equal(lines.length, 1)
  assert.ok(lines[0].startsWith(`  ${id}  ✓ PASS`))
})

test("details include failure location without hiding unknown evidence", () => {
  const details = renderProbeDetails(row, {
    requestId: "10000000-0000-4000-8000-000000000001", status: 502, terminal: false,
    capture: { state: "off" }, refreshes: [],
    exchanges: [{
      order: 1, path: "/responses", status: 200, responseState: "complete",
      responseStatus: "incomplete", incompleteReason: "max_output_tokens", model: "gpt-6-astra", discarded: false,
    }],
  }).join("\n")

  assert.match(details, /client_http=502/)
  assert.match(details, /upstream_http=200/)
  // A missing provider request ID is printed as unknown, not left out.
  assert.match(details, /upstream_request_id=unknown/)
  assert.match(details, /upstream_model=gpt-6-astra/)
  assert.match(details, /incomplete_reason=max_output_tokens/)
})

test("large configured timeouts keep the duration column bounded", () => {
  for (const latency of [999_999, 3_600_000, 2_147_483_000]) {
    const text = renderProbeRow({ ...row, latency }, 14, false).join("\n")
    // TIME stays six characters wide, so the row is as wide as one with a short duration.
    assert.equal(text.length, renderProbeRow({ ...row, latency: 1200 }, 14, false).join("\n").length)
    assert.match(text, /\b[\d.]+[smh]\b/)
  }
})

test("terminal strings and result messages cannot inject control sequences", () => {
  const dirty = "model\u001b[2K\r\n\u0085" + String.fromCodePoint(0x202e) + "-id"
  assert.equal(terminalText(dirty), "model-id")

  // An unrecognized result code renders as "Unknown result" instead of being echoed.
  const text = renderProbeRow({ ...row, id: dirty, detail: "PRIVATE_ERROR\u001b[31m" }, 14, false).join("\n")
  assert.doesNotMatch(text, /\u001b|PRIVATE_ERROR/)
  assert.match(text, /Unknown result/)
})

for (const state of ["off", "pending", "incomplete", "failed", "complete"] as const) {
  test(`replay hint requires a completed capture: ${state}`, () => {
    const details = renderProbeDetails(row, {
      requestId: "10000000-0000-4000-8000-000000000001",
      status: 200,
      terminal: true,
      exchanges: [],
      refreshes: [],
      capture: { state },
    }).join("\n")

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

test("every probe hint fits 80 columns", () => {
  const codes = [
    "protocol-policy-conflict", "unsupported-relay-endpoint", "no-advertised-endpoint", "probe-timeout",
    "upstream-timeout-or-HTTP-504", "authentication-rejected", "refresh-failed", "access-denied", "rate-limited",
    "refusal", "output-budget-exhausted", "model-mismatch", "model-not-supported", "unknown-error", "HTTP-502",
  ]

  for (const code of codes) {
    const hint = probeHint(code)
    assert.ok(hint !== undefined, code)

    for (const line of hint.split("\n")) {
      assert.ok(displayWidth(line) <= 80, `${displayWidth(line)} columns: ${line}`)
    }
  }
})
