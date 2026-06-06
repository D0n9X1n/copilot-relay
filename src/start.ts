import { defineCommand } from "citty"

import { setupProxyAuth } from "~/lib/auth"
import { readAppConfig, watchAppConfig, type AppConfig } from "~/lib/app-config"
import { applyClaudeConfig } from "~/lib/claude-settings"
import { readProxyConfig } from "~/lib/config"
import { CLAUDE_configPath } from "~/lib/defaults"
import { log, setLogLevel } from "~/lib/log"
import { getExposedModelIds } from "~/lib/models"
import { validateUpstream } from "~/lib/preflight"
import { runtimeState } from "~/lib/state"
import { appVersion } from "~/lib/version"
import { startServer } from "~/server"

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the copilot-relay HTTP server.",
  },
  args: {
    "show-token": {
      type: "boolean",
      default: false,
      description: "Print GitHub and Copilot tokens during startup.",
    },
  },
  async run({ args }) {
    const appConfig = await readAppConfig()
    setLogLevel(appConfig.logLevel)

    const claudeConfigPath = CLAUDE_configPath
    const config = readProxyConfig(appConfig)
    const applyRuntimeConfig = (nextConfig: AppConfig) => {
      setLogLevel(nextConfig.logLevel)
      runtimeState.debug = nextConfig.logLevel === "debug" || nextConfig.logLevel === "trace"
      runtimeState.thinkEffort = nextConfig.thinkEffort
      config.copilotBaseUrl = nextConfig.copilotBaseUrl
      config.host = nextConfig.host
      config.port = nextConfig.port
      runtimeState.modelRouting = {
        gptModel: nextConfig.gptModel,
        opusModel: nextConfig.opusModel,
      }
    }
    applyRuntimeConfig(appConfig)

    if (runtimeState.debug) {
      log.info("Debug diagnostics enabled; upstream errors include request summaries")
    }
    log.info(`Log level: ${appConfig.logLevel}`)
    log.info(`Think effort: ${appConfig.thinkEffort}`)
    log.info(`Exposed models: ${getExposedModelIds().join(", ")}`)

    const authSession = await setupProxyAuth(config, {
      showToken: args["show-token"],
    })

    try {
      await validateUpstream(config, appConfig.thinkEffort)
    } catch (error) {
      log.error("Startup preflight failed:", error)
      process.exit(1)
    }

    const server = startServer(config)

    log.info(`copilot-relay version: ${appVersion}`)
    if (authSession.githubLogin) {
      log.info(`GitHub user: ${authSession.githubLogin}`)
    } else {
      log.warn("GitHub user: unavailable")
    }

    log.success(
      `copilot-relay listening on http://${config.host}:${config.port}`,
    )
    log.debug(`copilot base url: ${config.copilotBaseUrl}`)

    const baseUrl = `http://${config.host}:${config.port}`
    if (appConfig.claudeSetup) {
      try {
        const claudeResult = await applyClaudeConfig({
          baseUrl,
          configPath: claudeConfigPath,
        })
        if (claudeResult.changed) {
          log.success(
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
        log.warn(
          `Could not update claude settings (${claudeConfigPath}):`,
          error,
        )
      }
    }
    watchAppConfig((nextConfig) => {
      applyRuntimeConfig(nextConfig)
      log.info(
        `Config reloaded: logLevel=${nextConfig.logLevel} thinkEffort=${nextConfig.thinkEffort}`,
      )
    })

    await new Promise<void>((resolve, reject) => {
      server.on("close", resolve)
      server.on("error", reject)
    })
  },
})
