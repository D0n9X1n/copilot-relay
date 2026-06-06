// Low-level GitHub Copilot HTTP client: adds required headers, retries transient failures, and logs timing.
import { randomUUID } from "node:crypto"

import type { ProxyConfig } from "~/lib/config"
import { ProxyNotImplementedError } from "~/lib/error"
import { log } from "~/lib/log"

const copilotVersion = "0.26.7"
const editorPluginVersion = `copilot-chat/${copilotVersion}`
const userAgent = `GitHubCopilotChat/${copilotVersion}`
const apiVersion = "2025-04-01"
const maxFetchAttempts = 2

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
}

const shouldRetryResponse = (response: Response): boolean =>
  // Retry only transient upstream failures; 4xx responses may contain routing
  // signals, such as "unsupported_api_for_model", that callers need to inspect.
  response.status >= 500 && response.status <= 599

const buildHeaders = (
  provider: CopilotProviderContext,
  init: RequestInit,
  options: FetchCopilotOptions,
): Headers => {
  const headers = new Headers(init.headers)

  headers.set("authorization", `Bearer ${provider.token}`)
  headers.set("copilot-integration-id", "vscode-chat")
  headers.set("editor-version", `vscode/${provider.vsCodeVersion}`)
  headers.set("editor-plugin-version", editorPluginVersion)
  headers.set("user-agent", userAgent)
  headers.set("openai-intent", "conversation-panel")
  headers.set("x-github-api-version", apiVersion)
  headers.set("x-request-id", randomUUID())
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

  let lastError: unknown

  for (let attempt = 1; attempt <= maxFetchAttempts; attempt++) {
    try {
      const started = performance.now()
      const response = await fetch(`${provider.baseUrl}${path}`, {
        ...init,
        headers: buildHeaders(provider, init, options),
      })
      const ms = Math.round(performance.now() - started)
      log.debug(
        `Copilot ${init.method ?? "GET"} ${path} -> ${response.status} ${ms}ms (attempt ${attempt})`,
      )

      if (!shouldRetryResponse(response) || attempt === maxFetchAttempts) {
        return response
      }
      log.warn(
        `Copilot ${path} returned ${response.status}; retrying (${attempt}/${maxFetchAttempts})`,
      )
    } catch (error) {
      lastError = error
      if (attempt === maxFetchAttempts) {
        throw error
      }
      log.warn(
        `Copilot ${path} request failed; retrying (${attempt}/${maxFetchAttempts})`,
        error,
      )
    }
  }

  throw lastError
}
