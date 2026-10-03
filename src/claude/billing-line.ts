// Claude Code's billing attribution line in the top-level system prompt (#157).
import type { ClaudeMessagesPayload, ClaudeTextBlock } from "~/claude/types"

// Claude Code sends this line first in the top-level system prompt:
//   x-anthropic-billing-header: cc_version=2.1.288.976; cc_entrypoint=sdk-cli;
// It is metadata for Anthropic's API, not an instruction to the model. In #157 a Claude model
// on Copilot's /chat/completions behaved as if a system message starting with it were absent,
// and the chat route joins every system block into one message, so the whole prompt was lost.
const billingLinePrefix = "x-anthropic-billing-header:"

// The text after a leading billing line, without the blank lines that followed it, or
// undefined when the text does not start with one. A later mention is ordinary text.
const afterBillingLine = (text: string): string | undefined => {
  if (!text.startsWith(billingLinePrefix)) {
    return undefined
  }

  const lineEnd = text.indexOf("\n")
  if (lineEnd === -1) {
    return ""
  }

  return text.slice(lineEnd + 1).replace(/^(?:\r?\n)+/, "")
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
