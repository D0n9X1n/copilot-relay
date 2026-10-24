// Codex CLI and app setup at start: point Codex at this relay with no ChatGPT sign-in, and give it
// the two-model catalog. Only the relay's provider table and three top-level keys are written;
// everything else in config.toml is left as it is.
import fs from "node:fs/promises"
import path from "node:path"

import { readFileSnapshot, writeFileSnapshot } from "~/lib/atomic-file"
import { buildCodexCatalog, readCodexVendorFiles, type CatalogModel } from "./catalog"

export const codexProviderId = "copilot-relay"

export interface CodexConfigInput {
  // The relay's inbound apiKey; Codex sends it as x-api-key when set.
  apiKey?: string
  // The relay's base URL without /v1.
  baseUrl: string
  catalogPath: string
  // Model IDs the catalog lists, the first being the default.
  models: Array<string>
}

export interface CodexSetupInput extends Omit<CodexConfigInput, "models"> {
  codexHome: string
  models: Array<CatalogModel>
}

export interface CodexSetupResult {
  configPath: string
  // Codex is not installed for this user: $CODEX_HOME does not exist, so nothing was written.
  skipped: boolean
  changed: boolean
}

/** config.toml holds the relay's provider in a form the relay will not rewrite safely. */
export class CodexConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CodexConfigError"
  }
}

const tomlString = (value: string): string => JSON.stringify(value)

// A TOML key or table path as its parts, with quotes and spaces removed.
const keyPath = (key: string): Array<string> =>
  key.split(".").map((part) => part.trim().replace(/^(["'])(.*)\1$/, "$2"))

const headerPattern = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/
const keyPattern = /^\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=/

const isProviderPath = (parts: Array<string>): boolean =>
  parts[0] === "model_providers" && parts[1] === codexProviderId

// The number of times a triple-quoted string opens or closes on a line.
const tripleQuotes = (line: string): number =>
  (line.match(/"""|'''/g) ?? []).length

interface ParsedLine {
  text: string
  // The table this line belongs to, as its path parts; [] before the first header.
  table: Array<string>
  header: boolean
  // Inside a multi-line string, where nothing is a header or a key.
  inString: boolean
}

const parseLines = (lines: Array<string>): Array<ParsedLine> => {
  const parsed: Array<ParsedLine> = []
  let table: Array<string> = []
  let inString = false
  for (const text of lines) {
    const header = !inString ? headerPattern.exec(text) : null
    if (header) {
      table = keyPath(header[1]!)
    }

    parsed.push({ text, table, header: header !== null, inString })
    if (tripleQuotes(text) % 2 === 1) {
      inString = !inString
    }
  }

  return parsed
}

const providerBlock = (input: CodexConfigInput): Array<string> => [
  `[model_providers.${codexProviderId}]`,
  "# Written by copilot-relay start (codexSetup); edits in this table are replaced on the next start.",
  `name = ${tomlString(codexProviderId)}`,
  `base_url = ${tomlString(`${input.baseUrl}/v1`)}`,
  "wire_api = \"responses\"",
  "requires_openai_auth = false",
  "supports_websockets = false",
  ...(input.apiKey ? [`http_headers = { "x-api-key" = ${tomlString(input.apiKey)} }`] : []),
]

const topLevelValue = (line: string, key: string): string | undefined => {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(line)
  return match ? (match[1] ?? match[2]) : undefined
}

/**
 * config.toml with the relay's provider selected.
 *
 * Sets the top-level model_provider and model_catalog_json, and model when it does not already name
 * one of the catalog's models. Replaces the [model_providers.copilot-relay] table, or appends it.
 * Refuses when that provider is also defined some other way, such as with dotted keys or an inline
 * table, which it could not replace without leaving two definitions.
 */
export const editCodexConfig = (text: string, input: CodexConfigInput): string => {
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const parsed = parseLines(text.length === 0 ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/))

  for (const [index, line] of parsed.entries()) {
    if (line.inString || line.header || isProviderPath(line.table)) {
      continue
    }

    const key = keyPattern.exec(line.text)
    if (key && isProviderPath([...line.table, ...keyPath(key[1]!)])) {
      throw new CodexConfigError(
        `config.toml line ${index + 1} defines model_providers.${codexProviderId} outside its own table; move it into [model_providers.${codexProviderId}] or remove it.`,
      )
    }
  }

  // Drop the managed table and its subtables; they are written fresh at the end.
  const kept = parsed.filter((line) => !isProviderPath(line.table))
  const lines = kept.map((line) => line.text)
  let firstHeader = kept.findIndex((line) => line.header)
  if (firstHeader === -1) {
    firstHeader = lines.length
  }

  const currentModel = lines
    .slice(0, firstHeader)
    .map((line) => topLevelValue(line, "model"))
    .find((value) => value !== undefined)
  const model = currentModel !== undefined && input.models.includes(currentModel) ? currentModel : input.models[0]!

  const settings: Array<[string, string]> = [
    ["model_provider", tomlString(codexProviderId)],
    ["model_catalog_json", tomlString(input.catalogPath)],
    ["model", tomlString(model)],
  ]
  const inserted: Array<string> = []
  for (const [key, value] of settings) {
    const pattern = new RegExp(`^\\s*${key}\\s*=`)
    const existing = lines.slice(0, firstHeader).findIndex((line) => pattern.test(line))
    if (existing === -1) {
      inserted.push(`${key} = ${value}`)
    } else {
      lines[existing] = `${key} = ${value}`
    }
  }

  if (inserted.length > 0) {
    // New keys go after the last top-level line, before the blank lines that end the region.
    let insertAt = firstHeader
    while (insertAt > 0 && lines[insertAt - 1]!.trim() === "") {
      insertAt--
    }

    const needsGap = insertAt === firstHeader && firstHeader < lines.length
    lines.splice(insertAt, 0, ...inserted, ...(needsGap ? [""] : []))
  }

  while (lines.length > 0 && lines.at(-1)!.trim() === "") {
    lines.pop()
  }

  const block = providerBlock(input)
  const result = lines.length > 0 ? [...lines, "", ...block] : block
  return result.join(eol) + eol
}

const writeIfChanged = async (filePath: string, content: string, ownerOnly: boolean): Promise<boolean> => {
  const snapshot = await readFileSnapshot(filePath)
  if (snapshot.raw === content) {
    return false
  }

  await writeFileSnapshot(snapshot, content, { ownerOnly })
  return true
}

/**
 * Sets up Codex for this relay when Codex is installed, that is when $CODEX_HOME exists.
 *
 * Writes the two-model catalog, then config.toml. Neither file is rewritten when it is already
 * current. config.toml is published owner-only when it holds the apiKey.
 */
export const applyCodexSetup = async (input: CodexSetupInput): Promise<CodexSetupResult> => {
  const configPath = path.join(input.codexHome, "config.toml")
  const home = await fs.stat(input.codexHome).catch(() => undefined)
  if (!home?.isDirectory()) {
    return { configPath, skipped: true, changed: false }
  }

  const catalog = buildCodexCatalog(input.models, await readCodexVendorFiles())
  await fs.mkdir(path.dirname(input.catalogPath), { recursive: true })
  const catalogChanged = await writeIfChanged(input.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, false)

  const snapshot = await readFileSnapshot(configPath)
  const next = editCodexConfig(snapshot.raw ?? "", { ...input, models: input.models.map((model) => model.id) })
  const configChanged = await writeIfChanged(configPath, next, Boolean(input.apiKey))

  return { configPath, skipped: false, changed: catalogChanged || configChanged }
}
