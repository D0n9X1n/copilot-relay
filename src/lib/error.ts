// Error wrappers used to preserve upstream HTTP status and response bodies.
export class ProxyNotImplementedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProxyNotImplementedError"
  }
}

export class HTTPError extends Error {
  response: Response

  constructor(message: string, response: Response) {
    super(message)
    this.name = "HTTPError"
    this.response = response
  }
}
