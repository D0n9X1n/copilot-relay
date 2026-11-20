import { defineCommand } from "citty"

import { selectCopilotEndpoint } from "~/copilot/endpoint"
import { loadStandaloneModelCatalog, type CopilotModelCatalog } from "~/copilot/models"
import { readAppConfig, type AppConfig } from "~/lib/app-config"
import { setupProxyAuth, signInLines } from "~/lib/auth"
import { readProxyConfig, type ProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { consola } from "consola"

import { flushLogs, log, registerLogSecret, scrubLogSecrets, setLogLevel, withoutConsoleLogging } from "~/lib/log"
import { boldText, colorDepth, colorText, heading, printableCell, terminalText, withoutHiddenCharacters } from "~/lib/terminal"
import { probeModels } from "~/lib/model-probe"
import { probeReason } from "~/lib/model-probe-output"
import {
  normalizeModelSearch,
  renderConfigGuide,
  renderModelRows,
  searchModels,
  type ConfiguredModel,
  type ListedModel,
  type ModelKey,
  type ModelSearch,
} from "~/lib/model-listing"
import { isReasoningEffort, normalizeCopilotModelId } from "~/lib/models"
import { homeRelative, paths } from "~/lib/paths"
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

// Catalog names are untrusted: control characters, secrets and sensitive URLs are removed. The name
// is kept whole, so a search sees every redaction marker intact; the table leaves NAME out rather
// than cut it.
const displayName = (name: string | undefined): string | undefined => {
  const text = printableCell(name ?? "").trim()

  return text === "" ? undefined : text
}

// Every advertised ID, with the reason request admission would refuse it as gptModel or opusModel.
// The config key whose value names this ID, matched the way routing matches a slot: by its
// canonical spelling, ignoring case and [1m].
const slotFor = (id: string, appConfig: AppConfig): ModelKey | undefined =>
  (["opusModel", "gptModel"] as const).find((key) => normalizeCopilotModelId(appConfig[key]).toLowerCase() === id.toLowerCase())

const listedModels = (config: ProxyConfig, catalog: CopilotModelCatalog, appConfig: AppConfig): ListedModel[] =>
  [...catalog.models.keys()].sort().map((id) => {
    const selection = selectCopilotEndpoint(config, id)
    const model = catalog.models.get(id)
    const name = displayName(model?.name)
    const slot = slotFor(id, appConfig)

    return {
      // The table scrubs the ID it prints in the same way, so a search never sees a hidden URL tail.
      id: printableCell(id),
      ...(name !== undefined && { name }),
      ...(!selection.endpoint && { unusable: probeReason(selection.reason) }),
      chat: selection.endpoint !== undefined || selection.reason !== "unsupported-model-type",
      ...(model?.limits?.max_context_window_tokens !== undefined && {
        contextWindow: model.limits.max_context_window_tokens,
      }),
      ...(model?.price !== undefined && { price: { input: model.price.input, output: model.price.output } }),
      ...(model?.multiplier !== undefined && { multiplier: model.multiplier }),
      ...(slot !== undefined && { slot }),
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

const listingHeading = (search: string, result: ModelSearch, total: number, all: boolean, color: boolean): string => {
  if (search === "") {
    if (total === 0) {
      return "No models advertised by upstream."
    }

    return all
      ? heading("Copilot models", String(total), color)
      : heading("Copilot chat models", `${result.models.length} of ${total}`, color)
  }

  const label = printable(search)

  if (result.found) {
    return `${boldText("Upstream models matching", color)} "${label}" (${result.models.length}):`
  }

  if (result.models.length === 0) {
    // The hint takes its own line, so a long search term cannot push it past 80 columns.
    return `No upstream model matches "${label}".\nList them all with copilot-relay models --all.`
  }

  return `No upstream model matches "${label}". ${boldText("Closest IDs", color)} (${result.models.length}):`
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
    all: {
      type: "boolean",
      description: "List every advertised model, including those that are not chat models.",
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
          onDeviceCode: (url, code) => console.error(signInLines(url, code).join("\n")),
        } : undefined)

        failure = "Could not fetch upstream model catalog"
        // The catalog load owns one upstream deadline, disposed before any --deep probe starts.
        const catalog = await loadStandaloneModelCatalog(config)
        return { appConfig, config, catalog }
      }

      // Token-cache notices are diagnostics: they go to stderr, so stdout holds only the answer.
      const stdout = consola.options.stdout
      consola.options.stdout = process.stderr
      const { appConfig, config, catalog } = await (args.deep ? withoutConsoleLogging(prepare) : prepare())
        .finally(() => {
          consola.options.stdout = stdout
        })

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

      const listed = listedModels(config, catalog, appConfig)
      // The plain listing shows chat models; --all and a search show every match.
      const shown = search === "" && !args.all ? listed.filter((model) => model.chat !== false) : listed
      const result: ModelSearch = search === "" ? { found: true, models: shown } : searchModels(listed, search)
      // The depth picks the price ramp's colors; any depth above 0 also turns on bold and tones.
      const depth = colorDepth()
      const color = depth !== 0
      const lines = [listingHeading(search, result, listed.length, Boolean(args.all), color)]

      if (result.models.length > 0) {
        lines.push("", ...renderModelRows(result.models, depth), "")
      }

      // The notes under the table are muted, so the eye stays on the table above them.
      const hidden = listed.length - shown.length
      if (search === "" && hidden > 0) {
        lines.push(colorText(hidden === 1
          ? "1 model that is not a chat model is hidden: copilot-relay models --all"
          : `${hidden} models that are not chat models are hidden: copilot-relay models --all`, "muted", color), "")
      }

      if (result.models.length > 0) {
        lines.push(
          ...[
            "Inference, tool, and effort compatibility are not verified by this listing.",
            `Test one with copilot-relay models --deep --model ${result.chosen?.id ?? "<id>"}`,
            "(a real request, so it consumes Copilot usage).",
          ].map((note) => colorText(note, "muted", color)),
        )
      }

      lines.push("", ...renderConfigGuide(homeRelative(paths.configPath), configuredModels(appConfig, config, catalog), result.chosen).map(printableCell))
      // Table cells were made printable and scrubbed by the table before any cut, and every other
      // line holding user, catalog or config text was built from printable strings. Each line is
      // scrubbed once more as a backstop; hidden characters are removed but the table's color stays.
      console.log(lines.map((line) => scrubLogSecrets(scrubSensitiveUrls(withoutHiddenCharacters(line)))).join("\n"))

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
