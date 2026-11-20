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

// A named tone, or the SGR parameters of one shade on a ramp, such as "38;5;178".
export type TerminalShade = TerminalTone | string

// Colors a terminal can show: 0 when color is off, then 16, 256 and 16 million colors.
export type ColorDepth = 0 | 4 | 8 | 24

interface ColorStream {
  isTTY?: boolean
  getColorDepth?: (env?: NodeJS.ProcessEnv) => number
}

/**
 * How many colors to write. colorEnabled decides whether there is any color; FORCE_COLOR=2 and 3
 * ask for 256 and 16 million colors, as Node reads them; otherwise the stream's own depth, which a
 * pipe does not have.
 */
export const colorDepth = (env: NodeJS.ProcessEnv = process.env, stream: ColorStream | undefined = process.stdout): ColorDepth => {
  if (!colorEnabled(env, Boolean(stream?.isTTY))) {
    return 0
  }

  if (env.FORCE_COLOR !== undefined) {
    const forced: Record<string, ColorDepth> = { "2": 8, "3": 24 }
    return forced[env.FORCE_COLOR] ?? 4
  }

  const depth = stream?.getColorDepth?.(env) ?? 1
  if (depth >= 24) {
    return 24
  }

  if (depth >= 8) {
    return 8
  }

  return depth >= 4 ? 4 : 0
}

// C1 controls (U+009B alone starts an escape sequence in some terminals), invisible format
// characters such as bidi overrides, and line and paragraph separators.
const hiddenCharacters = /[\x80-\x9f]|\p{Cf}|\p{Zl}|\p{Zp}/gu

// Removes those characters only, keeping ANSI escapes and newlines, for output the relay colors or
// lays out itself.
export const withoutHiddenCharacters = (value: string): string => value.replace(hiddenCharacters, "")

// On top of ANSI escapes and C0 controls, drops the hidden characters above.
export const terminalText = (value: string): string => withoutHiddenCharacters(sanitizeTerminalString(value))

const sgrOf = (shade: TerminalShade): string =>
  shade in ansiColorCodes ? String(ansiColorCodes[shade as TerminalTone]) : shade

export const colorText = (text: string, shade: TerminalShade, enabled: boolean): string =>
  enabled ? `\u001b[${sgrOf(shade)}m${text}\u001b[0m` : text

// Bold carries emphasis where color would add a meaning: titles, column names, a chosen ID. SGR 22
// ends bold alone, so bold inside a colored line leaves that color on.
export const boldText = (text: string, enabled: boolean): string =>
  enabled ? `\u001b[1m${text}\u001b[22m` : text

/**
 * Where each price sits from cheapest (0) to dearest (1), for a ramp from green to red. Paid prices
 * spread on a log scale between the cheapest and the dearest, because prices are compared as
 * ratios: $5 sits halfway between $0.50 and $50. A free price sits at 0. With nothing to compare,
 * fewer than two distinct prices or only free ones, every position is undefined and nothing is
 * colored.
 */
export const priceRamp = (prices: Array<number>): ((price: number | undefined) => number | undefined) => {
  const paid = prices.filter((price) => Number.isFinite(price) && price > 0)
  const free = prices.some((price) => price === 0)
  const low = Math.min(...paid)
  const high = Math.max(...paid)

  if (paid.length === 0 || (low === high && !free)) {
    return () => undefined
  }

  return (price) => {
    if (price === undefined || !Number.isFinite(price) || price < 0) {
      return undefined
    }

    if (price === 0 || low === high) {
      return price === 0 ? 0 : 1
    }

    const position = (Math.log(price) - Math.log(low)) / (Math.log(high) - Math.log(low))
    return Math.min(1, Math.max(0, Math.round(position * 1000) / 1000))
  }
}

// Green, amber, orange and red, each at the position where it is pure. Amber sits at 65% and
// orange at 80%, so a mid price, a dear one and the dearest read as three colors rather than one
// orange. Each anchor and every blend between them has at least 3:1 contrast on a white background
// and on a dark one.
const rampAnchors: Array<{ at: number; rgb: [number, number, number] }> = [
  { at: 0, rgb: [42, 157, 74] },
  { at: 0.65, rgb: [167, 125, 0] },
  { at: 0.8, rgb: [192, 101, 26] },
  { at: 1, rgb: [215, 58, 58] },
]
// The same ramp in the 256-color cube, each stop at least 3.3:1 on black and on white, from the
// position where it starts: two greens, olive, amber, two oranges and red.
const rampCube: Array<{ at: number; index: number }> = [
  { at: 0, index: 28 },
  { at: 0.2, index: 64 },
  { at: 0.35, index: 100 },
  { at: 0.5, index: 136 },
  { at: 0.65, index: 130 },
  { at: 0.8, index: 166 },
  { at: 0.9, index: 160 },
]
// Sixteen colors have no orange, so the ramp is three bands: green, yellow and red.
const rampBands = ["32", "33", "31"]

/** The SGR shade at a ramp position from 0 to 1 for a color depth. */
export const rampShade = (position: number, depth: Exclude<ColorDepth, 0>): string => {
  const at = Math.min(1, Math.max(0, position))

  if (depth === 4) {
    return rampBands[Math.min(2, Math.floor(at * 3))]
  }

  if (depth === 8) {
    const stop = rampCube.findLast((candidate) => candidate.at <= at) ?? rampCube[0]
    return `38;5;${stop.index}`
  }

  const upper = Math.max(1, rampAnchors.findIndex((anchor) => anchor.at >= at))
  const from = rampAnchors[upper - 1]
  const to = rampAnchors[upper]
  const fraction = (at - from.at) / (to.at - from.at)
  const [red, green, blue] = from.rgb.map((value, channel) => Math.round(value + (to.rgb[channel] - value) * fraction))

  return `38;2;${red};${green};${blue}`
}

// A cell as it may be printed: controls and hidden characters go first, because one inside a
// secret keeps it from matching, then registered secrets and secret-bearing URLs. Every cell passes
// through this before it is cut or padded, since a secret cut in two would escape the scrub.
export const printableCell = (text: string): string => scrubSensitiveUrls(scrubLogSecrets(terminalText(text)))

export interface TableColumn<Row> {
  header: string
  align: "left" | "right"
  cell: (row: Row) => string
  tone?: (row: Row) => TerminalShade | undefined
  // A cell without a tone shown in bold, such as the ID a config key names.
  bold?: (row: Row) => boolean
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
 * widest cell or the given widths, whichever is wider, so an ID is never cut. Color wraps each cell's
 * text and padding stays outside it, so the plain text is the same with color on or off and no line
 * ends in spaces.
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

  // Color wraps the text alone and padding stays outside it, so a reset never hides trailing spaces
  // and the plain text is the same with color on or off.
  // A cell is colored by its tone, else bold when chosen; never both, since a terminal can draw bold
  // as a brighter color and shift the tone.
  const line = (texts: Array<string>, tones: Array<TerminalShade | undefined>, bolds: Array<boolean>): string => {
    const padded = texts.map((text, index) => {
      const spaces = " ".repeat(Math.max(0, widths[index] - displayWidth(text)))
      const tone = tones[index]
      let styled = text

      if (text !== "" && tone !== undefined) {
        styled = colorText(text, tone, color)
      } else if (text !== "" && bolds[index]) {
        styled = boldText(text, color)
      }

      return columns[index].align === "right" ? spaces + styled : styled + spaces
    })
    return `  ${padded.join("  ")}`.trimEnd()
  }

  const header = line(columns.map((column) => column.header), [], columns.map(() => true))
  const body = shown.map((texts, rowIndex) => line(
    texts,
    columns.map((column) => column.tone?.(rows[rowIndex])),
    columns.map((column) => column.bold?.(rows[rowIndex]) === true),
  ))
  return [header, ...body]
}

// The title is bold so a reader finds it first; the detail after it stays plain.
export const heading = (title: string, detail?: string, color = false): string => {
  const shown = boldText(title, color)
  return detail === undefined ? shown : `${shown} · ${detail}`
}

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
