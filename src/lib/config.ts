import type { AppConfig } from "~/lib/app-config"

const vscodeVersion = "1.99.3"

export interface ProxyConfig {
  host: string
  port: number
  copilotBaseUrl: string
  copilotToken: string | undefined
  vsCodeVersion: string
}

export interface ProxyEnv {
  Variables: {
    config: ProxyConfig
  }
}

export const readProxyConfig = (config: AppConfig): ProxyConfig => ({
  copilotBaseUrl: config.copilotBaseUrl,
  copilotToken: undefined,
  host: config.host,
  port: config.port,
  vsCodeVersion: vscodeVersion,
})
