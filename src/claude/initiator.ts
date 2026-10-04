// Who started a Claude Code request, for the x-initiator header the relay sends Copilot:
// "user" for a prompt a person typed or sent, "agent" for everything Claude Code sends on its own,
// such as tool-result continuations, subagent requests and compaction.
import { readBillingLineField, removeBillingLine } from "~/claude/billing-line"
import type { ClaudeMessagesPayload } from "~/claude/types"

// Texts Claude Code 2.1.288 writes itself, read from its bundle. If a later version rewords one,
// that case reads as any other text.

// System prompts of requests Claude Code makes on its own: a dedicated compaction, and the
// session title.
const ownRequestSystemPrompts = [
  "You are a helpful AI assistant tasked with summarizing conversations.",
  "You are naming a coding session",
]

// The two parts of the instruction that ends every compaction request, including one that keeps
// the main system prompt to reuse its cache. Either part alone can be a person's own words.
const compactionGuard = "CRITICAL: Respond with TEXT ONLY."
const compactionInstruction = "Your task is to create a detailed summary of the conversation so far"

// How Claude Code delivers a message a person sent while the model was working, directly or
// through a bound thread.
const personDeliveries = [
  "The user sent a new message while you were working:",
  "A message arrived in the bound thread while you were working:",
  "Messages arrived in the bound thread while you were working:",
]

// Texts that start a request without the person: the summary that resumes a session after
// compaction, recovery and retry nudges, and messages from sources other than the person.
const claudeCodeTriggers = [
  "This session is being continued from a previous conversation",
  "The summarized conversation included Artifact content",
  "The previous response failed to produce a valid tool call.",
  "Your tool call was malformed and could not be parsed.",
  "[Your previous response had no visible output.",
  "[structured-output-enforce]",
  "[projects-reply-gate]",
  "Output token limit hit",
  "Your response above was cut off mid-stream",
  "Your response above was stopped by a safety classifier",
  "Activity in the bound conversation",
  "Another Claude session sent a message",
  "Your background observer",
  "[MESSAGE FROM NON-USER SOURCE",
  "[SCHEDULED TASK",
  "<channel source=",
  "<teammate-message",
]

// Hook output, such as "Stop hook feedback:", and a plugin's message, such as
// "The lint plugin sent a message".
const claudeCodeTriggerPatterns = [
  /^\S+ hook (?:feedback|blocking error from command):/,
  /^The \S+ plugin sent a message/,
]

// Texts Claude Code adds beside what started the turn: interrupt notices, a hook's additional
// context, and a skill's body after the Skill tool.
const claudeCodeContext = [
  "[Request interrupted by user",
  "[Tool call ",
  "The user doesn't want to take this action right now.",
  "Base directory for this skill:",
]
const claudeCodeContextPatterns = [/^\S+ hook additional context:/]

// The prompt `status --deep` sends. It reaches the relay over HTTP from another process, so its
// text is the only mark it carries.
export const statusProbePrompt = "Reply with the single word: ok"

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Harness context, such as a background task's notification, travels in reminders, and a
// reminder can hold another. Each pass removes the innermost ones.
const innermostReminder = /<system-reminder>(?:(?!<system-reminder>)[\s\S])*?<\/system-reminder>/g

const withoutReminders = (text: string): string => {
  let previous = text
  let remaining = text.replace(innermostReminder, "")
  while (remaining !== previous) {
    previous = remaining
    remaining = remaining.replace(innermostReminder, "")
  }

  return remaining.trim()
}

const startsWithAny = (text: string, prefixes: Array<string>): boolean =>
  prefixes.some((prefix) => text.startsWith(prefix))

const matchesAny = (text: string, prefixes: Array<string>, patterns: Array<RegExp>): boolean =>
  startsWithAny(text, prefixes) || patterns.some((pattern) => pattern.test(text))

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

// What one block says about who started the turn, or undefined for a block that does not decide:
// a reminder, or context Claude Code adds beside what started the turn.
const blockOrigin = (block: JsonRecord): "agent" | "user" | undefined => {
  if (block.type === "tool_result") {
    return "agent"
  }

  // A pasted image or an attached document. A tool's image travels inside its tool result.
  if (block.type === "image" || block.type === "document") {
    return "user"
  }

  if (block.type !== "text" || typeof block.text !== "string") {
    return undefined
  }

  const text = withoutReminders(block.text)
  if (text === "" || matchesAny(text, claudeCodeContext, claudeCodeContextPatterns)) {
    return undefined
  }

  if (text === statusProbePrompt) {
    return "agent"
  }

  if (startsWithAny(text, personDeliveries)) {
    return "user"
  }

  const isCompaction = text.includes(compactionGuard) && text.includes(compactionInstruction)
  if (isCompaction || matchesAny(text, claudeCodeTriggers, claudeCodeTriggerPatterns)) {
    return "agent"
  }

  // Any other text is the person's, such as an instruction typed while approving a tool call.
  return "user"
}

const systemTexts = (system: unknown): Array<string> =>
  contentBlocks(system).flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : [])

// Decided once per request, before the relay removes the billing line that marks a subagent's
// requests and before it adds turns of its own. Never throws: a malformed body is "agent", and
// validation rejects it later.
export const getClaudeRequestInitiator = (body: unknown): "agent" | "user" => {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return "agent"
  }

  // Claude Code marks every request from a subagent, and the scheduler's cron jobs, on the
  // billing line.
  const payload = body as unknown as ClaudeMessagesPayload
  if (readBillingLineField(payload, "cc_is_subagent") === "true" || readBillingLineField(payload, "cc_workload") === "cron") {
    return "agent"
  }

  const system = systemTexts(removeBillingLine(payload).system)
  if (system.some((text) => startsWithAny(text.trimStart(), ownRequestSystemPrompts))) {
    return "agent"
  }

  const turn = originatingTurn(body.messages)
  if (turn === undefined) {
    return "agent"
  }

  // Read backward from the end of the turn: the last block that decides is what started it.
  for (let index = turn.length - 1; index >= 0; index--) {
    const origin = blockOrigin(turn[index])
    if (origin !== undefined) {
      return origin
    }
  }

  return "agent"
}
