// Converts hot-loaded app config into the mutable runtime config shared with routes.
import type { AppConfig } from "~/lib/app-config"
import type { CopilotModelCatalog } from "~/copilot/models"
import type { RequestTrace } from "./request-trace"

export const vscodeVersion = "1.99.3"

export interface ProxyConfig {
  host: string
  port: number
  copilotBaseUrl: string
  copilotToken: string | undefined
  copilotTokenGeneration?: number
  refreshCopilotToken?: (rejectedToken: string, generation: number) => Promise<void>
  modelCatalog?: CopilotModelCatalog
  upstreamTimeoutMs: number
  vsCodeVersion: string
  webSearchBackend?: string
  claudeUpstreamApi?: "auto" | "messages" | "chat-completions"
  // The inbound key clients must present; empty or absent disables the check. Admission reads it
  // from the live config on every request, so a hot reload applies to the next one.
  apiKey?: string
}

export interface ProxyEnv {
  // Set only by the relay's own in-process calls, such as the model probe; no client can set it.
  Bindings: {
    relayProbe?: boolean
  }
  Variables: {
    config: ProxyConfig
    requestErrorMessage?: string
    requestId: string
    requestTrace?: RequestTrace
  }
}

// Each snapshot's live config, so a model catalog fetched during a request also reaches later ones.
const snapshotRoots = new WeakMap<ProxyConfig, ProxyConfig>()

// Fields are frozen when the request arrives, except the token: auth refreshes it on the live
// config, and a request that started before the refresh must still send the new one.
export const snapshotProxyConfig = (config: ProxyConfig): ProxyConfig => {
  const snapshot = {
    ...config,
    get copilotToken() {
      return config.copilotToken
    },
    get copilotTokenGeneration() {
      return config.copilotTokenGeneration
    },
  }

  snapshotRoots.set(snapshot, snapshotRoots.get(config) ?? config)
  return snapshot
}

export const publishCopilotModelCatalog = (config: ProxyConfig, catalog: CopilotModelCatalog): void => {
  if (config.copilotBaseUrl === catalog.baseUrl) {
    config.modelCatalog = catalog
  }

  const root = snapshotRoots.get(config)
  if (root?.copilotBaseUrl === catalog.baseUrl) {
    root.modelCatalog = catalog
  }
}

export const readProxyConfig = (config: AppConfig): ProxyConfig => ({
  copilotBaseUrl: config.copilotBaseUrl,
  copilotToken: undefined,
  host: config.host,
  port: config.port,
  upstreamTimeoutMs: config.upstreamTimeoutSeconds * 1000,
  vsCodeVersion: vscodeVersion,
  webSearchBackend: config.webSearchBackend,
  claudeUpstreamApi: config.claudeUpstreamApi,
  apiKey: config.apiKey,
})
