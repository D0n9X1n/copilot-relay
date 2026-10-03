// The one undici dispatcher every upstream call goes through: the Copilot API and GitHub sign-in.
// Calls to the relay's own listener, such as the status probes, use the global fetch instead.
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici"

import { log } from "~/lib/log"
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
 * Builds this process's upstream dispatcher from the resolved upstreamProxy.
 *
 * start, auth, models and usage call it once, after reading the config and before their first
 * upstream call. Until one does, upstream calls connect directly, as they did before the key existed. A
 * config reload never calls it, which is why upstreamProxy, like host and port, takes effect on
 * restart. It is never undici's global dispatcher, so calls to the relay itself stay direct.
 */
export const configureUpstreamDispatcher = (upstreamProxy: string | undefined): void => {
  const previous = upstreamDispatcher
  upstreamDispatcher = buildUpstreamDispatcher(upstreamProxy)
  configuredUpstreamProxy = upstreamProxy

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

/**
 * fetch for an upstream call, through this process's upstream dispatcher.
 *
 * The undici response is rewrapped as a global Response, so callers, HTTPError included, keep the
 * Response type the rest of the relay uses.
 */
export const fetchUpstream = async (url: string, init: UpstreamRequestInit): Promise<Response> => {
  const response = await undiciFetch(url, { ...init, dispatcher: upstreamDispatcher }).catch((error: unknown) => {
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
