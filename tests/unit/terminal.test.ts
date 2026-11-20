import assert from "node:assert/strict"
import test from "node:test"
import { stripVTControlCharacters } from "node:util"

import { registerLogSecret } from "../../src/lib/log"
import { registerSensitiveOrigin } from "../../src/lib/redact"
import {
  columnWidths,
  formatCount,
  formatTokens,
  heading,
  mark,
  printableCell,
  renderTable,
  unicodeEnabled,
  type TableColumn,
} from "../../src/lib/terminal"

interface Row {
  model: string
  requests: number
  rate: string
}

const columns: Array<TableColumn<Row>> = [
  { header: "MODEL", align: "left", cell: (row) => row.model },
  { header: "REQUESTS", align: "right", cell: (row) => formatCount(row.requests) },
  { header: "HIT RATE", align: "right", cell: (row) => row.rate, tone: (row) => row.rate === "72.86%" ? "bad" : "good" },
]

const rows: Array<Row> = [
  { model: "claude-opus-5.5", requests: 994, rate: "94.53%" },
  { model: "gpt-6-astra", requests: 1052, rate: "72.86%" },
]

test("renderTable indents, pads with a two-space gutter and right-aligns numbers", () => {
  assert.deepEqual(renderTable(columns, rows, false), [
    "  MODEL            REQUESTS  HIT RATE",
    "  claude-opus-5.5       994    94.53%",
    "  gpt-6-astra         1,052    72.86%",
  ])
})

test("renderTable colors after padding, so the plain text is the same with color on", () => {
  const colored = renderTable(columns, rows, true)
  assert.deepEqual(colored.map((line) => stripVTControlCharacters(line)), renderTable(columns, rows, false))
  assert.match(colored[2], /\u001b\[31m {2}72\.86%\u001b\[0m$/)
})

test("renderTable writes no escape byte with color off", () => {
  assert.ok(renderTable(columns, rows, false).every((line) => !line.includes("\u001b")))
})

test("renderTable leaves no trailing spaces when the last column is left-aligned and short", () => {
  const lines = renderTable(
    [
      { header: "CLIENT", align: "left", cell: (row: { client: string, note: string }) => row.client },
      { header: "NOTE", align: "left", cell: (row) => row.note },
    ],
    [{ client: "codex-cli", note: "a much longer note" }, { client: "claude-code-app", note: "short" }],
    false,
  )

  assert.ok(lines.every((line) => line === line.trimEnd()))
  assert.equal(lines[2], "  claude-code-app  short")
})

test("renderTable cuts a cell over maxWidth with an ellipsis", () => {
  const lines = renderTable(
    [{ header: "NAME", align: "left", maxWidth: 8, cell: (row: { name: string }) => row.name }],
    [{ name: "Claude Opus 5.5 Long" }, { name: "Grok" }],
    false,
  )

  assert.deepEqual(lines, ["  NAME", "  Claude …", "  Grok"])
})

test("renderTable blanks a repeatBlank cell equal to the row above", () => {
  const lines = renderTable(
    [
      { header: "HOUR", align: "left", repeatBlank: true, cell: (row: { hour: string, model: string }) => row.hour },
      { header: "MODEL", align: "left", cell: (row) => row.model },
    ],
    [
      { hour: "19:00", model: "claude-opus-5.5" },
      { hour: "19:00", model: "gpt-6-astra" },
      { hour: "20:00", model: "gpt-6-astra" },
    ],
    false,
  )

  assert.deepEqual(lines, [
    "  HOUR   MODEL",
    "  19:00  claude-opus-5.5",
    "         gpt-6-astra",
    "  20:00  gpt-6-astra",
  ])
})

test("renderTable measures width without escape sequences or hidden characters in a cell", () => {
  const lines = renderTable(
    [
      { header: "ID", align: "left", cell: (row: { id: string }) => row.id },
      { header: "N", align: "right", cell: () => "1" },
    ],
    [{ id: "\u001b[31mred\u001b[0m‮" }, { id: "plain" }],
    false,
  )

  assert.deepEqual(lines, ["  ID     N", "  red    1", "  plain  1"])
})

test("renderTable pads by terminal columns: a wide character takes two, a combining mark none", () => {
  const lines = renderTable(
    [
      { header: "ID", align: "left", cell: (row: { id: string }) => row.id },
      { header: "N", align: "right", cell: () => "1" },
    ],
    [{ id: "模型" }, { id: "ab" }, { id: "é" }, { id: "😀" }],
    false,
  )

  assert.deepEqual(lines, ["  ID    N", "  模型  1", "  ab    1", "  e\u0301     1", "  😀    1"])
})

test("renderTable cuts by terminal columns and never inside a character", () => {
  const cut = (id: string, maxWidth: number): string =>
    renderTable([{ header: "ID", align: "left", cell: () => id, maxWidth }], [{}], false)[1].trim()

  assert.equal(cut("模型图", 3), "模…")
  assert.equal(cut("😀x", 2), "…")
  assert.equal(cut("ééé", 2), "é…")
  assert.equal(cut("模型", 4), "模型")
})

test("supplementary CJK takes two columns and a lone combining mark none", () => {
  const lines = renderTable(
    [
      { header: "ID", align: "left", cell: (row: { id: string }) => row.id },
      { header: "N", align: "right", cell: () => "1" },
    ],
    [{ id: "A" }, { id: "𠀀" }, { id: "\u0301" }],
    false,
  )

  assert.deepEqual(lines, ["  ID  N", "  A   1", "  𠀀  1", "  \u0301    1"])
  assert.equal(
    renderTable([{ header: "ID", align: "left", cell: () => "𠀀𠀀x", maxWidth: 3 }], [{}], false)[1].trim(),
    "𠀀…",
  )
})

test("a colored last column carries no trailing padding", () => {
  const lines = renderTable(
    [{ header: "LABEL", align: "left", cell: (row: { label: string }) => row.label, tone: () => "good" }],
    [{ label: "AAAAAA" }, { label: "B" }, { label: "" }],
    true,
  ).map((line) => stripVTControlCharacters(line))

  assert.deepEqual(lines, ["  LABEL", "  AAAAAA", "  B", ""])
})

test("rows rendered one at a time with shared widths line up with the header", () => {
  const probeColumns: Array<TableColumn<{ id: string }>> = [
    { header: "MODEL", align: "left", cell: (row) => row.id },
    { header: "STATUS", align: "left", cell: () => "ok" },
  ]
  const widths = columnWidths(probeColumns, [{ id: "claude-opus-5.5" }], [8, 6])

  const header = renderTable(probeColumns, [], false, widths)[0]
  const first = renderTable(probeColumns, [{ id: "gpt-6.2-astra" }], false, widths)[1]
  const second = renderTable(probeColumns, [{ id: "claude-opus-5.5" }], false, widths)[1]

  assert.deepEqual([header, first, second], [
    "  MODEL            STATUS",
    "  gpt-6.2-astra    ok",
    "  claude-opus-5.5  ok",
  ])
})

test("a shared width narrower than an ID widens the line rather than cutting the ID", () => {
  const idColumns: Array<TableColumn<{ id: string }>> = [{ header: "MODEL", align: "left", cell: (row) => row.id }]

  const line = renderTable(idColumns, [{ id: "a-very-long-model-id-that-must-stay-copyable" }], false, [5])[1]

  assert.equal(line, "  a-very-long-model-id-that-must-stay-copyable")
})

test("printableCell removes controls, then registered secrets and sensitive URLs", () => {
  registerLogSecret("terminal-fixture-key-0001")
  registerSensitiveOrigin("https://gateway.terminal.example/tenant/secret-path")

  assert.equal(printableCell("a\u0007b"), "ab")
  assert.ok(!printableCell("x terminal-fixture-key-0001 y").includes("terminal-fixture-key-0001"))
  // A control byte inside the key would stop the secret from matching if it were scrubbed first.
  assert.ok(!printableCell("terminal-\u0007fixture-key-0001").includes("fixture-key-0001"))
  assert.ok(!printableCell("see https://gateway.terminal.example/tenant/secret-path/v1").includes("secret-path"))
})

test("a registered secret straddling the cut leaks neither whole nor any prefix", () => {
  const key = "terminal-straddle-key-0002"
  registerLogSecret(key)
  const lines = renderTable(
    [{ header: "NAME", align: "left", maxWidth: 18, cell: (row: { name: string }) => row.name }],
    [{ name: `xxxxxxxxxx${key}` }],
    false,
  )

  const printed = lines.join("\n")
  for (let length = 4; length <= key.length; length += 1) {
    assert.ok(!printed.includes(key.slice(0, length)), `prefix of length ${length} printed: ${printed}`)
  }
})

test("heading joins a title and an optional detail", () => {
  assert.equal(heading("Prompt-cache hit rate"), "Prompt-cache hit rate")
  assert.equal(heading("Prompt-cache hit rate", "last 24 h"), "Prompt-cache hit rate · last 24 h")
})

test("mark uses symbols with unicode and words without", () => {
  assert.deepEqual(
    (["ok", "fail", "warn", "off"] as const).map((state) => mark(state, true)),
    ["✓", "✗", "!", "–"],
  )
  assert.deepEqual(
    (["ok", "fail", "warn", "off"] as const).map((state) => mark(state, false)),
    ["ok", "x", "!", "-"],
  )
})

for (const [env, platform, expected] of [
  [{}, "win32", false],
  [{ WT_SESSION: "1" }, "win32", true],
  [{ TERM_PROGRAM: "vscode" }, "win32", true],
  [{ LANG: "en_US.UTF-8" }, "darwin", true],
  [{ LANG: "en_US.utf8" }, "linux", true],
  [{ LANG: "C" }, "linux", false],
  [{ LC_ALL: "C", LANG: "en_US.UTF-8" }, "linux", false],
  [{ LC_CTYPE: "UTF-8", LANG: "C" }, "darwin", true],
  [{ LC_ALL: "", LC_CTYPE: "en_US.UTF-8" }, "linux", true],
  [{}, "linux", false],
] as const) {
  test(`unicodeEnabled ${JSON.stringify(env)} on ${platform}`, () => {
    assert.equal(unicodeEnabled(env, platform), expected)
  })
}

test("formatCount groups thousands", () => {
  assert.deepEqual([0, 999, 1000, 1052, 1_000_000].map(formatCount), ["0", "999", "1,000", "1,052", "1,000,000"])
})

test("formatTokens shortens to one decimal with K, M and B", () => {
  assert.deepEqual(
    [0, 812, 999, 1000, 42_100, 999_950, 309_700_000, 1_200_000_000].map(formatTokens),
    ["0", "812", "999", "1K", "42.1K", "1M", "309.7M", "1.2B"],
  )
})
