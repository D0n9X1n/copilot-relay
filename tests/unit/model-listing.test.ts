import assert from "node:assert/strict"
import test from "node:test"
import { stripVTControlCharacters } from "node:util"

import {
  renderConfigGuide,
  renderModelRows,
  searchModels,
  type ConfiguredModel,
  type ListedModel,
} from "../../src/lib/model-listing"
import { displayWidth } from "../../src/lib/terminal"

// The relevant part of a live catalog: the display names come from Copilot.
const catalog: ListedModel[] = [
  { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
  { id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  { id: "gpt-5.6-sol-fast", name: "GPT-5.6 Sol Fast (Internal only)" },
  { id: "gpt-6-astra", name: "GPT-6 Astra" },
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
  { id: "text-embedding-ada-002", unusable: "Not a chat model" },
]

const ids = (models: ListedModel[]) => models.map((model) => model.id)

test("search matches IDs and display names, ignoring case, spaces and punctuation", () => {
  const cases: Array<[search: string, expected: string[]]> = [
    ["sol fast", ["gpt-5.6-sol-fast"]],
    ["GPT 6.1", ["gpt-6.1-sol"]],
    ["gpt6", ["gpt-6-astra", "gpt-6.1-sol"]],
    ["internal", ["gpt-5.6-sol-fast"]],
    ["opus", ["claude-opus-5.5"]],
  ]

  for (const [search, expected] of cases) {
    const result = searchModels(catalog, search)

    assert.equal(result.found, true, search)
    assert.deepEqual(ids(result.models), expected, search)
  }
})

// The catalog has no gpt-6 fast model; the closest IDs show what it does have.
test("a search with no match suggests the IDs sharing its longest start and its longest end", () => {
  const result = searchModels(catalog, "gpt6-fast")

  assert.equal(result.found, false)
  assert.deepEqual(ids(result.models), ["gpt-5.6-sol-fast", "gpt-6-astra", "gpt-6.1-sol"])
  assert.equal(result.chosen, undefined)
  assert.deepEqual(searchModels(catalog, "unrelated-word").models, [])
})

test("a config line is offered only for an exact ID or the one usable match", () => {
  assert.equal(searchModels(catalog, "sol fast").chosen?.id, "gpt-5.6-sol-fast")
  // gpt-5.6-sol-fast also contains the search, but the exact ID wins.
  assert.equal(searchModels(catalog, "GPT-5.6-SOL").chosen?.id, "gpt-5.6-sol")
  assert.equal(searchModels(catalog, "gpt6").chosen, undefined)
  assert.equal(searchModels(catalog, "ada").chosen, undefined)
})

test("the listing is a table of exact IDs, names, costs, context windows and notes", () => {
  assert.deepEqual(renderModelRows([
    { id: "bare-model", chat: true },
    { id: "gpt-6-astra", name: "GPT-6 Astra", chat: true, contextWindow: 1_050_000 },
    { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", chat: true, contextWindow: 200_000 },
    { id: "text-embedding-ada-002", chat: false, unusable: "Not a chat model" },
  ], false, true), [
    "  MODEL                   NAME               COST    CONTEXT  NOTE",
    "  bare-model                                    –          –",
    "  gpt-6-astra             GPT-6 Astra           –  1.1M [1m]",
    "  claude-sonnet-5.5       Claude Sonnet 5.5     –       200K",
    "  text-embedding-ada-002                        –          –  ! not a chat model",
    "",
    "! marks a model that cannot be gptModel or opusModel.",
  ])
})

test("the listing shows each model's cost and which slot uses it", () => {
  assert.deepEqual(renderModelRows([
    { id: "claude-opus-5.5", name: "Claude Opus 5.5", chat: true, contextWindow: 1_000_000, price: { input: 4, output: 20 }, slot: "opusModel" },
    { id: "gpt-6.2-astra", name: "GPT-6.2 Astra", chat: true, contextWindow: 1_050_000, price: { input: 8, output: 40 }, slot: "gptModel" },
    { id: "gpt-4.1", name: "GPT-4.1", chat: true, contextWindow: 128_000, price: { input: 0, output: 0 } },
    { id: "grok-4.7", name: "Grok 4.7", chat: true, multiplier: 0.33 },
    { id: "bare-model", chat: true },
  ], false, true), [
    "  MODEL            NAME               COST    CONTEXT  SLOT",
    "  claude-opus-5.5  Claude Opus 5.5  $4/$20    1M [1m]  ◀ opusModel",
    "  gpt-6.2-astra    GPT-6.2 Astra    $8/$40  1.1M [1m]  ◀ gptModel",
    "  gpt-4.1          GPT-4.1           $0/$0       128K",
    "  grok-4.7         Grok 4.7          0.33×          –",
    "  bare-model                             –          –",
  ])
})

test("NAME shows every name whole or is left out; an ID is never cut", () => {
  const longId = "x".repeat(70)
  const withLongId = renderModelRows([
    { id: longId, name: "Long", chat: true },
    { id: "short", name: "Short", chat: true },
  ], false, true)

  // A 70-column ID leaves no room for NAME, so the column is left out rather than cut.
  assert.ok(withLongId[0].startsWith("  MODEL "))
  assert.ok(!withLongId[0].includes("NAME"))
  assert.match(withLongId[1], new RegExp(`^ {2}${longId} +– +–$`))

  const withLongName = renderModelRows([
    { id: "short", name: "A display name far longer than any eighty-column line could show beside it", chat: true },
  ], false, true)
  assert.ok(!withLongName[0].includes("NAME"))
  assert.ok(!withLongName.some((line) => line.includes("…")), "no name is shown cut")
})

test("NAME is left out when Opus names would lose what tells them apart", () => {
  const lines = renderModelRows([
    { id: "claude-opus-5.5", name: "Claude Opus 5.5", chat: true, contextWindow: 200_000, price: { input: 5, output: 25 }, slot: "opusModel" },
    { id: "claude-opus-5.5-1m", name: "Claude Opus 5.5 (1M)", chat: true, contextWindow: 1_000_000, price: { input: 10, output: 37.5 }, unusable: "Protocol policy conflict" },
    { id: "gpt-6.2-astra", name: "GPT-6.2 Astra", chat: true, contextWindow: 400_000, price: { input: 1.25, output: 10 }, slot: "gptModel" },
  ], false, true)

  for (const line of lines) {
    assert.ok(displayWidth(line) <= 80, `${displayWidth(line)} columns: ${line}`)
    assert.ok(!line.includes("…"), `cut cell: ${line}`)
  }

  assert.equal(lines[0], "  MODEL                    COST  CONTEXT  NOTE")
  assert.equal(lines[2], "  claude-opus-5.5-1m  $10/$37.5  1M [1m]  ! protocol policy conflict")
})

test("slots and marks share the last column, so a listing with both fits 80 columns", () => {
  const lines = renderModelRows([
    { id: "claude-opus-5.5", name: "Claude Opus 5.5", chat: true, contextWindow: 1_000_000, price: { input: 4, output: 20 }, slot: "opusModel" },
    { id: "gpt-6.2-astra", name: "GPT-6.2 Astra", chat: true, contextWindow: 1_050_000, price: { input: 8, output: 40 }, slot: "gptModel" },
    { id: "text-embedding-ada-002", name: "Embedding V2 Ada", chat: false, unusable: "Not a chat model" },
  ], false, true)

  for (const line of lines) {
    assert.ok(displayWidth(line) <= 80, `${displayWidth(line)} columns: ${line}`)
  }

  // Whole, the names would need 82 columns here, so NAME is left out rather than cut.
  assert.equal(lines[0], "  MODEL                     COST    CONTEXT  NOTE")
  assert.equal(lines[1], "  claude-opus-5.5         $4/$20    1M [1m]  ◀ opusModel")
  assert.equal(lines[3], "  text-embedding-ada-002       –          –  ! not a chat model")
  // A configured ID that cannot be used shows its slot and its mark.
  assert.match(renderModelRows([{ id: "ada", chat: false, unusable: "Not a chat model", slot: "gptModel" }], false, true)[1], /◀ gptModel {2}! not a chat model$/)
})

// Costs of every width, a multiplier, missing values, and a configured model that cannot be used.
const mixedListing: ListedModel[] = [
  { id: "claude-opus-5.5", name: "Claude Opus 5.5", chat: true, contextWindow: 200_000, price: { input: 5, output: 25 }, slot: "opusModel" },
  { id: "claude-opus-5.5-1m", name: "Claude Opus 5.5 (1M)", chat: true, contextWindow: 1_000_000, price: { input: 10, output: 37.5 }, unusable: "Protocol policy conflict" },
  { id: "gpt-5-mini", name: "GPT-5 mini", chat: true, multiplier: 0.33 },
  { id: "gpt-6.2-astra", name: "GPT-6.2 Astra", chat: true, contextWindow: 400_000, price: { input: 1.25, output: 10 } },
  { id: "text-embedding-ada-002", name: "Embedding V2 Ada", chat: false, unusable: "Not a chat model", slot: "gptModel" },
  { id: "bare-model", chat: true },
]

test("without Unicode the listing prints only ASCII, with COST right-aligned like the other numbers", () => {
  const lines = renderModelRows(mixedListing, false, false)

  assert.deepEqual(lines, [
    "  MODEL                        COST  CONTEXT  NOTE",
    "  claude-opus-5.5            $5/$25     200K  < opusModel",
    "  claude-opus-5.5-1m      $10/$37.5  1M [1m]  ! protocol policy conflict",
    "  gpt-5-mini                  0.33x        -",
    "  gpt-6.2-astra           $1.25/$10     400K",
    "  text-embedding-ada-002          -        -  < gptModel  ! not a chat model",
    "  bare-model                      -        -",
    "",
    "! marks a model that cannot be gptModel or opusModel.",
  ])

  for (const line of lines) {
    assert.match(line, /^[\x20-\x7e]*$/, line)
  }
})

test("with Unicode the same listing marks slots, multipliers and missing values with symbols", () => {
  const lines = renderModelRows(mixedListing, false, true)

  assert.equal(lines[1], "  claude-opus-5.5            $5/$25     200K  ◀ opusModel")
  assert.equal(lines[3], "  gpt-5-mini                  0.33×        –")
  assert.equal(lines[5], "  text-embedding-ada-002          –        –  ◀ gptModel  ! not a chat model")
})

test("a note too wide for its row prints whole on its own line under the row, its ID whole", () => {
  for (const unicode of [true, false]) {
    const lines = renderModelRows([
      { id: "claude-opus-5.5-1m", name: "Claude Opus 5.5 (1M)", chat: true, contextWindow: 1_000_000, price: { input: 10, output: 37.5 }, unusable: "Protocol policy conflict", slot: "opusModel" },
      { id: "gpt-6.2-astra", name: "GPT-6.2 Astra", chat: true, contextWindow: 400_000, price: { input: 1.25, output: 10 }, slot: "gptModel" },
      { id: "text-embedding-ada-002", name: "Embedding V2 Ada", chat: false, unusable: "Not a chat model" },
    ], false, unicode)
    const slot = unicode ? "◀" : "<"
    const dash = unicode ? "–" : "-"

    for (const line of lines) {
      assert.ok(displayWidth(line) <= 80, `${displayWidth(line)} columns: ${line}`)
    }

    assert.deepEqual(lines.slice(0, 5), [
      "  MODEL                        COST  CONTEXT  NOTE",
      "  claude-opus-5.5-1m      $10/$37.5  1M [1m]",
      `    ${slot} opusModel  ! protocol policy conflict`,
      `  gpt-6.2-astra           $1.25/$10     400K  ${slot} gptModel`,
      `  text-embedding-ada-002          ${dash}        ${dash}  ! not a chat model`,
    ])
  }
})

test("beside a 52-column ID, a configured model keeps its whole slot and mark, and ASCII has no ellipsis", () => {
  const longId = `claude-opus-${"z".repeat(40)}`
  const lines = renderModelRows([
    { id: longId, chat: true, contextWindow: 1_000_000, price: { input: 10, output: 37.5 }, unusable: "Protocol policy conflict", slot: "opusModel" },
    { id: "text-embedding-ada-002", chat: false, unusable: "Not a chat model" },
  ], false, false)

  assert.equal(longId.length, 52)
  assert.ok(lines.includes(`  ${longId}  $10/$37.5  1M [1m]`), lines.join("\n"))
  assert.ok(lines.includes("    < opusModel  ! protocol policy conflict"), lines.join("\n"))
  assert.ok(lines.includes("    ! not a chat model"), lines.join("\n"))
  for (const line of lines) {
    assert.ok(displayWidth(line) <= 80, `${displayWidth(line)} columns: ${line}`)
    assert.match(line, /^[\x20-\x7e]*$/, line)
  }
})

test("the config guide shows the current routes and warns about values the startup check rejects", () => {
  const configured: ConfiguredModel[] = [
    { key: "gptModel", value: "gpt-6-astra-fast", advertised: false },
    { key: "opusModel", value: "text-embedding-ada-002", advertised: true, unusable: "Not a chat model" },
  ]

  assert.deepEqual(renderConfigGuide("/home/me/.copilot-relay/config.yaml", configured), [
    "Config file: /home/me/.copilot-relay/config.yaml",
    `  gptModel: gpt-6-astra-fast${" ".repeat(9)}# requests without "opus" in the model name`,
    "  opusModel: text-embedding-ada-002  # requests with \"opus\" in the model name",
    "  Warning: gptModel gpt-6-astra-fast is not advertised by upstream.",
    "  Warning: opusModel text-embedding-ada-002 cannot be used (not a chat model).",
    "  The startup check rejects these values.",
    "Set gptModel or opusModel to a chat model ID exactly as listed.",
    "A running relay uses the change for new requests; a restart rechecks it.",
  ])

  assert.deepEqual(renderConfigGuide("config.yaml", configured, { id: "gpt-5.6-sol-fast" }).slice(-3), [
    "To use gpt-5.6-sol-fast, set this line in the config file:",
    "  gptModel: gpt-5.6-sol-fast",
    "A running relay uses the change for new requests; a restart rechecks it.",
  ])

  // An ID containing "opus" is offered as opusModel, matching how requests are routed.
  assert.deepEqual(renderConfigGuide("config.yaml", configured, { id: "claude-opus-5.5" }).slice(-3, -1), [
    "To use claude-opus-5.5, set this line in the config file:",
    "  opusModel: claude-opus-5.5",
  ])

  const current: ConfiguredModel[] = [{ key: "gptModel", value: "gpt-6-astra", advertised: true }]

  assert.ok(renderConfigGuide("config.yaml", current, { id: "gpt-6-astra" }).includes("gptModel already uses gpt-6-astra."))
})

// The live catalog's spread: free legacy models, then paid output prices from $0.5 to $50 per 1M.
const priced: ListedModel[] = [
  { id: "gpt-4o", name: "GPT-4o", chat: true, price: { input: 0, output: 0 } },
  { id: "claude-haiku-5.5", name: "Claude Haiku 5.5", chat: true, price: { input: 0.1, output: 0.5 } },
  { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", chat: true, price: { input: 2, output: 10 } },
  { id: "claude-opus-5.5", name: "Claude Opus 5.5", chat: true, price: { input: 4, output: 20 }, slot: "opusModel" },
  { id: "gpt-6-astra", name: "GPT-6 Astra", chat: true, price: { input: 10, output: 50 } },
  { id: "grok-4.7", name: "Grok 4.7", chat: true, multiplier: 1 },
]

const costShade = (line: string): string | undefined => /\u001b\[([\d;]+)m\$/.exec(line)?.[1]

test("COST is colored by output price from green to red, a log scale with free at the green end", () => {
  const lines = renderModelRows(priced, 8, true)
  const shade = (id: string) => costShade(lines.find((line) => stripVTControlCharacters(line).includes(` ${id} `))!)

  assert.equal(shade("gpt-4o"), "38;5;28")
  assert.equal(shade("claude-haiku-5.5"), "38;5;28")
  assert.equal(shade("claude-sonnet-5.5"), "38;5;130")
  assert.equal(shade("claude-opus-5.5"), "38;5;166")
  assert.equal(shade("gpt-6-astra"), "38;5;160")
  // A multiplier is another unit, so it is not placed on the dollar scale.
  assert.doesNotMatch(lines.find((line) => line.includes("grok-4.7"))!, /\u001b\[[\d;]+m1/)
})

test("COST falls back to three bands on 16 colors and is plain with color off", () => {
  const sixteen = renderModelRows(priced, true, true)

  assert.deepEqual(
    ["gpt-4o", "claude-sonnet-5.5", "gpt-6-astra"].map((id) => costShade(sixteen.find((line) => stripVTControlCharacters(line).includes(` ${id} `))!)),
    ["32", "33", "31"],
  )
  assert.deepEqual(sixteen.map((line) => stripVTControlCharacters(line)), renderModelRows(priced, false, true))
  assert.ok(renderModelRows(priced, false, true).every((line) => !line.includes("\u001b")))
})

test("the configured model's ID is bold and the header names are bold", () => {
  const lines = renderModelRows(priced, 24, true)

  assert.match(lines[0], /^ {2}\u001b\[1mMODEL\u001b\[22m/)
  assert.ok(lines.some((line) => line.startsWith("  \u001b[1mclaude-opus-5.5\u001b[22m")))
  assert.ok(lines.some((line) => line.startsWith("  claude-sonnet-5.5 ")))
})
