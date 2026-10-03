import { defineCommand } from "citty"

import { selectCopilotEndpoint } from "~/copilot/endpoint"
import { loadCopilotModelCatalog, type CopilotModelCatalog } from "~/copilot/models"
import { readAppConfig, type AppConfig } from "~/lib/app-config"
import { setupProxyAuth } from "~/lib/auth"
import { readProxyConfig, type ProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { flushLogs, log, registerLogSecret, scrubLogSecrets, setLogLevel, withoutConsoleLogging } from "~/lib/log"
import { terminalText } from "~/lib/terminal"
import { probeModels } from "~/lib/model-probe"
import { probeReason } from "~/lib/model-probe-output"
import {
  normalizeModelSearch,
  renderConfigGuide,
  renderModelRows,
  searchModels,
  type ConfiguredModel,
  type ListedModel,
  type ModelSearch,
} from "~/lib/model-listing"
import { isReasoningEffort, normalizeCopilotModelId } from "~/lib/models"
import { paths } from "~/lib/paths"
import { registerSensitiveOrigin, scrubSensitiveUrls } from "~/lib/redact"
import { configureUpstreamDispatcher } from "~/lib/upstream-dispatcher"

// A mistake in how the command was called. Its message replaces the generic connectivity advice.
class ModelsUsageError extends Error {}

// A catalog, config or search string as it may be printed. terminalText first removes ANSI
// escapes, C0 and C1 controls, invisible format characters and line separators, any of which can
// sit inside a secret and keep it from matching; then every registered secret, such as the
// relay's apiKey, is replaced. Callers apply it before shortening or padding, because a key cut in
// two would escape the scrub that runs on each printed line.
const printable = (text: string): string => scrubLogSecrets(terminalText(text))

// Catalog names are untrusted: control characters and secrets are removed and a long name is
// shortened so it cannot take over a row.
const displayName = (name: string | undefined): string | undefined => {
  const text = printable(name ?? "").trim()

  if (text === "") {
    return undefined
  }

  return text.length > 80 ? `${text.slice(0, 77)}...` : text
}

// Every advertised ID, with the reason request admission would refuse it as gptModel or opusModel.
const listedModels = (config: ProxyConfig, catalog: CopilotModelCatalog): ListedModel[] =>
  [...catalog.models.keys()].sort().map((id) => {
    const selection = selectCopilotEndpoint(config, id)
    const name = displayName(catalog.models.get(id)?.name)

    return {
      id: printable(id),
      ...(name !== undefined && { name }),
      ...(!selection.endpoint && { unusable: probeReason(selection.reason) }),
    }
  })

// The configured IDs, checked the way the startup check resolves them.
const configuredModels = (
  appConfig: AppConfig,
  config: ProxyConfig,
  catalog: CopilotModelCatalog,
): ConfiguredModel[] =>
  (["gptModel", "opusModel"] as const).map((key) => {
    const id = normalizeCopilotModelId(appConfig[key])
    const selection = selectCopilotEndpoint(config, id)

    return {
      key,
      value: printable(appConfig[key]),
      advertised: catalog.models.has(id),
      ...(!selection.endpoint && { unusable: probeReason(selection.reason) }),
    }
  })

const listingHeading = (search: string, result: ModelSearch): string => {
  if (search === "") {
    if (result.models.length === 0) {
      return "No models advertised by upstream."
    }

    return `Upstream-advertised models (${result.models.length}):`
  }

  const label = printable(search)

  if (result.found) {
    return `Upstream models matching "${label}" (${result.models.length}):`
  }

  if (result.models.length === 0) {
    return `No upstream model matches "${label}". List them all with copilot-relay models.`
  }

  return `No upstream model matches "${label}". Closest IDs (${result.models.length}):`
}

export const models = defineCommand({
  meta: {
    name: "models",
    description: "List upstream models; use --deep to test inference availability.",
  },
  args: {
    search: {
      type: "positional",
      required: false,
      description: "Find models by ID or display name and print the config line to use.",
    },
    deep: {
      type: "boolean",
      description: "Send real inference probes through an isolated relay pipeline; consumes Copilot usage.",
    },
    details: {
      type: "boolean",
      description: "Show safe request, route and replay evidence for each probe (requires --deep).",
    },
    model: {
      type: "string",
      description: "Test only this exact upstream ID (requires --deep).",
    },
    effort: {
      type: "string",
      description: "Probe effort override; otherwise use the lowest advertised effort, or unverified low.",
    },
    "max-tokens": {
      type: "string",
      description: "Output budget per probe (default 4096; bounded by catalog limits).",
    },
    timeout: {
      type: "string",
      description: "Positive per-probe timeout in seconds (default 30; bounded by configured timeout).",
    },
    "total-timeout": {
      type: "string",
      description: "Positive timeout in seconds for all probes (default 300).",
    },
  },
  async run({ args }) {
    // Each step records what it is attempting, so the catch below can say which
    // step failed without printing the raw error.
    let failure = "Invalid model check options"

    try {
      const positive = (value: string | undefined, fallback: number) => {
        if (value === undefined) {
          return fallback
        }

        // Timeouts arrive in seconds and become milliseconds. The cap keeps those
        // within a 32-bit timer delay; Node fires a longer one after 1 ms.
        const number = Number(value)
        if (
          !/^\d+$/.test(value)
          || !Number.isSafeInteger(number)
          || number <= 0
          || number > 2_147_483
        ) {
          throw new Error("invalid option")
        }

        return number
      }

      if (
        !args.deep
        && (
          args.details
          || [args.model, args.effort, args["max-tokens"], args.timeout, args["total-timeout"]]
            .some((value) => value !== undefined)
        )
      ) {
        throw new Error("deep required")
      }

      if (args.effort !== undefined && !isReasoningEffort(args.effort)) {
        throw new Error("invalid effort")
      }

      // Unquoted words form one search: `models sol fast` searches for "sol fast".
      const search = args._.join(" ").trim()

      if (search !== "" && args.deep) {
        throw new ModelsUsageError("A search lists models; check one with copilot-relay models --deep --model <id>.")
      }

      if (search !== "" && normalizeModelSearch(search) === "") {
        throw new ModelsUsageError("A search needs at least one letter or digit.")
      }

      const probeOptions = {
        maxTokens: positive(args["max-tokens"], 4096),
        timeoutMs: positive(args.timeout, 30) * 1000,
        totalTimeoutMs: positive(args["total-timeout"], 300) * 1000,
        effort: args.effort,
        details: Boolean(args.details),
      }

      const prepare = async () => {
        failure = "Could not load relay configuration"
        const appConfig = await readAppConfig()
        setLogLevel(appConfig.logLevel)
        registerSensitiveOrigin(appConfig.copilotBaseUrl)
        // --deep probes send the relay's apiKey to the in-process app.
        registerLogSecret(appConfig.apiKey)
        // Before authentication and the catalog request, this command's first upstream calls.
        configureUpstreamDispatcher(appConfig.upstreamProxy)
        const config = readProxyConfig(appConfig)

        failure = "Could not authenticate with GitHub Copilot"
        // --deep keeps setup logging off the console, which would also hide the
        // default sign-in prompt, so the device code is printed to stderr here.
        await setupProxyAuth(config, args.deep ? {
          onDeviceCode: (url, code) => console.error(
            `Sign in: open ${terminalText(url)} and enter ${terminalText(code)}.`,
          ),
        } : undefined)

        failure = "Could not fetch upstream model catalog"
        const catalog = await loadCopilotModelCatalog(config)
        return { appConfig, config, catalog }
      }

      const { appConfig, config, catalog } = args.deep ? await withoutConsoleLogging(prepare) : await prepare()

      if (args.deep) {
        failure = "Selected model is not advertised by upstream"
        if (args.model !== undefined && !catalog.models.has(args.model)) {
          throw new ModelsUsageError("Find the exact ID with copilot-relay models <search>.")
        }

        // Order by ID alone; a plain sort() would compare stringified [id, model] pairs.
        const entries = [...catalog.models]
          .sort(([a], [b]) => {
            if (a < b) {
              return -1
            }

            return a > b ? 1 : 0
          })
          .filter(([id]) => args.model === undefined || args.model === id)

        failure = "Could not complete model availability checks"
        process.exitCode = await probeModels(config, entries, probeOptions)
        return
      }

      const listed = listedModels(config, catalog)
      const result: ModelSearch = search === "" ? { found: true, models: listed } : searchModels(listed, search)
      const lines = [listingHeading(search, result), ...renderModelRows(result.models)]

      if (result.models.length > 0) {
        lines.push(
          "Inference, tool, and effort compatibility are not verified by this listing.",
          `Test one with copilot-relay models --deep --model ${result.chosen?.id ?? "<id>"}; it consumes Copilot usage.`,
        )
      }

      lines.push("", ...renderConfigGuide(paths.configPath, configuredModels(appConfig, config, catalog), result.chosen))
      // Each printed line is normalized and scrubbed again, as a backstop for any string that
      // skipped printable.
      console.log(lines.map((line) => scrubLogSecrets(scrubSensitiveUrls(terminalText(line)))).join("\n"))

      if (!result.found) {
        process.exitCode = 1
      }
    } catch (error) {
      let detail = "Check configuration, authentication, and upstream connectivity."
      if (error instanceof ModelsUsageError) {
        detail = error.message
      } else if (error instanceof HTTPError) {
        // The client wraps local aborts in synthetic HTTP responses that carry a
        // detail: 504 for a timeout, otherwise a cancellation.
        if (error.detail !== undefined) {
          detail = error.response.status === 504 ? "request timed out" : "request cancelled"
        } else {
          detail = `HTTP ${error.response.status}`
        }

        // An unread body can hold its connection open; release it before exiting.
        await error.response.body?.cancel().catch(() => {})
      }

      log.error(`${failure}: ${detail}`)
      process.exitCode = 1
    } finally {
      await flushLogs()
    }
  },
})
