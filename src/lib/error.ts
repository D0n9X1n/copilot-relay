// Error wrappers used to preserve upstream HTTP status and response bodies.
export class ProxyNotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProxyNotImplementedError"
  }
}

export class HTTPError extends Error {
  detail?: string
  response: Response

  constructor(message: string, response: Response, detail?: string) {
    super(message)
    this.name = "HTTPError"
    this.detail = detail
    this.response = response
  }
}

// A prompt over the model's input limit, reported as Anthropic's API reports it. Claude Code
// recognizes the overflow only by this wording, and reads both counts from it.
export class PromptTooLongError extends HTTPError {
  constructor(tokens: number | undefined, limit: number | undefined, detail?: string) {
    const message =
      tokens !== undefined && limit !== undefined ?
        `prompt is too long: ${tokens} tokens > ${limit} maximum`
      : "prompt is too long"

    super(
      message,
      Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status: 400 }),
      detail,
    )
    this.name = "PromptTooLongError"
  }
}
