// The one undici dispatcher every upstream call goes through: the Copilot API and GitHub sign-in.
// Calls to the relay's own listener, such as the status probes, use the global fetch instead.
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici"

import { log, registerLogSecret } from "~/lib/log"
import { paths } from "~/lib/paths"

// Copilot sends no Keep-Alive hint, so undici would close an idle upstream connection after its 4 s
// default and the next request would pay for a new TCP and TLS handshake. In #141 Copilot reused a
// connection idle for 60 s and had closed one idle for 120 s; 50 s stays under the reused gap.
// Every dispatcher kind below takes these options, so a proxy changes none of it.
const connectionOptions: Agent.Options = {
  allowH2: false,
  connect: { allowH2: false },
  keepAliveTimeout: 50_000,
}

/**
 * A malformed HTTPS_PROXY or HTTP_PROXY with upstreamProxy: env. The message is fixed: the proxy
 * URL comes from the environment, can carry a password, and undici's own error repeats it. This
 * message reaches the terminal and the log.
 */
export class InvalidProxyEnvironmentError extends Error {
  constructor() {
    super("Invalid HTTPS_PROXY or HTTP_PROXY: with upstreamProxy: env, each one that is set must be an absolute http(s) proxy URL")
    this.name = "InvalidProxyEnvironmentError"
  }
}

/**
 * Builds the dispatcher for one resolved upstreamProxy value.
 *
 * Empty connects directly, as every release before #153 did. "env" hands HTTPS_PROXY, HTTP_PROXY
 * and NO_PROXY, in upper or lower case, to EnvHttpProxyAgent. Anything else is a proxy URL that
 * normalizeUpstreamProxy has already validated.
 */
export const buildUpstreamDispatcher = (upstreamProxy: string | undefined): Dispatcher => {
  if (upstreamProxy === undefined) {
    return new Agent(connectionOptions)
  }

  if (upstreamProxy === "env") {
    try {
      return new EnvHttpProxyAgent(connectionOptions)
    } catch {
      throw new InvalidProxyEnvironmentError()
    }
  }

  return new ProxyAgent({ ...connectionOptions, uri: upstreamProxy })
}

let upstreamDispatcher: Dispatcher = buildUpstreamDispatcher(undefined)
let configuredUpstreamProxy: string | undefined

/**
 * The proxy URLs a dispatcher for this upstreamProxy can send through: none when it is empty, the
 * URL itself, or with "env" each proxy variable EnvHttpProxyAgent reads, the lower-case spelling
 * first, as undici does.
 */
const proxyUrlsFor = (upstreamProxy: string | undefined): Array<string> => {
  if (upstreamProxy === undefined) {
    return []
  }

  if (upstreamProxy !== "env") {
    return [upstreamProxy]
  }

  return [
    process.env.http_proxy ?? process.env.HTTP_PROXY,
    process.env.https_proxy ?? process.env.HTTPS_PROXY,
  ].filter((value): value is string => value !== undefined && value !== "")
}

const decodeOrKeep = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

const parseProxyUrl = (proxyUrl: string): URL | undefined => {
  try {
    return new URL(proxyUrl)
  } catch {
    return undefined
  }
}

/**
 * The forms a proxy's credentials take together: user:password as written in the URL and decoded,
 * and the Basic value undici sends in Proxy-Authorization. None when the URL lacks either part,
 * because undici then sends no Proxy-Authorization at all.
 */
const credentialPairForms = (proxyUrl: string): Array<string> => {
  const url = parseProxyUrl(proxyUrl)
  if (url === undefined || url.username === "" || url.password === "") {
    return []
  }

  const decoded = `${decodeOrKeep(url.username)}:${decodeOrKeep(url.password)}`
  return [`${url.username}:${url.password}`, decoded, Buffer.from(decoded).toString("base64")]
}

// Every form of a proxy's credentials, each part alone included, for cleaning one error.
const credentialForms = (proxyUrl: string): Array<string> => {
  const url = parseProxyUrl(proxyUrl)
  if (url === undefined) {
    return []
  }

  return [
    ...credentialPairForms(proxyUrl),
    url.username,
    decodeOrKeep(url.username),
    url.password,
    decodeOrKeep(url.password),
  ].filter((form) => form !== "")
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// Every form of the credentials of each proxy the dispatcher can use, longest first, so a form
// that begins with a shorter one is replaced whole. Undefined when no proxy has credentials.
let activeCredentialPattern: RegExp | undefined

// registerLogSecret replaces a form in every log line, so a short one could match ordinary text:
// "a:b" is inside "data:base64".
const minimumRegisteredLength = 8

/**
 * Builds this process's upstream dispatcher from the resolved upstreamProxy, and registers the
 * credentials of each proxy it can use with the log redaction.
 *
 * start, auth, models and usage call it once, after reading the config and before their first
 * upstream call. Until one does, upstream calls connect directly, as they did before the key
 * existed. A config reload never calls it, which is why upstreamProxy, like host and port, takes
 * effect on restart, and why a reload registers no credentials. It is never undici's global
 * dispatcher, so calls to the relay itself stay direct.
 *
 * Only the user:password pair and the Basic value are registered, never a user name or password
 * alone: registerLogSecret replaces a value in every log line, and a short or common user name such
 * as "copilot" would also cut it out of "copilot-relay".
 */
export const configureUpstreamDispatcher = (upstreamProxy: string | undefined): void => {
  const previous = upstreamDispatcher
  upstreamDispatcher = buildUpstreamDispatcher(upstreamProxy)
  configuredUpstreamProxy = upstreamProxy

  const proxyUrls = proxyUrlsFor(upstreamProxy)
  for (const form of proxyUrls.flatMap((proxyUrl) => credentialPairForms(proxyUrl))) {
    if (form.length >= minimumRegisteredLength) {
      registerLogSecret(form)
    }
  }

  const forms = [...new Set(proxyUrls.flatMap((proxyUrl) => credentialForms(proxyUrl)))]
    .sort((left, right) => right.length - left.length)
  activeCredentialPattern = forms.length === 0
    ? undefined
    : new RegExp(forms.map((form) => escapeRegExp(form)).join("|"), "g")

  // Requests already sent through the previous dispatcher finish before it closes.
  void previous.close().catch(() => undefined)
}

export const getUpstreamDispatcher = (): Dispatcher => upstreamDispatcher

const proxyVariables = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
let proxyHintLogged = false

/**
 * Logs, once per process, that a proxy the environment names was not used.
 *
 * Only for a request that failed without an HTTP response while upstreamProxy is empty: the relay
 * ignored HTTPS_PROXY or HTTP_PROXY and went direct, and those variables suggest the network
 * expects a proxy. A cancelled request or a passed deadline is not that kind of failure.
 */
const noteConnectionFailure = (signal: AbortSignal | undefined): void => {
  if (proxyHintLogged || configuredUpstreamProxy !== undefined || signal?.aborted) {
    return
  }

  if (!proxyVariables.some((name) => process.env[name])) {
    return
  }

  proxyHintLogged = true
  log.error(
    `Upstream request failed without a response. HTTPS_PROXY or HTTP_PROXY is set, but upstreamProxy is empty, so copilot-relay connected directly. To use that proxy, set upstreamProxy: env in ${paths.configPath}, then run the command again or restart the relay.`,
  )
}

export interface UpstreamRequestInit {
  body?: string
  headers?: Record<string, string>
  method?: string
  signal?: AbortSignal
}

const redacted = "[redacted]"

// Fields in which undici keeps raw bytes from the peer: HTTPParserError.data holds the unparsed
// rest of a reply.
const rawPayloadKeys = ["data", "body"]

// Replaces an error's message or stack in place. A frozen error keeps its text.
const replaceText = (error: Error, key: "message" | "stack", value: string): void => {
  try {
    Object.defineProperty(error, key, { configurable: true, enumerable: false, value, writable: true })
  } catch {
    // A frozen error cannot be changed.
  }
}

// A stack with the credentials replaced in its first lines, which repeat the message. Frames name
// code locations, never credentials, and a short form such as a one-letter user name could match
// inside a path there.
const scrubStackHead = (stack: string, pattern: RegExp): string => {
  const frames = stack.search(/\n\s+at /)
  if (frames === -1) {
    return stack.replace(pattern, redacted)
  }

  return stack.slice(0, frames).replace(pattern, redacted) + stack.slice(frames)
}

/**
 * Cleans the error of an upstream request that failed without a response, in place, so it keeps
 * its type, code and cause, which callers read.
 *
 * It drops the raw payload undici can keep from the peer anywhere in the cause chain: a proxy that
 * answers CONNECT with a reply undici cannot parse leaves the rest of that reply in
 * HTTPParserError.data, and a reply that echoes Proxy-Authorization would carry the password into
 * every log line that prints the error. It also replaces every form of the active proxy's
 * credentials in each message, short ones and a user name or password alone included: unlike the
 * log redaction, only this error changes.
 */
const sanitizeTransportError = (error: unknown, seen = new Set<unknown>()): void => {
  if (!(error instanceof Error) || seen.has(error)) {
    return
  }

  seen.add(error)

  for (const key of rawPayloadKeys) {
    Reflect.deleteProperty(error, key)
  }

  if (activeCredentialPattern !== undefined) {
    if (typeof error.message === "string") {
      const message = error.message.replace(activeCredentialPattern, redacted)
      if (message !== error.message) {
        replaceText(error, "message", message)
      }
    }

    if (typeof error.stack === "string") {
      const stack = scrubStackHead(error.stack, activeCredentialPattern)
      if (stack !== error.stack) {
        replaceText(error, "stack", stack)
      }
    }
  }

  sanitizeTransportError(error.cause, seen)

  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      sanitizeTransportError(inner, seen)
    }
  }
}

/**
 * fetch for an upstream call, through this process's upstream dispatcher.
 *
 * A request that fails without a response rejects with its error cleaned by
 * sanitizeTransportError, before any caller can log it. The undici response is rewrapped as a
 * global Response, so callers, HTTPError included, keep the Response type the rest of the relay
 * uses.
 */
export const fetchUpstream = async (url: string, init: UpstreamRequestInit): Promise<Response> => {
  const response = await undiciFetch(url, { ...init, dispatcher: upstreamDispatcher }).catch((error: unknown) => {
    sanitizeTransportError(error)
    noteConnectionFailure(init.signal)
    throw error
  })

  const wrappedResponse = new Response(response.body as ReadableStream<Uint8Array> | null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  // The Response constructor cannot set url; upstream error logs report it.
  Object.defineProperty(wrappedResponse, "url", { value: response.url })
  return wrappedResponse
}
