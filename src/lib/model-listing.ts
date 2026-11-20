// What `copilot-relay models` prints: each advertised ID next to the config lines that use it,
// so a reader can tell what to put in gptModel or opusModel.
import { columnWidths, formatTokens, mark, renderTable, unicodeEnabled, type TableColumn } from "./terminal"

export interface ListedModel {
  // The exact upstream ID, which is the value gptModel or opusModel takes.
  id: string
  // The catalog's display name, when it has one.
  name?: string
  // Why request admission refuses this ID, as a probe result label; absent when it is routable.
  unusable?: string
  // False for a model the catalog says is not a chat model; the plain listing hides those.
  chat?: boolean
  // The catalog's context window in tokens, when it reports one.
  contextWindow?: number
  // USD per million input and output tokens, when the catalog reports token prices.
  price?: { input: number; output: number }
  // Premium requests per call, when the catalog reports only a multiplier.
  multiplier?: number
  // The config key that routes to this ID, when one does.
  slot?: ModelKey
}

export type ModelKey = "gptModel" | "opusModel"

// A price keeps the digits the catalog sent: whole dollars as "$8", cents as "$0.4".
const dollars = (value: number): string => `$${value}`

// What a call costs, from what the catalog reports: token prices first, then a multiplier, else a dash.
const costOf = (model: ListedModel): string => {
  if (model.price !== undefined) {
    return `${dollars(model.price.input)}/${dollars(model.price.output)}`
  }

  return model.multiplier === undefined ? "–" : `${model.multiplier}×`
}

export interface ConfiguredModel {
  key: ModelKey
  value: string
  advertised: boolean
  unusable?: string
}

export interface ModelSearch {
  // Whether every listed model contains the search; when false, the closest IDs are listed instead.
  found: boolean
  models: ListedModel[]
  // The one routable model the search names, which gets a config line to copy.
  chosen?: ListedModel
}

// A search compares letters and digits only, so "GPT 5.6 sol fast" finds gpt-5.6-sol-fast.
export const normalizeModelSearch = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9]/g, "")

const contains = (model: ListedModel, fragment: string): boolean =>
  normalizeModelSearch(model.id).includes(fragment)
  || normalizeModelSearch(model.name ?? "").includes(fragment)

// Shorter fragments, such as "gpt", match most of a catalog and narrow nothing down.
const minimumFragment = 4

const firstMatches = (models: ListedModel[], fragments: string[]): ListedModel[] => {
  for (const fragment of fragments) {
    const matches = models.filter((model) => contains(model, fragment))

    if (matches.length > 0) {
      return matches
    }
  }

  return []
}

// Without a full match, the closest IDs share the search's longest start or its longest end, so
// "gpt6-fast" suggests both the gpt-6 models and the fast one.
const closestModels = (models: ListedModel[], search: string): ListedModel[] => {
  const starts: string[] = []
  const ends: string[] = []

  for (let length = search.length - 1; length >= minimumFragment; length--) {
    starts.push(search.slice(0, length))
    ends.push(search.slice(search.length - length))
  }

  const near = new Set([...firstMatches(models, starts), ...firstMatches(models, ends)])

  return models.filter((model) => near.has(model))
}

export const searchModels = (models: ListedModel[], search: string): ModelSearch => {
  const wanted = normalizeModelSearch(search)
  const matches = models.filter((model) => contains(model, wanted))

  if (matches.length === 0) {
    return { found: false, models: closestModels(models, wanted) }
  }

  const usable = matches.filter((model) => model.unusable === undefined)
  // An exact ID wins over the longer IDs that contain it.
  const exact = usable.find((model) => normalizeModelSearch(model.id) === wanted)
  const chosen = exact ?? (usable.length === 1 ? usable[0] : undefined)

  return { found: true, models: matches, chosen }
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

// The window the relay offers: a known window of at least 1M carries [1m], the suffix Claude Code
// reads as a 1M model.
const contextOf = (model: ListedModel): string => {
  if (model.contextWindow === undefined) {
    return "–"
  }

  const size = formatTokens(model.contextWindow)
  return model.contextWindow >= 1_000_000 ? `${size} [1m]` : size
}

// The table's line budget: a two-space indent and a two-space gutter between columns.
const lineWidth = 80
const indent = 2
const gutter = 2
const nameColumn = 1

// The last column: the config key that names this ID, then why it cannot be one, if it cannot.
const noteOf = (model: ListedModel, unicode: boolean): string => {
  const parts: string[] = []

  if (model.slot !== undefined) {
    parts.push(`◀ ${model.slot}`)
  }

  if (model.unusable !== undefined) {
    parts.push(`${mark("warn", unicode)} ${lowerFirst(model.unusable)}`)
  }

  return parts.join("  ")
}

/**
 * The listing as a table. MODEL is the exact ID, the value config.yaml takes, and is never cut so
 * it can be copied. NAME is shown only when every name fits whole on an 80-column line: a cut name
 * such as "Claude Op…" loses what tells two models apart, and MODEL already names each one. The
 * last column shares one place for the
 * slot an ID fills and the mark on an ID that cannot be gptModel or opusModel, so a listing with
 * both stays within 80 columns; the mark does not rely on color.
 */
export const renderModelRows = (models: ListedModel[], color = false, unicode = unicodeEnabled()): string[] => {
  const columns: Array<TableColumn<ListedModel>> = [
    { header: "MODEL", align: "left", cell: (model) => model.id },
    { header: "NAME", align: "left", cell: (model) => model.name ?? "" },
    { header: "COST", align: "left", cell: costOf },
    { header: "CONTEXT", align: "right", cell: contextOf },
  ]
  const anyUnusable = models.some((model) => model.unusable !== undefined)

  // SLOT when the column holds only slots; NOTE once it also explains a mark.
  if (anyUnusable || models.some((model) => model.slot !== undefined)) {
    columns.push({
      header: anyUnusable ? "NOTE" : "SLOT",
      align: "left",
      cell: (model) => noteOf(model, unicode),
      tone: (model) => model.unusable === undefined ? undefined : "warning",
    })
  }

  // NAME stays only when the longest name fits in the columns the others leave; an ID is never cut,
  // so a long one can still push a row past 80.
  const widths = columnWidths(columns, models)
  const others = widths.filter((_width, index) => index !== nameColumn)
  const room = lineWidth - indent - gutter * (columns.length - 1) - others.reduce((sum, width) => sum + width, 0)
  if (widths[nameColumn] > room) {
    columns.splice(nameColumn, 1)
  }

  const lines = renderTable(columns, models, color)
  // NOTE keeps the reason short so the row fits; this line says what the mark means.
  if (anyUnusable) {
    lines.push("", `${mark("warn", unicode)} marks a model that cannot be gptModel or opusModel.`)
  }

  return lines
}

const routes: Record<ModelKey, string> = {
  gptModel: "requests without \"opus\" in the model name",
  opusModel: "requests with \"opus\" in the model name",
}

const applyNote = "A running relay uses the change for new requests; a restart rechecks it."

// Requests whose model name contains "opus" go to opusModel, so an Opus ID is offered there.
const keyFor = (id: string): ModelKey => id.toLowerCase().includes("opus") ? "opusModel" : "gptModel"

const problemOf = (model: ConfiguredModel): string | undefined => {
  if (!model.advertised) {
    return "is not advertised by upstream"
  }

  if (model.unusable !== undefined) {
    return `cannot be used (${lowerFirst(model.unusable)})`
  }

  return undefined
}

const settingOf = (model: ConfiguredModel): string => `${model.key}: ${model.value}`

// The config file, its current model lines, and what to change in it.
export const renderConfigGuide = (
  configPath: string,
  configured: ConfiguredModel[],
  chosen?: ListedModel,
): string[] => {
  const width = Math.max(...configured.map((model) => settingOf(model).length))
  const lines = [`Config file: ${configPath}`]

  for (const model of configured) {
    lines.push(`  ${settingOf(model).padEnd(width)}  # ${routes[model.key]}`)
  }

  let rejected = false
  for (const model of configured) {
    const problem = problemOf(model)

    if (problem !== undefined) {
      lines.push(`  Warning: ${model.key} ${model.value} ${problem}.`)
      rejected = true
    }
  }

  // Said once under the warnings, so each warning stays one short line.
  if (rejected) {
    lines.push("  The startup check rejects these values.")
  }

  if (chosen === undefined) {
    lines.push("Set gptModel or opusModel to a chat model ID exactly as listed.", applyNote)
    return lines
  }

  const key = keyFor(chosen.id)

  if (configured.some((model) => model.key === key && model.value === chosen.id)) {
    lines.push(`${key} already uses ${chosen.id}.`)
    return lines
  }

  lines.push(`To use ${chosen.id}, set this line in the config file:`, `  ${key}: ${chosen.id}`, applyNote)

  return lines
}
