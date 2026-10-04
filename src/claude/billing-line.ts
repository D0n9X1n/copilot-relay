// Claude Code's billing attribution line in the top-level system prompt.
import type { ClaudeMessagesPayload, ClaudeTextBlock } from "~/claude/types"

// Claude Code sends this line first in the top-level system prompt:
//   x-anthropic-billing-header: cc_version=2.1.288.976; cc_entrypoint=sdk-cli;
// It is metadata for Anthropic's API, not an instruction to the model. A Claude model on
// Copilot's /chat/completions behaves as if a system message starting with it were absent, and
// the chat route joins every system block into one message, so the whole prompt would be lost.
const billingLinePrefix = "x-anthropic-billing-header:"

// The billing line a text starts with, without its line break, or undefined when the text does
// not start with one. A later mention is ordinary text.
const leadingBillingLine = (text: string): string | undefined => {
  if (!text.startsWith(billingLinePrefix)) {
    return undefined
  }

  const lineEnd = text.indexOf("\n")
  return lineEnd === -1 ? text : text.slice(0, lineEnd)
}

// The text after a leading billing line, without the blank lines that followed it, or
// undefined when the text does not start with one.
const afterBillingLine = (text: string): string | undefined => {
  const line = leadingBillingLine(text)
  if (line === undefined) {
    return undefined
  }

  return text.slice(line.length).replace(/^(?:\r?\n)+/, "")
}

const isTextBlock = (block: unknown): block is ClaudeTextBlock =>
  typeof block === "object"
  && block !== null
  && (block as { type?: unknown }).type === "text"
  && typeof (block as { text?: unknown }).text === "string"

const withSystem = (
  payload: ClaudeMessagesPayload,
  system: ClaudeMessagesPayload["system"],
): ClaudeMessagesPayload => {
  const { system: _removed, ...rest } = payload
  return system === undefined ? rest : { ...rest, system }
}

// Removes the billing line from the top-level system prompt before any route reads it. A block
// that held only the line is dropped; every other block keeps its text and cache metadata.
// Returns the payload itself when there is nothing to remove. Never logs the line.
export const removeBillingLine = (payload: ClaudeMessagesPayload): ClaudeMessagesPayload => {
  // A malformed body passes through unchanged, so validation still rejects it as before.
  if (typeof payload !== "object" || payload === null) {
    return payload
  }

  const { system } = payload
  if (typeof system === "string") {
    const rest = afterBillingLine(system)
    if (rest === undefined) {
      return payload
    }

    return withSystem(payload, rest.trim() === "" ? undefined : rest)
  }

  if (!Array.isArray(system)) {
    return payload
  }

  let changed = false
  const kept: Array<ClaudeTextBlock> = []
  for (const block of system) {
    const rest = isTextBlock(block) ? afterBillingLine(block.text) : undefined
    if (rest === undefined) {
      kept.push(block)
      continue
    }

    changed = true
    if (rest.trim() !== "") {
      kept.push({ ...block, text: rest })
    }
  }

  if (!changed) {
    return payload
  }

  return withSystem(payload, kept.length > 0 ? kept : undefined)
}

const systemTexts = (system: unknown): Array<string> => {
  if (typeof system === "string") {
    return [system]
  }

  return Array.isArray(system) ? system.filter(isTextBlock).map((block) => block.text) : []
}

// The value of one field of the billing line, such as "true" for cc_is_subagent, or
// undefined when there is no billing line or it lacks that field. Never logs the line.
export const readBillingLineField = (payload: ClaudeMessagesPayload, name: string): string | undefined => {
  // A malformed body has no billing line.
  if (typeof payload !== "object" || payload === null) {
    return undefined
  }

  const line = systemTexts(payload.system)
    .map((text) => leadingBillingLine(text))
    .find((text) => text !== undefined)
  if (line === undefined) {
    return undefined
  }

  for (const field of line.slice(billingLinePrefix.length).split(";")) {
    const separator = field.indexOf("=")
    if (separator !== -1 && field.slice(0, separator).trim() === name) {
      return field.slice(separator + 1).trim()
    }
  }

  return undefined
}
