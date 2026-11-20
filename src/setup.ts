// `copilot-relay setup`: points Claude Code CLI, the Claude Code desktop app, Codex CLI and the
// Codex app at this relay, on macOS, Linux and Windows.
import { defineCommand } from "citty"

import { loadCopilotModelCatalog, type CopilotModelCatalog } from "~/copilot/models"
import { getRelayBaseUrl } from "~/lib/address"
import { readAppConfig } from "~/lib/app-config"
import { setupProxyAuth } from "~/lib/auth"
import { isSetupTarget, runSetup, setupTargets, type SetupOutcome, type SetupTarget } from "~/lib/client-setup"
import { readProxyConfig } from "~/lib/config"
import { flushLogs, registerLogSecret, scrubLogSecrets, setLogLevel, withoutConsoleLogging } from "~/lib/log"
import { homeRelative } from "~/lib/paths"
import { registerSensitiveOrigin } from "~/lib/redact"
import { colorEnabled, columnWidths, displayWidth, heading, mark, renderTable, terminalText, unicodeEnabled } from "~/lib/terminal"
import type { MarkState, TableColumn, TerminalTone } from "~/lib/terminal"
import { configureUpstreamDispatcher } from "~/lib/upstream-dispatcher"

const printable = (text: string): string => scrubLogSecrets(terminalText(text))

interface SetupRow {
  client: string
  state: MarkState
  result: string
  detail: string
}

// An outcome's status is "updated", "already up to date", "skipped: <reason>", "failed: <reason>"
// or a note such as "shares the Codex config above". The table keeps the verdict short and moves the
// reason, or else the file written, to DETAIL.
const setupRow = (outcome: SetupOutcome): SetupRow => {
  const where = homeRelative(outcome.path)
  const [verdict, ...reason] = outcome.status.split(": ")
  const because = reason.join(": ")
  if (verdict === "failed") {
    return { client: outcome.target, state: "fail", result: "failed", detail: because || where }
  }

  if (verdict === "skipped") {
    return { client: outcome.target, state: "off", result: "skipped", detail: because || where }
  }

  if (outcome.status === "updated") {
    return { client: outcome.target, state: "ok", result: "updated", detail: where }
  }

  if (outcome.status === "already up to date") {
    return { client: outcome.target, state: "ok", result: "up to date", detail: where }
  }

  return { client: outcome.target, state: "ok", result: "up to date", detail: outcome.status }
}

const resultTones: Record<MarkState, TerminalTone> = { ok: "good", fail: "bad", warn: "warning", off: "muted" }

// A table line's budget: a two-space indent and a two-space gutter between columns.
const lineWidth = 80
const indent = 2
const gutter = 2

/** The outcome of each client as a heading and a table. Kept free of IO, so it is tested directly. */
export const renderSetupOutcomes = (
  outcomes: Array<SetupOutcome>,
  baseUrl: string,
  color = false,
  unicode = unicodeEnabled(),
): Array<string> => {
  const rows = outcomes.map(setupRow)
  const leading: Array<TableColumn<SetupRow>> = [
    { header: "CLIENT", align: "left", cell: (row) => row.client },
    { header: "RESULT", align: "left", cell: (row) => `${mark(row.state, unicode)} ${row.result}`, tone: (row) => resultTones[row.state] },
  ]
  // DETAIL gets what CLIENT and RESULT leave on an 80-column line, past the indent and the gutters.
  const used = columnWidths(leading, rows).reduce((sum, width) => sum + width, 0)
  const detailWidth = Math.max(lineWidth - indent - gutter * leading.length - used, displayWidth("DETAIL"))

  return [
    heading("Client setup", baseUrl),
    "",
    ...renderTable([
      ...leading,
      { header: "DETAIL", align: "left", cell: (row) => row.detail, maxWidth: detailWidth },
    ], rows, color),
  ]
}

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

    let appConfig: Awaited<ReturnType<typeof readAppConfig>>
    try {
      appConfig = await readAppConfig()
    } catch (error) {
      console.error(printable(error instanceof Error ? error.message : String(error)))
      process.exitCode = 1
      return
    }

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
        // Logging is off here, which would hide the sign-in prompt, so the code is printed directly.
        await setupProxyAuth(config, {
          onDeviceCode: (url, code) => console.error(`Sign in: open ${terminalText(url)} and enter ${terminalText(code)}.`),
        })
        return await loadCopilotModelCatalog(config)
      })
    } catch {
      console.error("Could not read Copilot's model catalog; writing model IDs without names or context sizes.")
    }

    const baseUrl = getRelayBaseUrl(appConfig.host, appConfig.port)
    const outcomes = await runSetup(targets, {
      appConfig,
      baseUrl,
      catalog,
      force: Boolean(args.force),
    })

    // Every cell is made printable and scrubbed by the table before it is cut.
    console.log(renderSetupOutcomes(outcomes, printable(baseUrl), colorEnabled()).join("\n"))
    console.log("")

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
