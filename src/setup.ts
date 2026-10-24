// `copilot-relay setup`: points Claude Code CLI, the Claude Code desktop app, Codex CLI and the
// Codex app at this relay, on macOS, Linux and Windows.
import { defineCommand } from "citty"

import { loadCopilotModelCatalog, type CopilotModelCatalog } from "~/copilot/models"
import { getRelayBaseUrl } from "~/lib/address"
import { readAppConfig } from "~/lib/app-config"
import { setupProxyAuth } from "~/lib/auth"
import { isSetupTarget, runSetup, setupTargets, type SetupTarget } from "~/lib/client-setup"
import { readProxyConfig } from "~/lib/config"
import { flushLogs, registerLogSecret, scrubLogSecrets, setLogLevel, withoutConsoleLogging } from "~/lib/log"
import { registerSensitiveOrigin } from "~/lib/redact"
import { terminalText } from "~/lib/terminal"
import { configureUpstreamDispatcher } from "~/lib/upstream-dispatcher"

const printable = (text: string): string => scrubLogSecrets(terminalText(text))

/** The targets named on the command line, or every target when none is named. */
export const parseSetupTargets = (names: Array<string>): Array<SetupTarget> => {
  if (names.length === 0) {
    return [...setupTargets]
  }

  const unknown = names.filter((name) => !isSetupTarget(name))
  if (unknown.length > 0) {
    throw new Error(`Unknown target ${unknown.join(", ")}; use ${setupTargets.join(", ")}.`)
  }

  return names as Array<SetupTarget>
}

export const setup = defineCommand({
  meta: {
    name: "setup",
    description: "Point Claude Code CLI, the Claude Code app, Codex CLI and the Codex app at this relay.",
  },
  args: {
    targets: {
      type: "positional",
      required: false,
      description: `Clients to set up: ${setupTargets.join(", ")}. Default: all.`,
    },
    force: {
      type: "boolean",
      description: "Also set up a client that has not run on this machine yet.",
    },
  },
  async run({ args }) {
    let targets: Array<SetupTarget>
    try {
      targets = parseSetupTargets(args._.map(String))
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
      return
    }

    const appConfig = await readAppConfig()
    setLogLevel(appConfig.logLevel)
    registerSensitiveOrigin(appConfig.copilotBaseUrl)
    registerLogSecret(appConfig.apiKey)
    configureUpstreamDispatcher(appConfig.upstreamProxy)
    const config = readProxyConfig(appConfig)

    // Model names, context sizes and reasoning levels come from Copilot's catalog. Without it, setup
    // still writes every client, with the model IDs alone.
    let catalog: CopilotModelCatalog | undefined
    try {
      catalog = await withoutConsoleLogging(async () => {
        await setupProxyAuth(config)
        return await loadCopilotModelCatalog(config)
      })
    } catch {
      console.error("Could not read Copilot's model catalog; writing model IDs without names or context sizes.")
    }

    const outcomes = await runSetup(targets, {
      appConfig,
      baseUrl: getRelayBaseUrl(appConfig.host, appConfig.port),
      catalog,
      force: Boolean(args.force),
    })

    for (const outcome of outcomes) {
      const where = outcome.path ? ` (${outcome.path})` : ""
      console.log(printable(`${outcome.target}: ${outcome.status}${where}`))
    }

    if (outcomes.some((outcome) => outcome.target === "claude-code-app" && outcome.status === "updated")) {
      console.log("Quit and reopen the Claude app; it reads this setup at launch and may rewrite it while running.")
    }

    if (outcomes.some((outcome) => outcome.target.startsWith("codex") && outcome.status === "updated")) {
      console.log("Restart Codex and the Codex app to load the new config.")
    }

    if (outcomes.some((outcome) => outcome.status.startsWith("failed"))) {
      process.exitCode = 2
    }

    await flushLogs()
  },
})
