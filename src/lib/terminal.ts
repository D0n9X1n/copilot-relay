import { scrubLogSecrets } from "./log"
import { sanitizeTerminalString, scrubSensitiveUrls } from "./redact"

export const colorEnabled = (env: NodeJS.ProcessEnv = process.env, isTTY = Boolean(process.stdout.isTTY)): boolean => {
  // NO_COLOR (no-color.org) is checked first, so it wins over any FORCE_COLOR value.
  if (env.NO_COLOR !== undefined || env.FORCE_COLOR === "0") {
    return false
  }

  if (env.FORCE_COLOR !== undefined) {
    return env.FORCE_COLOR === "" || ["1", "2", "3", "true"].includes(env.FORCE_COLOR)
  }

  return isTTY && env.TERM !== "dumb"
}

export type TerminalTone = "good" | "bad" | "warning" | "muted"
const ansiColorCodes: Record<TerminalTone, number> = { good: 32, bad: 31, warning: 33, muted: 90 }

// C1 controls (U+009B alone starts an escape sequence in some terminals), invisible format
// characters such as bidi overrides, and line and paragraph separators.
const hiddenCharacters = /[\x80-\x9f]|\p{Cf}|\p{Zl}|\p{Zp}/gu

// Removes those characters only, keeping ANSI escapes and newlines, for output the relay colors or
// lays out itself.
export const withoutHiddenCharacters = (value: string): string => value.replace(hiddenCharacters, "")

// On top of ANSI escapes and C0 controls, drops the hidden characters above.
export const terminalText = (value: string): string => withoutHiddenCharacters(sanitizeTerminalString(value))

export const colorText = (text: string, tone: TerminalTone, enabled: boolean): string =>
  enabled ? `\u001b[${ansiColorCodes[tone]}m${text}\u001b[0m` : text

// A cell as it may be printed: controls and hidden characters go first, because one inside a
// secret keeps it from matching, then registered secrets and secret-bearing URLs. Every cell passes
// through this before it is cut or padded, since a secret cut in two would escape the scrub.
export const printableCell = (text: string): string => scrubSensitiveUrls(scrubLogSecrets(terminalText(text)))

export interface TableColumn<Row> {
  header: string
  align: "left" | "right"
  cell: (row: Row) => string
  tone?: (row: Row) => TerminalTone | undefined
  // A longer cell is cut to this many characters, the last one an ellipsis.
  maxWidth?: number
  // Leave the cell blank when it repeats the row above, as an hour or a day does in a trend.
  repeatBlank?: boolean
}

const cutCell = (text: string, maxWidth: number | undefined): string =>
  maxWidth !== undefined && text.length > maxWidth ? `${text.slice(0, maxWidth - 1)}…` : text

/**
 * Lines of a table: a two-space indent and gutter, headers as given, every column as wide as its
 * widest cell. Color is applied after padding, so the plain text is the same with color on or off,
 * and the last column carries no trailing spaces.
 */
export const renderTable = <Row>(columns: Array<TableColumn<Row>>, rows: Array<Row>, color: boolean): Array<string> => {
  const cells = rows.map((row) => columns.map((column) => cutCell(printableCell(column.cell(row)), column.maxWidth)))
  const shown = cells.map((rowCells, rowIndex) =>
    rowCells.map((cell, columnIndex) => {
      const repeated = rowIndex > 0 && cells[rowIndex - 1][columnIndex] === cell
      return columns[columnIndex].repeatBlank === true && repeated ? "" : cell
    }))

  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...shown.map((rowCells) => rowCells[index].length)))

  const line = (texts: Array<string>, tones: Array<TerminalTone | undefined>): string => {
    const padded = texts.map((text, index) => {
      const cell = columns[index].align === "right" ? text.padStart(widths[index]) : text.padEnd(widths[index])
      const tone = tones[index]
      return tone === undefined ? cell : colorText(cell, tone, color)
    })
    return `  ${padded.join("  ")}`.trimEnd()
  }

  const header = line(columns.map((column) => column.header), [])
  const body = shown.map((texts, rowIndex) => line(texts, columns.map((column) => column.tone?.(rows[rowIndex]))))
  return [header, ...body]
}

export const heading = (title: string, detail?: string): string =>
  detail === undefined ? title : `${title} · ${detail}`

/**
 * Whether the terminal can show the marks below. The Windows console host shows them only inside
 * Windows Terminal or an editor's terminal; elsewhere the first set of LC_ALL, LC_CTYPE and LANG
 * must name UTF-8.
 */
export const unicodeEnabled = (env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean => {
  if (platform === "win32") {
    return env.WT_SESSION !== undefined || env.TERM_PROGRAM !== undefined
  }

  const locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find((value) => value !== undefined && value !== "")
  return locale !== undefined && /utf-?8/i.test(locale)
}

export type MarkState = "ok" | "fail" | "warn" | "off"
const unicodeMarks: Record<MarkState, string> = { ok: "✓", fail: "✗", warn: "!", off: "–" }
const asciiMarks: Record<MarkState, string> = { ok: "ok", fail: "x", warn: "!", off: "-" }

// A state always carries this mark, so it never depends on color alone.
export const mark = (state: MarkState, unicode = unicodeEnabled()): string =>
  unicode ? unicodeMarks[state] : asciiMarks[state]

export const formatCount = (value: number): string => value.toLocaleString("en-US")

const tokenUnits = [
  { size: 1_000_000_000, suffix: "B" },
  { size: 1_000_000, suffix: "M" },
  { size: 1_000, suffix: "K" },
]

// Below 1,000 the exact count; above it one decimal at most, so 999,950 rounds up to 1M rather
// than printing 1000K.
export const formatTokens = (value: number): string => {
  for (const [index, unit] of tokenUnits.entries()) {
    const scaled = Math.round(value / unit.size * 10) / 10
    if (value >= unit.size) {
      const larger = tokenUnits[index - 1]
      if (larger !== undefined && scaled * unit.size >= larger.size) {
        return `${Math.round(value / larger.size * 10) / 10}${larger.suffix}`
      }

      return `${scaled}${unit.suffix}`
    }
  }

  return String(value)
}
