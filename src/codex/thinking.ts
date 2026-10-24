// Claude thinking carried through Codex. Codex keeps a reasoning item's encrypted_content and sends
// it back on the next turn, so the relay puts a Claude thinking block there, base64url JSON behind a
// prefix that marks it as the relay's.
type JsonRecord = Record<string, unknown>
type ClaudeBlock = JsonRecord & { type: string }

const thinkingPrefix = "copilot-relay.claude-thinking.v1:"

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const encodeThinking = (block: JsonRecord): string =>
  thinkingPrefix + Buffer.from(JSON.stringify(block), "utf8").toString("base64url")

/** Whether a reasoning item's encrypted_content is one the relay wrote for Claude. */
export const isRelayThinking = (encrypted: unknown): boolean =>
  typeof encrypted === "string" && encrypted.startsWith(thinkingPrefix)

/** The Claude thinking block a reasoning item carries, or undefined when it is not the relay's. */
export const decodeThinking = (encrypted: unknown): ClaudeBlock | undefined => {
  if (typeof encrypted !== "string" || !isRelayThinking(encrypted)) {
    return undefined
  }

  let block: unknown
  try {
    block = JSON.parse(Buffer.from(encrypted.slice(thinkingPrefix.length), "base64url").toString("utf8"))
  } catch {
    return undefined
  }

  if (!isRecord(block)) {
    return undefined
  }

  if (block.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string") {
    return { type: "thinking", thinking: block.thinking, signature: block.signature }
  }

  if (block.type === "redacted_thinking" && typeof block.data === "string") {
    return { type: "redacted_thinking", data: block.data }
  }

  return undefined
}
