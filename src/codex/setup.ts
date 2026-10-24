// Codex CLI and app setup at start: point Codex at this relay with no ChatGPT sign-in, and give it
// the two-model catalog. Only the relay's provider table and three top-level keys are written;
// everything else in config.toml is left as it is.
import fs from "node:fs/promises"
import path from "node:path"

import { parse, TomlError } from "smol-toml"

import { readFileSnapshot, writeFileSnapshot, type FileSnapshot } from "~/lib/atomic-file"
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

type TomlTable = Record<string, unknown>

const isTable = (value: unknown): value is TomlTable =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)

const tomlString = (value: string): string => JSON.stringify(value)

// Integers past JavaScript's safe range, such as a 64-bit byte limit, are valid TOML.
const parseOptions = { integersAsBigInt: "asNeeded" } as const

const providerPath = ["model_providers", codexProviderId]

// The provider table as config.toml lines, and as the value TOML reads from those lines.
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

const providerValue = (input: CodexConfigInput): TomlTable => ({
  name: codexProviderId,
  base_url: `${input.baseUrl}/v1`,
  wire_api: "responses",
  requires_openai_auth: false,
  supports_websockets: false,
  ...(input.apiKey ? { http_headers: { "x-api-key": input.apiKey } } : {}),
})

const isProviderPath = (parts: Array<string>): boolean =>
  providerPath.every((part, index) => parts[index] === part)

// Where the quote that opened just before `from` closes, or -1. Basic strings skip backslash escapes.
const findClose = (line: string, from: number, quote: string): number => {
  let at = from
  while (at < line.length) {
    if (quote === "\"" && line[at] === "\\") {
      at += 2
    } else if (line[at] === quote) {
      return at
    } else {
      at++
    }
  }

  return -1
}

const unescapeBasic = (raw: string): string => {
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return raw
  }
}

const skipSpace = (line: string, from: number): number => {
  let at = from
  while (line[at] === " " || line[at] === "\t") {
    at++
  }

  return at
}

const bareKey = /[A-Za-z0-9_-]+/y

// The dotted key starting at `start`, as its unquoted parts, and the index after it.
const readKey = (line: string, start: number): { parts: Array<string>; end: number } | undefined => {
  const parts: Array<string> = []
  let at = skipSpace(line, start)
  while (at < line.length) {
    const quote = line[at]!
    if (quote === "\"" || quote === "'") {
      const close = findClose(line, at + 1, quote)
      if (close === -1) {
        return undefined
      }

      const raw = line.slice(at + 1, close)
      parts.push(quote === "\"" ? unescapeBasic(raw) : raw)
      at = close + 1
    } else {
      bareKey.lastIndex = at
      const match = bareKey.exec(line)
      if (!match) {
        return undefined
      }

      parts.push(match[0])
      at = bareKey.lastIndex
    }

    at = skipSpace(line, at)
    if (line[at] !== ".") {
      return { parts, end: at }
    }

    at = skipSpace(line, at + 1)
  }

  return undefined
}

// A table header's path, or undefined when the line is not a header.
const readHeader = (line: string): Array<string> | undefined => {
  const open = /^\s*\[\[?/.exec(line)
  if (!open) {
    return undefined
  }

  const key = readKey(line, open[0].length)
  if (!key) {
    return undefined
  }

  const close = open[0].trimStart() === "[[" ? "]]" : "]"
  const rest = line.slice(key.end)
  if (!rest.startsWith(close) || !/^\s*(?:#.*)?$/.test(rest.slice(close.length))) {
    return undefined
  }

  return key.parts
}

// The key a `key = value` line assigns, or undefined for any other line.
const readAssignedKey = (line: string): Array<string> | undefined => {
  const key = readKey(line, 0)
  if (!key || line[key.end] !== "=") {
    return undefined
  }

  return key.parts
}

type StringState = "" | "\"\"\"" | "'''"

// The multi-line string delimiter still open at the end of a line, or "" when none is.
const stringStateAfter = (line: string, state: StringState): StringState => {
  let open = state
  let at = 0
  while (at < line.length) {
    const char = line[at]!
    if (open === "\"\"\"" && char === "\\") {
      at += 2
    } else if (open !== "" && line.startsWith(open, at)) {
      at += 3
      // A closing delimiter can be followed by up to two quotes that belong to the string.
      while (line[at] === open[0]) {
        at++
      }

      open = ""
    } else if (open !== "") {
      at++
    } else if (char === "#") {
      return ""
    } else if (line.startsWith("\"\"\"", at) || line.startsWith("'''", at)) {
      open = line.slice(at, at + 3) as StringState
      at += 3
    } else if (char === "\"" || char === "'") {
      const close = findClose(line, at + 1, char)
      at = close === -1 ? line.length : close + 1
    } else {
      at++
    }
  }

  return open
}

interface ParsedLine {
  text: string
  // The table this line belongs to, as its path parts; [] before the first header.
  table: Array<string>
  header: boolean
  // The key this line assigns, relative to its table.
  key?: Array<string>
}

// Each line with its table and, for a header or an assignment, what it names. A line inside a
// multi-line string names nothing.
const parseLines = (lines: Array<string>): Array<ParsedLine> => {
  const parsed: Array<ParsedLine> = []
  let table: Array<string> = []
  let state: StringState = ""
  for (const text of lines) {
    if (state !== "") {
      parsed.push({ text, table, header: false })
    } else {
      const header = readHeader(text)
      if (header) {
        table = header
      }

      const key = header ? undefined : readAssignedKey(text)
      parsed.push({ text, table, header: header !== undefined, ...(key && { key }) })
    }

    state = stringStateAfter(text, state)
  }

  return parsed
}

const parseToml = (text: string): TomlTable => {
  try {
    return parse(text, parseOptions) as TomlTable
  } catch (error) {
    if (error instanceof TomlError) {
      // The parser's message quotes the line, which can hold a credential, so only its number is kept.
      throw new CodexConfigError(`config.toml is not valid TOML (line ${error.line}); fix it, or set codexSetup: false.`)
    }

    throw error
  }
}

// A parsed TOML value in a form two parses can be compared by: every value tagged with its type, so
// a string never matches a number or a date, and table keys sorted.
const canonical = (value: unknown): unknown => {
  if (value instanceof Date) {
    return ["date", value.toISOString()]
  }

  if (Array.isArray(value)) {
    return ["array", value.map(canonical)]
  }

  if (isTable(value)) {
    return ["table", Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))]
  }

  if (typeof value === "number" && Object.is(value, -0)) {
    return ["number", "-0"]
  }

  return [typeof value, String(value)]
}

const sameToml = (left: TomlTable, right: TomlTable): boolean =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))

const parsesTo = (text: string): TomlTable | undefined => {
  try {
    return parse(text, parseOptions) as TomlTable
  } catch {
    return undefined
  }
}

/**
 * config.toml with the relay's provider selected.
 *
 * Sets the top-level model_provider and model_catalog_json, and model when it does not already name
 * one of the catalog's models. Replaces the [model_providers.copilot-relay] table, or appends it.
 * The edit works line by line so comments and layout stay, and is then checked by parsing: unless
 * the result reads as the original with only those values changed, it throws instead.
 */
export const editCodexConfig = (text: string, input: CodexConfigInput): string => {
  const original = parseToml(text)
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const parsed = parseLines(text.length === 0 ? [] : text.replace(/\r?\n$/, "").split(/\r?\n/))

  for (const [index, line] of parsed.entries()) {
    if (line.key === undefined || isProviderPath(line.table)) {
      continue
    }

    const assigned = [...line.table, ...line.key]
    if (isProviderPath(assigned)) {
      throw new CodexConfigError(
        `config.toml line ${index + 1} defines model_providers.${codexProviderId} outside its own table; move it into [model_providers.${codexProviderId}] or remove it.`,
      )
    }

    if (assigned.length === 1 && assigned[0] === "model_providers") {
      throw new CodexConfigError(
        `config.toml line ${index + 1} defines model_providers as an inline table, which cannot take a [model_providers.${codexProviderId}] table; write it as [model_providers.<name>] tables.`,
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

  const currentModel = typeof original.model === "string" ? original.model : undefined
  const model = currentModel !== undefined && input.models.includes(currentModel) ? currentModel : input.models[0]!

  const settings: Array<[string, string]> = [
    ["model_provider", codexProviderId],
    ["model_catalog_json", input.catalogPath],
    ["model", model],
  ]
  const inserted: Array<string> = []
  for (const [key, value] of settings) {
    const existing = kept.findIndex((line, index) => index < firstHeader && line.key?.length === 1 && line.key[0] === key)
    if (existing === -1) {
      inserted.push(`${key} = ${tomlString(value)}`)
    } else {
      lines[existing] = `${key} = ${tomlString(value)}`
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
  const result = (lines.length > 0 ? [...lines, "", ...block] : block).join(eol) + eol

  const otherProviders = isTable(original.model_providers) ? original.model_providers : {}
  const expected: TomlTable = {
    ...original,
    model_provider: codexProviderId,
    model_catalog_json: input.catalogPath,
    model,
    model_providers: { ...otherProviders, [codexProviderId]: providerValue(input) },
  }
  const actual = parsesTo(result)
  if (actual === undefined || !sameToml(actual, expected)) {
    throw new CodexConfigError(
      `config.toml could not be edited without changing other settings; add the ${codexProviderId} provider by hand, or set codexSetup: false.`,
    )
  }

  return result
}

// Publishes content to the file a snapshot read, unless it is already current. A file holding the
// apiKey is published owner-only, and published again when its mode lets other local users read it,
// even if its content is current. Windows has no POSIX mode bits.
const publish = async (snapshot: FileSnapshot, content: string, holdsKey: boolean): Promise<boolean> => {
  const keyExposed = holdsKey && process.platform !== "win32" && snapshot.raw !== null && (snapshot.mode & 0o077) !== 0
  if (snapshot.raw === content && !keyExposed) {
    return false
  }

  await writeFileSnapshot(snapshot, content, { ownerOnly: holdsKey })
  return true
}

/**
 * Sets up Codex for this relay when Codex is installed, that is when $CODEX_HOME exists.
 *
 * Writes the two-model catalog, then config.toml. Neither file is rewritten when it is already
 * current. config.toml is edited from the snapshot it is published against, so an edit saved in
 * between is refused as a conflict rather than lost.
 */
export const applyCodexSetup = async (input: CodexSetupInput): Promise<CodexSetupResult> => {
  const configPath = path.join(input.codexHome, "config.toml")
  const home = await fs.stat(input.codexHome).catch(() => undefined)
  if (!home?.isDirectory()) {
    return { configPath, skipped: true, changed: false }
  }

  const catalog = buildCodexCatalog(input.models, await readCodexVendorFiles())
  await fs.mkdir(path.dirname(input.catalogPath), { recursive: true })
  const catalogSnapshot = await readFileSnapshot(input.catalogPath)
  const catalogChanged = await publish(catalogSnapshot, `${JSON.stringify(catalog, null, 2)}\n`, false)

  const snapshot = await readFileSnapshot(configPath)
  const next = editCodexConfig(snapshot.raw ?? "", { ...input, models: input.models.map((model) => model.id) })
  const configChanged = await publish(snapshot, next, Boolean(input.apiKey))

  return { configPath, skipped: false, changed: catalogChanged || configChanged }
}
