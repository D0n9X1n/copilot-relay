import { defineCommand } from "citty"

import { loadCopilotModelCatalog } from "~/copilot/models"
import { readAppConfig } from "~/lib/app-config"
import { setupProxyAuth } from "~/lib/auth"
import { readProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { log, setLogLevel } from "~/lib/log"
import { registerSensitiveOrigin, sanitizeTerminalString, scrubSensitiveUrls } from "~/lib/redact"

export const models = defineCommand({
  meta: {
    name: "models",
    description: "List all models advertised by the configured upstream, without inference probes.",
  },
  async run() {
    let failure = "Could not load relay configuration"
    try {
      const appConfig = await readAppConfig()
      setLogLevel(appConfig.logLevel)
      registerSensitiveOrigin(appConfig.copilotBaseUrl)
      const config = readProxyConfig(appConfig)

      failure = "Could not authenticate with GitHub Copilot"
      await setupProxyAuth(config)
      failure = "Could not fetch upstream model catalog"
      const catalog = await loadCopilotModelCatalog(config)
      const ids = [...catalog.models.keys()].sort().map(sanitizeTerminalString)
      console.log(scrubSensitiveUrls(ids.length ?
        `Upstream-advertised models (${ids.length}):\n${ids.join("\n")}`
        : "No models advertised by upstream."))
      console.log("Inference, tool, and effort compatibility are not verified by this listing.")
    } catch (error) {
      let detail = "Check configuration, authentication, and upstream connectivity."
      if (error instanceof HTTPError) {
        // The client wraps local aborts in synthetic HTTP responses.
        detail = error.detail !== undefined ?
            error.response.status === 504 ? "request timed out" : "request cancelled"
          : `HTTP ${error.response.status}`
        await error.response.body?.cancel().catch(() => {})
      }
      log.error(`${failure}: ${detail}`)
      process.exitCode = 1
    }
  },
})
