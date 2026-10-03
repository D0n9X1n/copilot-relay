import { sanitizeTerminalString } from "./redact"

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
