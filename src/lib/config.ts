// Converts hot-loaded app config into the mutable runtime config shared with routes.
import type { AppConfig } from "~/lib/app-config"
import type { CopilotModelCatalog } from "~/copilot/models"
import type { RequestTrace } from "./request-trace"

const vscodeVersion = "1.99.3"

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
}

export interface ProxyEnv {
  Variables: {
    config: ProxyConfig
    requestErrorMessage?: string
    requestId: string
    requestTrace?: RequestTrace
  }
}

const snapshotRoots = new WeakMap<ProxyConfig, ProxyConfig>()

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
})
