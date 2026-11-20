import assert from "node:assert/strict"
import test from "node:test"
import { stripVTControlCharacters } from "node:util"

import {
  boldText,
  colorDepth,
  colorText,
  heading,
  priceRamp,
  rampShade,
  renderTable,
  type TableColumn,
} from "../../src/lib/terminal"

test("colorDepth is 0 when color is off, follows FORCE_COLOR 1/2/3, and otherwise asks the stream", () => {
  assert.equal(colorDepth({ NO_COLOR: "1", FORCE_COLOR: "3" }, undefined), 0)
  assert.equal(colorDepth({ FORCE_COLOR: "1" }, undefined), 4)
  assert.equal(colorDepth({ FORCE_COLOR: "2" }, undefined), 8)
  assert.equal(colorDepth({ FORCE_COLOR: "3" }, undefined), 24)
  assert.equal(colorDepth({ FORCE_COLOR: "" }, undefined), 4)
  assert.equal(colorDepth({}, { isTTY: true, getColorDepth: () => 8 }), 8)
  assert.equal(colorDepth({}, { isTTY: true, getColorDepth: () => 1 }), 0)
  assert.equal(colorDepth({ TERM: "dumb" }, { isTTY: true, getColorDepth: () => 24 }), 0)
  // A piped stream has no getColorDepth; without FORCE_COLOR it is not colored at all.
  assert.equal(colorDepth({}, { isTTY: false }), 0)
})

test("priceRamp places paid prices on a log scale, free ones at 0, and leaves nothing to compare uncolored", () => {
  const ramp = priceRamp([0, 0.5, 5, 50])

  assert.equal(ramp(0), 0)
  assert.equal(ramp(0.5), 0)
  assert.equal(ramp(5), 0.5)
  assert.equal(ramp(50), 1)
  assert.equal(ramp(undefined), undefined)
  // One paid price beside a free one still spans the scale; a single price, or only free ones, does not.
  assert.equal(priceRamp([0, 10])(10), 1)
  assert.equal(priceRamp([10, 10])(10), undefined)
  assert.equal(priceRamp([0, 0])(0), undefined)
  assert.equal(priceRamp([])(3), undefined)
})

test("rampShade runs green to red: thirds on 16 colors, eight cube stops on 256, interpolated RGB on 24-bit", () => {
  assert.deepEqual([0, 0.32, 0.5, 0.67, 1].map((position) => rampShade(position, 4)), ["32", "32", "33", "31", "31"])
  // Each cube stop starts at its position: green, olive, amber at 0.65, orange at 0.8, red at 0.9.
  assert.deepEqual(
    [0, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 1].map((position) => rampShade(position, 8)),
    ["38;5;28", "38;5;64", "38;5;100", "38;5;136", "38;5;130", "38;5;166", "38;5;160", "38;5;160"],
  )
  // On 24-bit each anchor is pure at its own position, and colors between them blend.
  assert.equal(rampShade(0, 24), "38;2;42;157;74")
  assert.equal(rampShade(0.65, 24), "38;2;167;125;0")
  assert.equal(rampShade(0.8, 24), "38;2;192;101;26")
  assert.equal(rampShade(1, 24), "38;2;215;58;58")
  assert.equal(rampShade(0.9, 24), "38;2;204;80;42")
})

test("colorText takes a tone or a shade and writes nothing extra with color off", () => {
  assert.equal(colorText("$4/$20", "38;5;178", true), "\u001b[38;5;178m$4/$20\u001b[0m")
  assert.equal(colorText("ok", "good", true), "\u001b[32mok\u001b[0m")
  assert.equal(colorText("$4/$20", "38;5;178", false), "$4/$20")
})

test("boldText and a heading's title are bold only with color on", () => {
  // SGR 22 ends bold alone, so a color around the bold text stays on.
  assert.equal(boldText("Copilot models", true), "\u001b[1mCopilot models\u001b[22m")
  assert.equal(boldText("Copilot models", false), "Copilot models")
  assert.equal(heading("Copilot models", "35", true), "\u001b[1mCopilot models\u001b[22m · 35")
  assert.equal(heading("Copilot models", "35"), "Copilot models · 35")
})

interface Row {
  id: string
  price: string
  slot: boolean
}

const columns: Array<TableColumn<Row>> = [
  { header: "MODEL", align: "left", cell: (row) => row.id, bold: (row) => row.slot },
  { header: "COST", align: "right", cell: (row) => row.price, tone: (row) => row.price === "$40" ? "38;5;166" : undefined },
]

test("renderTable bolds the header row and chosen cells with color on, and the plain text stays the same", () => {
  const rows: Array<Row> = [{ id: "gpt-6.2-astra", price: "$40", slot: true }, { id: "grok-4.7", price: "$6", slot: false }]
  const colored = renderTable(columns, rows, true)

  assert.deepEqual(colored.map((line) => stripVTControlCharacters(line)), renderTable(columns, rows, false))
  assert.equal(colored[0], "  \u001b[1mMODEL\u001b[22m          \u001b[1mCOST\u001b[22m")
  // COST is right-aligned under its four-column header, so $40 has one space before it.
  assert.equal(colored[1], "  \u001b[1mgpt-6.2-astra\u001b[22m   \u001b[38;5;166m$40\u001b[0m")
  assert.equal(colored[2], "  grok-4.7         $6")
  assert.ok(renderTable(columns, rows, false).every((line) => !line.includes("\u001b")))
})
