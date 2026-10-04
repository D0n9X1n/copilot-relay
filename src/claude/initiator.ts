// Who started a Claude Code request, for the x-initiator header the relay sends Copilot:
// "user" for a prompt a person typed or sent, "agent" for everything Claude Code sends on its own,
// such as tool-result continuations, subagent requests and compaction.
import { readBillingLineField, removeBillingLine } from "~/claude/billing-line"
import type { ClaudeMessagesPayload } from "~/claude/types"

// Texts Claude Code 2.1.288 writes itself, read from its bundle. If a later version rewords one,
// that case falls back to the general rule at the end of getClaudeRequestInitiator.

// The system prompt of a dedicated compaction request.
const compactionSystemPrompt = "You are a helpful AI assistant tasked with summarizing conversations."

// The instruction that ends every compaction request, including one that keeps the main system
// prompt to reuse its cache.
const compactionInstructions = [
  "CRITICAL: Respond with TEXT ONLY.",
  "Your task is to create a detailed summary of the conversation so far",
]

// How Claude Code delivers a message the person sent while the model was working.
const midTurnMessagePrefix = "The user sent a new message while you were working:"

// Claude Code's interrupt-only notices. After one, Claude Code waits for the person, so a message
// beside it in the same turn is theirs.
const stopNotices = [
  "[Request interrupted by user",
  "[Tool call ",
  "The user doesn't want to take this action right now.",
]

// Other texts Claude Code puts in a user turn: the summary that resumes a session after
// compaction, messages from sources other than the person, and retry nudges.
const claudeCodeTexts = [
  ...stopNotices,
  "This session is being continued from a previous conversation",
  "The summarized conversation included Artifact content",
  "Messages arrived in the bound thread while you were working:",
  "[MESSAGE FROM NON-USER SOURCE",
  "[SCHEDULED TASK",
  "The previous response failed to produce a valid tool call.",
  "Your tool call was malformed and could not be parsed.",
  "[Your previous response had no visible output.",
  "[structured-output-enforce]",
  "[projects-reply-gate]",
]

// Hook output, such as "Stop hook feedback:", and a plugin's message, such as
// "The lint plugin sent a message".
const claudeCodePatterns = [
  /^\S+ hook (?:feedback|blocking error from command|additional context):/,
  /^The \S+ plugin sent a message/,
]

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Harness context, such as a background task's notification, travels in reminders.
const withoutReminders = (text: string): string =>
  text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()

const startsWithAny = (text: string, prefixes: Array<string>): boolean =>
  prefixes.some((prefix) => text.startsWith(prefix))

const isClaudeCodeText = (text: string): boolean =>
  startsWithAny(text, claudeCodeTexts) || claudeCodePatterns.some((pattern) => pattern.test(text))

// String content counts as one text block.
const contentBlocks = (content: unknown): Array<JsonRecord> => {
  if (typeof content === "string") {
    return [{ type: "text", text: content }]
  }

  return Array.isArray(content) ? content.filter(isRecord) : []
}

// The blocks of the user messages after the model last spoke, skipping system turns, or
// undefined when the request ends on an assistant message (a prefill) or holds no user message.
const originatingTurn = (messages: Array<unknown>): Array<JsonRecord> | undefined => {
  const blocks: Array<JsonRecord> = []
  let sawUser = false

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!isRecord(message) || message.role === "system") {
      continue
    }

    if (message.role !== "user") {
      break
    }

    sawUser = true
    blocks.unshift(...contentBlocks(message.content))
  }

  return sawUser ? blocks : undefined
}

// The turn's texts without reminders, leaving out texts that held nothing else.
const turnTexts = (blocks: Array<JsonRecord>): Array<string> =>
  blocks.flatMap((block) => {
    if (block.type !== "text" || typeof block.text !== "string") {
      return []
    }

    const text = withoutReminders(block.text)
    return text === "" ? [] : [text]
  })

const isToolResult = (block: JsonRecord): boolean => block.type === "tool_result"

// A pasted image or an attached document.
const isAttachment = (block: JsonRecord): boolean => block.type === "image" || block.type === "document"

// A call Claude Code stopped carries a stop notice as its error result.
const isStoppedToolResult = (block: JsonRecord): boolean =>
  isToolResult(block)
  && block.is_error === true
  && typeof block.content === "string"
  && startsWithAny(block.content, stopNotices)

const systemTexts = (system: unknown): Array<string> =>
  contentBlocks(system).flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : [])

// Decided once per request, before the relay removes the billing line that marks a subagent's
// requests and before it adds turns of its own. Never throws: a malformed body is "agent", and
// validation rejects it later.
export const getClaudeRequestInitiator = (body: unknown): "agent" | "user" => {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return "agent"
  }

  const payload = body as unknown as ClaudeMessagesPayload
  if (readBillingLineField(payload, "cc_is_subagent") === "true") {
    return "agent"
  }

  const system = systemTexts(removeBillingLine(payload).system)
  if (system.some((text) => text.trimStart().startsWith(compactionSystemPrompt))) {
    return "agent"
  }

  const turn = originatingTurn(body.messages)
  if (turn === undefined) {
    return "agent"
  }

  const texts = turnTexts(turn)
  if (texts.some((text) => startsWithAny(text, compactionInstructions))) {
    return "agent"
  }

  if (texts.some((text) => text.startsWith(midTurnMessagePrefix))) {
    return "user"
  }

  const holdsPersonContent = texts.some((text) => !isClaudeCodeText(text)) || turn.some(isAttachment)
  if (!turn.some(isToolResult)) {
    return holdsPersonContent ? "user" : "agent"
  }

  // Claude Code writes text of its own beside tool results, such as a skill's body after the
  // Skill tool. The person's message travels there only after Claude Code stopped a call for them.
  const stoppedForPerson = turn.some(isStoppedToolResult) || texts.some((text) => startsWithAny(text, stopNotices))
  return stoppedForPerson && holdsPersonContent ? "user" : "agent"
}
