import assert from "node:assert/strict"
import test from "node:test"

import {
  renderConfigGuide,
  renderModelRows,
  searchModels,
  type ConfiguredModel,
  type ListedModel,
} from "../../src/lib/model-listing"

// The relevant part of a live catalog: the display names come from Copilot (#139).
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

test("rows start with the exact ID and align the display name or route note after it", () => {
  assert.deepEqual(renderModelRows([
    { id: "bare-model" },
    { id: "gpt-6-astra", name: "GPT-6 Astra" },
    { id: "text-embedding-ada-002", unusable: "Not a chat model" },
  ]), [
    "bare-model",
    `gpt-6-astra${" ".repeat(13)}GPT-6 Astra`,
    "text-embedding-ada-002  cannot be gptModel or opusModel: not a chat model",
  ])

  assert.deepEqual(
    renderModelRows([{ id: "completion", name: "Completion", unusable: "Not a chat model" }]),
    ["completion  Completion · cannot be gptModel or opusModel: not a chat model"],
  )

  // An ID wider than the column moves only its own details.
  const longId = "x".repeat(45)

  assert.deepEqual(renderModelRows([{ id: longId, name: "Long" }, { id: "short", name: "Short" }]), [
    `${longId}  Long`,
    `short${" ".repeat(37)}Short`,
  ])
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
    "  Warning: gptModel gpt-6-astra-fast is not advertised by upstream; the startup check rejects it.",
    "  Warning: opusModel text-embedding-ada-002 cannot be used (not a chat model); the startup check rejects it.",
    "Set gptModel or opusModel to a chat model ID exactly as listed.",
    "A running relay applies the change to new requests; restarting reruns the startup check.",
  ])

  assert.deepEqual(renderConfigGuide("config.yaml", configured, { id: "gpt-5.6-sol-fast" }).slice(-3), [
    "To use gpt-5.6-sol-fast, set this line in the config file:",
    "  gptModel: gpt-5.6-sol-fast",
    "A running relay applies the change to new requests; restarting reruns the startup check.",
  ])

  // An ID containing "opus" is offered as opusModel, matching how requests are routed.
  assert.deepEqual(renderConfigGuide("config.yaml", configured, { id: "claude-opus-5.5" }).slice(-3, -1), [
    "To use claude-opus-5.5, set this line in the config file:",
    "  opusModel: claude-opus-5.5",
  ])

  const current: ConfiguredModel[] = [{ key: "gptModel", value: "gpt-6-astra", advertised: true }]

  assert.ok(renderConfigGuide("config.yaml", current, { id: "gpt-6-astra" }).includes("gptModel already uses gpt-6-astra."))
})
