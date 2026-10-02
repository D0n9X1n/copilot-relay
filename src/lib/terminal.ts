import { sanitizeTerminalString } from "./redact"

export const colorEnabled = (env: NodeJS.ProcessEnv = process.env, isTTY = Boolean(process.stdout.isTTY)): boolean => {
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

export const terminalText = (value: string): string => sanitizeTerminalString(value)
  .replace(/[\x80-\x9f]|\p{Cf}|\p{Zl}|\p{Zp}/gu, "")

export const colorText = (text: string, tone: TerminalTone, enabled: boolean): string =>
  enabled ? `\u001b[${ansiColorCodes[tone]}m${text}\u001b[0m` : text
