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
  // A longer cell is cut to this many terminal columns, the last one an ellipsis.
  maxWidth?: number
  // Leave the cell blank when it repeats the row above, as an hour or a day does in a trend.
  repeatBlank?: boolean
}

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" })

// East Asian wide and fullwidth ranges, including the supplementary ideograph planes, and emoji
// shown as emoji: by default, or by an explicit presentation selector. A symbol such as ® or ✓ in
// its text presentation takes one column.
const wideCharacter = /^(?:[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}|\p{Extended_Pictographic}\ufe0f)/u

// A combining mark or zero-width character that a terminal draws on the column before it.
const zeroWidth = /^[\p{Mn}\p{Me}\u200b-\u200d\u2060\ufeff]+$/u

// Terminal columns of one user-perceived character: a combining mark joins the character before it,
// and one with nothing to join takes no column.
const graphemeWidth = (grapheme: string): number => {
  if (zeroWidth.test(grapheme)) {
    return 0
  }

  return wideCharacter.test(grapheme) ? 2 : 1
}

export const displayWidth = (text: string): number => {
  let width = 0
  for (const { segment } of graphemes.segment(text)) {
    width += graphemeWidth(segment)
  }

  return width
}

// Cuts at character boundaries only, so a surrogate pair or a combining sequence is never split.
const cutCell = (text: string, maxWidth: number | undefined): string => {
  if (maxWidth === undefined || displayWidth(text) <= maxWidth) {
    return text
  }

  let kept = ""
  let width = 0
  for (const { segment } of graphemes.segment(text)) {
    const next = width + graphemeWidth(segment)
    if (next > maxWidth - 1) {
      break
    }

    kept += segment
    width = next
  }

  return `${kept}…`
}

const pad = (text: string, width: number, align: "left" | "right"): string => {
  const spaces = " ".repeat(Math.max(0, width - displayWidth(text)))
  return align === "right" ? spaces + text : text + spaces
}

const tableCell = <Row>(column: TableColumn<Row>, row: Row): string =>
  cutCell(printableCell(column.cell(row)), column.maxWidth)

/**
 * Each column's width: its header and widest cell, and at least the given minimum. A table printed
 * one row at a time computes these once and passes them to every renderTable call, so its rows line
 * up with the header.
 */
export const columnWidths = <Row>(columns: Array<TableColumn<Row>>, rows: Array<Row>, minimums: Array<number> = []): Array<number> =>
  columns.map((column, index) =>
    Math.max(minimums[index] ?? 0, displayWidth(column.header), ...rows.map((row) => displayWidth(tableCell(column, row)))))

/**
 * Lines of a table: a two-space indent and gutter, headers as given, every column as wide as its
 * widest cell or the given widths, whichever is wider, so an ID is never cut. Color is applied after
 * padding, so the plain text is the same with color on or off, and the last column carries no
 * trailing spaces.
 */
export const renderTable = <Row>(
  columns: Array<TableColumn<Row>>,
  rows: Array<Row>,
  color: boolean,
  minimumWidths: Array<number> = [],
): Array<string> => {
  const cells = rows.map((row) => columns.map((column) => tableCell(column, row)))
  const shown = cells.map((rowCells, rowIndex) =>
    rowCells.map((cell, columnIndex) => {
      const repeated = rowIndex > 0 && cells[rowIndex - 1][columnIndex] === cell
      return columns[columnIndex].repeatBlank === true && repeated ? "" : cell
    }))

  const widths = columns.map((column, index) =>
    Math.max(minimumWidths[index] ?? 0, displayWidth(column.header), ...shown.map((rowCells) => displayWidth(rowCells[index]))))

  // Padding is trimmed from the last column before color, whose reset would otherwise hide it.
  const line = (texts: Array<string>, tones: Array<TerminalTone | undefined>): string => {
    const padded = texts.map((text, index) => {
      const full = pad(text, widths[index], columns[index].align)
      const cell = index === texts.length - 1 ? full.trimEnd() : full
      const tone = tones[index]
      return tone === undefined || cell === "" ? cell : colorText(cell, tone, color)
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
