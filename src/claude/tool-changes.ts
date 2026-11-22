// Mid-conversation tool changes: a role "system" message can carry tool_addition and tool_removal
// blocks beside its text. Native Messages forwards them unchanged; the translated routes have no
// such block, so a tool defined by value has to join the request's tools instead.
import type { ClaudeMessagesPayload, ClaudeSystemContentBlock, ClaudeTool, ClaudeToolChangeBlock } from "./types"

export const isClaudeToolChangeBlock = (block: ClaudeSystemContentBlock): block is ClaudeToolChangeBlock =>
  block.type === "tool_addition" || block.type === "tool_removal"

// The tool list in effect for a translated request. Each tool defined by value replaces a tool of
// the same name in place, or is appended in the order it first appears. References and removals
// change nothing: the translated routes already send every declared tool, deferred or not, and a
// list that only grows keeps the cached prefix that starts with it. A removed tool therefore stays
// offered; when the model calls it, Claude Code answers that it is not available. Messages are
// returned as sent, so cache breakpoints and effort controls are read from the original blocks.
export function foldClaudeToolChanges(payload: ClaudeMessagesPayload): ClaudeMessagesPayload {
  const definitions: Array<ClaudeTool> = []

  for (const message of payload.messages) {
    if (message.role !== "system" || !Array.isArray(message.content)) {
      continue
    }

    for (const block of message.content) {
      if (block.type === "tool_addition" && block.tool.type === "tool_definition") {
        definitions.push(block.tool.definition)
      }
    }
  }

  if (definitions.length === 0) {
    return payload
  }

  const tools = [...payload.tools ?? []]
  for (const definition of definitions) {
    const index = tools.findIndex((tool) => tool.name === definition.name)
    if (index === -1) {
      tools.push(definition)
    } else {
      tools[index] = definition
    }
  }

  return { ...payload, tools }
}
