// Converts hot-loaded app config into the mutable runtime config shared with routes.
import type { AppConfig } from "~/lib/app-config"

const vscodeVersion = "1.99.3"

export interface ProxyConfig {
  host: string
  port: number
  copilotBaseUrl: string
  copilotToken: string | undefined
  upstreamTimeoutMs: number
  vsCodeVersion: string
  webSearchBackend?: string
}

export interface ProxyEnv {
  Variables: {
    config: ProxyConfig
    requestErrorMessage?: string
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
})
