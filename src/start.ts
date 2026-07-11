// `copilot-relay start`: loads config, validates upstream access, and starts the local Claude Code proxy.
import { defineCommand } from "citty"

import { setupProxyAuth } from "~/lib/auth"
import { readAppConfig, watchAppConfig, type AppConfig } from "~/lib/app-config"
import { applyClaudeConfig } from "~/lib/claude-settings"
import { readProxyConfig } from "~/lib/config"
import { claudeConfigPath as defaultClaudeConfigPath } from "~/lib/defaults"
import { clearRelayPidFile, writeRelayPidFile } from "~/lib/lifecycle"
import { cleanupLogs, log, setLogLevel } from "~/lib/log"
import { getExposedModelIds } from "~/lib/models"
import { validateUpstream } from "~/lib/preflight"
import { runtimeState } from "~/lib/state"
import { appVersion } from "~/lib/version"
import { startServer } from "~/server"

export async function startRelay(appConfig?: AppConfig): Promise<void> {
  appConfig ??= await readAppConfig()
  setLogLevel(appConfig.logLevel)
  await cleanupLogs(appConfig.logRetentionDays)

  const claudeConfigPath = defaultClaudeConfigPath
  const config = readProxyConfig(appConfig)
  const applyRuntimeConfig = (nextConfig: AppConfig) => {
    // Hot reload updates behavior for future requests; it intentionally does
    // not rebind the already-listening socket when host or port changes.
    setLogLevel(nextConfig.logLevel)
    void cleanupLogs(nextConfig.logRetentionDays)
    runtimeState.debug = nextConfig.logLevel === "debug"
    runtimeState.thinkEffort = nextConfig.thinkEffort
    config.copilotBaseUrl = nextConfig.copilotBaseUrl
    config.host = nextConfig.host
    config.port = nextConfig.port
    config.upstreamTimeoutMs = nextConfig.upstreamTimeoutSeconds * 1000
    config.webSearchBackend = nextConfig.webSearchBackend
    runtimeState.modelRouting = {
      gptModel: nextConfig.gptModel,
      opusModel: nextConfig.opusModel,
    }
  }
  applyRuntimeConfig(appConfig)

  log.info(`Log level: ${appConfig.logLevel}`)
  log.info(`Think effort: ${appConfig.thinkEffort}`)
  log.info(`Upstream timeout: ${appConfig.upstreamTimeoutSeconds}s`)
  log.info(`Exposed models: ${getExposedModelIds().join(", ")}`)

  const authSession = await setupProxyAuth(config)

  try {
    await validateUpstream(config, appConfig.thinkEffort)
  } catch (error) {
    log.error("Startup preflight failed:", error)
    process.exit(1)
  }

  const server = await startServer(config)
  await writeRelayPidFile(config)

  log.info(`copilot-relay version: ${appVersion}`)
  if (authSession.githubLogin) {
    log.info(`GitHub user: ${authSession.githubLogin}`)
  } else {
    log.error("GitHub user: unavailable")
  }

  log.info(
    `copilot-relay listening on http://${config.host}:${config.port}`,
  )
  log.info(`copilot base url: ${config.copilotBaseUrl}`)

  const baseUrl = `http://${config.host}:${config.port}`
  if (appConfig.claudeSetup) {
    try {
      const claudeResult = await applyClaudeConfig({
        baseUrl,
        configPath: claudeConfigPath,
        gptModel: appConfig.gptModel,
      })
      if (claudeResult.changed) {
        log.info(
          `claude settings ${claudeResult.created ? "created" : "updated"}: ${claudeResult.configPath}`,
        )
        if (
          claudeResult.previousBaseUrl
          && claudeResult.previousBaseUrl !== baseUrl
        ) {
          log.info(
            `ANTHROPIC_BASE_URL: ${claudeResult.previousBaseUrl} → ${baseUrl}`,
          )
        }
      } else {
        log.info(
          `claude settings already up to date: ${claudeResult.configPath}`,
        )
      }
    } catch (error) {
      log.error(
        `Could not update claude settings (${claudeConfigPath}):`,
        error,
      )
    }
  }
  watchAppConfig((nextConfig) => {
    applyRuntimeConfig(nextConfig)
    log.info(
      `Config reloaded: logLevel=${nextConfig.logLevel} thinkEffort=${nextConfig.thinkEffort} upstreamTimeoutSeconds=${nextConfig.upstreamTimeoutSeconds}`,
    )
  })

  const shutdown = (signal: NodeJS.Signals) => {
    log.info(`Received ${signal}; shutting down copilot-relay`)
    server.close((error) => {
      if (error) {
        log.error("Error while shutting down copilot-relay:", error)
        process.exitCode = 1
      }
    })
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)

  try {
    await new Promise<void>((resolve, reject) => {
      server.on("close", resolve)
      server.on("error", reject)
    })
  } finally {
    process.off("SIGINT", shutdown)
    process.off("SIGTERM", shutdown)
    await clearRelayPidFile()
  }
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the copilot-relay HTTP server.",
  },
  async run() {
    await startRelay()
  },
})
