// Low-level GitHub Copilot HTTP client: adds required headers, retries transient failures, and logs timing.
import { randomUUID } from "node:crypto"

import { Agent, fetch as undiciFetch } from "undici"

import type { ProxyConfig } from "~/lib/config"
import { HTTPError, ProxyNotImplementedError } from "~/lib/error"
import { log } from "~/lib/log"

const copilotVersion = "0.26.7"
const editorPluginVersion = `copilot-chat/${copilotVersion}`
const userAgent = `GitHubCopilotChat/${copilotVersion}`
const apiVersion = "2025-04-01"
const maxFetchAttempts = 2
export const copilotRequestTimeoutMs = 180_000
const copilotDispatcher = new Agent({
  allowH2: false,
  connect: { allowH2: false },
})

export interface CopilotProviderContext {
  baseUrl: string
  token: string | undefined
  tokenGeneration?: number
  refreshToken?: ProxyConfig["refreshCopilotToken"]
  vsCodeVersion: string
}

export const getCopilotProviderContext = (
  config: ProxyConfig,
): CopilotProviderContext => ({
  baseUrl: config.copilotBaseUrl,
  get token() { return config.copilotToken },
  get tokenGeneration() { return config.copilotTokenGeneration ?? 0 },
  refreshToken: config.refreshCopilotToken,
  vsCodeVersion: config.vsCodeVersion,
})

export interface FetchCopilotOptions {
  vision?: boolean
  initiator?: "agent" | "user"
  requestId?: string
  signal?: AbortSignal
  timeoutMs?: number
}

interface CopilotRequestInit {
  body?: string
  headers?: RequestInit["headers"]
  method?: string
}

const shouldRetryResponse = (response: Response): boolean =>
  // Retry only transient upstream failures; 4xx responses may contain routing
  // signals, such as "unsupported_api_for_model", that callers need to inspect.
  response.status >= 500 && response.status <= 599

export const createCopilotRequestSignal = (
  signal?: AbortSignal,
  timeoutMs = copilotRequestTimeoutMs,
): AbortSignal | undefined => {
  const signals = [
    signal,
    timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  ].filter((value): value is AbortSignal => value !== undefined)

  if (signals.length === 0) {
    return undefined
  }

  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

const getAbortName = (value: unknown): string | undefined =>
  typeof value === "object"
  && value !== null
  && "name" in value
  && typeof value.name === "string" ?
    value.name
  : undefined

const isAbortLikeError = (error: unknown): boolean => {
  const name = getAbortName(error)
  return name === "AbortError" || name === "TimeoutError"
}

const getErrorCode = (value: unknown): string | undefined =>
  typeof value === "object"
  && value !== null
  && "code" in value
  && typeof value.code === "string" ?
    value.code
  : undefined

export const isRetryableFetchError = (error: unknown): boolean =>
  getErrorCode(error) === "ERR_HTTP2_INVALID_SESSION"
  || (
    typeof error === "object"
    && error !== null
    && "cause" in error
    && getErrorCode(error.cause) === "ERR_HTTP2_INVALID_SESSION"
  )

export const toCopilotAbortHTTPError = (
  error: unknown,
  signal: AbortSignal | undefined,
  timeoutMs = copilotRequestTimeoutMs,
): HTTPError | undefined => {
  if (!signal?.aborted && !isAbortLikeError(error)) {
    return undefined
  }

  const timedOut =
    getAbortName(signal?.reason) === "TimeoutError"
    || getAbortName(error) === "TimeoutError"
  const message =
    timedOut ?
      `Copilot upstream request timed out after ${Math.round(timeoutMs / 1000)}s.`
    : "Client request cancelled before Copilot upstream completed."
  const code = timedOut ? "upstream_timeout" : "request_cancelled"

  return new HTTPError(
    message,
    new Response(JSON.stringify({ error: { message, code } }), {
      status: timedOut ? 504 : 499,
      headers: { "content-type": "application/json" },
    }),
    message,
  )
}

export const readCopilotJson = async <T>(
  response: Response,
  signal: AbortSignal | undefined,
  timeoutMs = copilotRequestTimeoutMs,
): Promise<T> => {
  try {
    return (await response.json()) as T
  } catch (error) {
    throw toCopilotAbortHTTPError(error, signal, timeoutMs) ?? error
  }
}

export const readCopilotText = async (
  response: Response,
  signal: AbortSignal | undefined,
  timeoutMs = copilotRequestTimeoutMs,
): Promise<string> => {
  try {
    return await response.text()
  } catch (error) {
    throw toCopilotAbortHTTPError(error, signal, timeoutMs) ?? error
  }
}

const buildHeaders = (
  provider: CopilotProviderContext,
  init: CopilotRequestInit,
  options: FetchCopilotOptions,
  upstreamRequestId: string,
): Record<string, string> => {
  const headers = new Headers(init.headers)

  headers.set("authorization", `Bearer ${provider.token}`)
  headers.set("copilot-integration-id", "vscode-chat")
  headers.set("editor-version", `vscode/${provider.vsCodeVersion}`)
  headers.set("editor-plugin-version", editorPluginVersion)
  headers.set("user-agent", userAgent)
  headers.set("openai-intent", "conversation-panel")
  headers.set("x-github-api-version", apiVersion)
  headers.set("x-request-id", upstreamRequestId)
  headers.set("x-vscode-user-agent-library-version", "electron-fetch")

  if (options.vision) {
    headers.set("copilot-vision-request", "true")
  }

  if (options.initiator) {
    headers.set("x-initiator", options.initiator)
  }

  if (!headers.has("content-type") && init.body !== undefined) {
    headers.set("content-type", "application/json")
  }

  if (!headers.has("accept")) {
    headers.set("accept", "application/json")
  }

  return Object.fromEntries(headers.entries())
}

const formatRequestId = (requestId: string | undefined): string =>
  requestId ? `request_id=${requestId} ` : ""

const logUpstreamLifecycle = (
  requestId: string | undefined,
  message: string,
): void => {
  if (requestId) {
    log.info(`${formatRequestId(requestId)}${message}`)
    return
  }

  log.debug(message)
}

const waitWithSignal = <T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> => {
  if (!signal) return pending
  if (signal.aborted) {
    void pending.catch(() => {})
    return Promise.reject(signal.reason)
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

const isAuthRejection = async (response: Response, signal: AbortSignal | undefined): Promise<boolean> => {
  if (response.status === 401) return true
  if (response.status !== 403) return false
  const reader = response.clone().body?.getReader()
  if (!reader) return false
  const decoder = new TextDecoder()
  let text = ""
  let size = 0
  try {
    for (;;) {
      const chunk = await waitWithSignal(reader.read(), signal)
      if (chunk.done) return (text + decoder.decode()).trim().toLowerCase() === "forbidden"
      size += chunk.value.byteLength
      if (size > 128) return false
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch (error) {
    if (signal?.aborted) throw error
    return false
  } finally {
    // A tee branch's cancellation may wait for the other branch to finish.
    void reader.cancel().catch(() => {})
  }
}

export const fetchCopilot = async (
  provider: CopilotProviderContext,
  path: string,
  init: CopilotRequestInit,
  options: FetchCopilotOptions = {},
) => {
  if (!provider.token) {
    throw new ProxyNotImplementedError(
      "Copilot token is not configured for copilot-relay.",
    )
  }

  const timeoutMs = options.timeoutMs ?? copilotRequestTimeoutMs
  const signal = createCopilotRequestSignal(options.signal, timeoutMs)
  let lastError: unknown
  let transientRetries = 0
  let authRecoveryUsed = false

  for (let attempt = 1; attempt <= maxFetchAttempts + 1; attempt++) {
    const upstreamRequestId = randomUUID()
    const attemptedToken = provider.token!
    const attemptedGeneration = provider.tokenGeneration ?? 0
    let response: Response
    try {
      const started = performance.now()
      logUpstreamLifecycle(
        options.requestId,
        `send upstream method=${init.method ?? "GET"} path=${path} attempt=${attempt} upstream_request_id=${upstreamRequestId}`,
      )
      response = await undiciFetch(`${provider.baseUrl}${path}`, {
        ...init,
        headers: buildHeaders({ ...provider, token: attemptedToken }, init, options, upstreamRequestId),
        dispatcher: copilotDispatcher,
        signal,
      })
      const ms = Math.round(performance.now() - started)
      logUpstreamLifecycle(
        options.requestId,
        `return from upstream method=${init.method ?? "GET"} path=${path} status=${response.status} ms=${ms} attempt=${attempt} upstream_request_id=${upstreamRequestId}`,
      )
      log.debug(
        `${formatRequestId(options.requestId)}Copilot ${init.method ?? "GET"} ${path} -> ${response.status} ${ms}ms (attempt ${attempt}) upstream_request_id=${upstreamRequestId}`,
      )
    } catch (error) {
      const abortError = toCopilotAbortHTTPError(error, signal, timeoutMs)
      if (abortError) {
        logUpstreamLifecycle(
          options.requestId,
          `upstream failed method=${init.method ?? "GET"} path=${path} attempt=${attempt} upstream_request_id=${upstreamRequestId}`,
        )
        throw abortError
      }

      logUpstreamLifecycle(
        options.requestId,
        `upstream failed method=${init.method ?? "GET"} path=${path} attempt=${attempt} upstream_request_id=${upstreamRequestId}`,
      )
      lastError = error
      if (transientRetries >= maxFetchAttempts - 1) {
        log.error(
          `${formatRequestId(options.requestId)}Copilot ${path} request failed after ${attempt} attempts upstream_request_id=${upstreamRequestId}`,
          error,
        )
        throw error
      }
      transientRetries++
      log.error(
        `${formatRequestId(options.requestId)}Copilot ${path} request failed; retrying (${transientRetries}/${maxFetchAttempts}) upstream_request_id=${upstreamRequestId}`,
        error,
      )
      continue
    }

    try {
      signal?.throwIfAborted()
      if (!authRecoveryUsed && provider.refreshToken && await isAuthRejection(response, signal)) {
        authRecoveryUsed = true
        log.info(`${formatRequestId(options.requestId)}Copilot ${path} authentication rejected status=${response.status}; refreshing token`)
        await response.body?.cancel()
        signal?.throwIfAborted()
        await waitWithSignal(provider.refreshToken(attemptedToken, attemptedGeneration), signal)
        signal?.throwIfAborted()
        log.info(`${formatRequestId(options.requestId)}Copilot token refresh completed; retrying ${path}`)
        continue
      }
    } catch (error) {
      void response.body?.cancel().catch(() => {})
      const abortError = toCopilotAbortHTTPError(error, signal, timeoutMs)
      if (abortError) throw abortError
      log.error(`${formatRequestId(options.requestId)}Copilot token recovery failed; request not replayed`)
      throw new Error("Copilot token recovery failed; request not replayed.")
    }
    if (!shouldRetryResponse(response) || transientRetries >= maxFetchAttempts - 1) return response
    transientRetries++
    log.error(`${formatRequestId(options.requestId)}Copilot ${path} returned ${response.status}; retrying (${transientRetries}/${maxFetchAttempts}) upstream_request_id=${upstreamRequestId}`)
    await response.body?.cancel()
  }

  throw lastError
}
