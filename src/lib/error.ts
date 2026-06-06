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
