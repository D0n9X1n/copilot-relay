import { defineCommand } from "citty"

import { loadCopilotModelCatalog } from "~/copilot/models"
import { readAppConfig } from "~/lib/app-config"
import { setupProxyAuth } from "~/lib/auth"
import { readProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { log, setLogLevel } from "~/lib/log"
import { probeModels } from "~/lib/model-probe"
import { isReasoningEffort } from "~/lib/models"
import { registerSensitiveOrigin, sanitizeTerminalString, scrubSensitiveUrls } from "~/lib/redact"

export const models = defineCommand({
  meta: {
    name: "models",
    description: "List upstream models; use --deep to test inference availability.",
  },
  args: {
    deep: { type: "boolean", description: "Send real inference probes through an isolated relay pipeline; consumes Copilot usage." },
    model: { type: "string", description: "Test only this exact upstream ID (requires --deep)." },
    effort: { type: "string", description: "Probe effort override; otherwise use the lowest advertised effort, or unverified low." },
    "max-tokens": { type: "string", description: "Output budget per probe (default 4096; bounded by catalog limits)." },
    timeout: { type: "string", description: "Positive per-probe timeout in seconds (default 30; bounded by configured timeout)." },
    "total-timeout": { type: "string", description: "Positive timeout in seconds for all probes (default 300)." },
  },
  async run({ args }) {
    let failure = "Invalid model check options"
    try {
      const positive = (value: string | undefined, fallback: number) => {
        if (value === undefined) return fallback
        const number = Number(value)
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number <= 0 || number > 2_147_483) throw new Error("invalid option")
        return number
      }
      if (!args.deep && [args.model, args.effort, args["max-tokens"], args.timeout, args["total-timeout"]].some((value) => value !== undefined)) throw new Error("deep required")
      if (args.effort !== undefined && !isReasoningEffort(args.effort)) throw new Error("invalid effort")
      const probeOptions = {
        maxTokens: positive(args["max-tokens"], 4096),
        timeoutMs: positive(args.timeout, 30) * 1000,
        totalTimeoutMs: positive(args["total-timeout"], 300) * 1000,
        effort: args.effort,
      }
      failure = "Could not load relay configuration"
      const appConfig = await readAppConfig()
      setLogLevel(appConfig.logLevel)
      registerSensitiveOrigin(appConfig.copilotBaseUrl)
      const config = readProxyConfig(appConfig)

      failure = "Could not authenticate with GitHub Copilot"
      await setupProxyAuth(config)
      failure = "Could not fetch upstream model catalog"
      const catalog = await loadCopilotModelCatalog(config)
      if (args.deep) {
        failure = "Selected model is not advertised by upstream"
        if (args.model !== undefined && !catalog.models.has(args.model)) throw new Error("unknown model")
        const entries = [...catalog.models].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
          .filter(([id]) => args.model === undefined || args.model === id)
        failure = "Could not complete model availability checks"
        process.exitCode = await probeModels(config, entries, probeOptions)
        return
      }
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
