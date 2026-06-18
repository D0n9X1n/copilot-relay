import type { ClaudeMessagesPayload, ClaudeTool } from "~/claude/types"

const anthropicWebSearchToolPattern = /^web_search_\d{8}$/
const claudeCodeWebSearchToolName = "WebSearch"

export interface UnsupportedClaudeServerTool {
  message: string
  name: string
}

const isAnthropicNativeWebSearchTool = (tool: ClaudeTool): boolean =>
  tool.name === "web_search"
  && typeof tool.type === "string"
  && anthropicWebSearchToolPattern.test(tool.type)

const isClaudeCodeWebSearchTool = (tool: ClaudeTool): boolean =>
  tool.name === claudeCodeWebSearchToolName

const isUnsupportedClaudeServerTool = (tool: ClaudeTool): boolean =>
  isAnthropicNativeWebSearchTool(tool) || isClaudeCodeWebSearchTool(tool)

export const getUnsupportedClaudeServerTool = (
  payload: ClaudeMessagesPayload,
): UnsupportedClaudeServerTool | undefined => {
  const tool = payload.tools?.find(isUnsupportedClaudeServerTool)
  if (!tool) {
    return undefined
  }

  return {
    name: tool.name,
    message:
      "Claude server-side WebSearch is not supported by copilot-relay when relaying through Copilot.",
  }
}
