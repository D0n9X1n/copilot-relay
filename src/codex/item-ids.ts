// One id per output item in a Copilot /responses stream. Copilot gives the same item a different
// opaque id on each event: the item's added event, every text delta, its done events and the final
// response each carry a new one. The Codex app keys items by id, so it shows the streamed text and
// the finished item as two replies. Every event is given the id of its item's added event.
type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// SSE frames end with a blank line; CRLF and LF both occur.
const frameEnd = /\r?\n\r?\n/

/**
 * Rewrites SSE frames as they stream so that every event about one output item names it by the same
 * id. A frame that needs no change is passed on byte for byte.
 */
export class StableItemIds {
  private readonly decoder = new TextDecoder()
  private readonly encoder = new TextEncoder()
  private readonly ids = new Map<number, string>()
  private pending = ""

  /** The bytes of every frame this chunk completes; a partial frame waits for the next chunk. */
  push(chunk: Uint8Array): Uint8Array {
    this.pending += this.decoder.decode(chunk, { stream: true })
    let output = ""
    let match = frameEnd.exec(this.pending)
    while (match) {
      const end = match.index + match[0].length
      output += this.rewriteFrame(this.pending.slice(0, end))
      this.pending = this.pending.slice(end)
      match = frameEnd.exec(this.pending)
    }

    return this.encoder.encode(output)
  }

  /** Whatever is left when the stream ends, unchanged: an incomplete frame has no event to fix. */
  flush(): Uint8Array {
    const rest = this.pending + this.decoder.decode()
    this.pending = ""
    return this.encoder.encode(rest)
  }

  // An event's data is every data: line of the frame joined by newlines, as SSE defines it. When the
  // event changes, its data is written back as one data: line in place of the first.
  private rewriteFrame(frame: string): string {
    const lines = frame.split(/(\r?\n)/)
    const dataIndexes: Array<number> = []
    for (let index = 0; index < lines.length; index += 2) {
      if (lines[index]!.startsWith("data:")) {
        dataIndexes.push(index)
      }
    }

    if (dataIndexes.length === 0) {
      return frame
    }

    const data = dataIndexes
      .map((index) => {
        const line = lines[index]!
        return line.startsWith("data: ") ? line.slice(6) : line.slice(5)
      })
      .join("\n")
    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      return frame
    }

    if (!isRecord(event) || !this.rewriteEvent(event)) {
      return frame
    }

    const [first, ...rest] = dataIndexes
    lines[first!] = `data: ${JSON.stringify(event)}`
    // Drop the other data lines with the line break before each.
    for (const index of rest.reverse()) {
      lines.splice(index - 1, 2)
    }

    return lines.join("")
  }

  // Gives the event's item the id of that output index's added event; true when it changed anything.
  private rewriteEvent(event: JsonRecord): boolean {
    if (isRecord(event.response) && Array.isArray(event.response.output)) {
      let changed = false
      for (const [index, item] of event.response.output.entries()) {
        changed = this.useId(index, item) || changed
      }

      return changed
    }

    const index = event.output_index
    if (typeof index !== "number") {
      return false
    }

    if (event.type === "response.output_item.added" && isRecord(event.item) && typeof event.item.id === "string") {
      this.ids.set(index, event.item.id)
      return false
    }

    let changed = this.useId(index, event.item)
    const id = this.ids.get(index)
    if (id !== undefined && typeof event.item_id === "string" && event.item_id !== id) {
      event.item_id = id
      changed = true
    }

    return changed
  }

  private useId(index: number, item: unknown): boolean {
    const id = this.ids.get(index)
    if (id === undefined || !isRecord(item) || typeof item.id !== "string" || item.id === id) {
      return false
    }

    item.id = id
    return true
  }
}
