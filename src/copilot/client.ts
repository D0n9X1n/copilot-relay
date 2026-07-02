// Low-level GitHub Copilot HTTP client: adds required headers, retries transient failures, and logs timing.
import { randomUUID } from "node:crypto"

import type { ProxyConfig } from "~/lib/config"
import { HTTPError, ProxyNotImplementedError } from "~/lib/error"
import { log } from "~/lib/log"

const copilotVersion = "0.26.7"
const editorPluginVersion = `copilot-chat/${copilotVersion}`
const userAgent = `GitHubCopilotChat/${copilotVersion}`
const apiVersion = "2025-04-01"
const maxFetchAttempts = 2
export const copilotRequestTimeoutMs = 180_000

export interface CopilotProviderContext {
  baseUrl: string
  token: string | undefined
  vsCodeVersion: string
}

export const getCopilotProviderContext = (
  config: ProxyConfig,
): CopilotProviderContext => ({
  baseUrl: config.copilotBaseUrl,
  token: config.copilotToken,
  vsCodeVersion: config.vsCodeVersion,
})

export interface FetchCopilotOptions {
  vision?: boolean
  initiator?: "agent" | "user"
  requestId?: string
  signal?: AbortSignal
  timeoutMs?: number
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
  init: RequestInit,
  options: FetchCopilotOptions,
  upstreamRequestId: string,
): Headers => {
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

  return headers
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

export const fetchCopilot = async (
  provider: CopilotProviderContext,
  path: string,
  init: RequestInit,
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

  for (let attempt = 1; attempt <= maxFetchAttempts; attempt++) {
    const upstreamRequestId = randomUUID()
    try {
      const started = performance.now()
      logUpstreamLifecycle(
        options.requestId,
        `send upstream method=${init.method ?? "GET"} path=${path} attempt=${attempt} upstream_request_id=${upstreamRequestId}`,
      )
      const response = await fetch(`${provider.baseUrl}${path}`, {
        ...init,
        headers: buildHeaders(provider, init, options, upstreamRequestId),
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

      if (!shouldRetryResponse(response) || attempt === maxFetchAttempts) {
        return response
      }
      log.error(
        `${formatRequestId(options.requestId)}Copilot ${path} returned ${response.status}; retrying (${attempt}/${maxFetchAttempts}) upstream_request_id=${upstreamRequestId}`,
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
      if (attempt === maxFetchAttempts) {
        log.error(
          `${formatRequestId(options.requestId)}Copilot ${path} request failed after ${attempt} attempts upstream_request_id=${upstreamRequestId}`,
          error,
        )
        throw error
      }
      log.error(
        `${formatRequestId(options.requestId)}Copilot ${path} request failed; retrying (${attempt}/${maxFetchAttempts}) upstream_request_id=${upstreamRequestId}`,
        error,
      )
    }
  }

  throw lastError
}
