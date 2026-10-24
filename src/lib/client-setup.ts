// Points each client at the relay: Claude Code CLI, the Claude Code desktop app, and Codex (CLI and
// app share one config). Used by `copilot-relay setup` for any of them, and by `start` for the ones
// its claudeSetup and codexSetup keys turn on.
import { applyCodexSetup } from "~/codex/setup"
import type { CopilotModelCatalog } from "~/copilot/models"
import type { AppConfig } from "~/lib/app-config"
import { applyClaudeAppSetup } from "~/lib/claude-app"
import { applyClaudeConfig } from "~/lib/claude-settings"
import { getClaudeConfigPath, getCodexHome } from "~/lib/defaults"
import { paths } from "~/lib/paths"

export const setupTargets = ["claude-code-cli", "claude-code-app", "codex-cli", "codex-app"] as const
export type SetupTarget = (typeof setupTargets)[number]

export const isSetupTarget = (value: string): value is SetupTarget =>
  (setupTargets as ReadonlyArray<string>).includes(value)

export interface SetupOutcome {
  target: string
  path: string
  // "updated", "already up to date", or "skipped: <reason>".
  status: string
}

interface SetupContext {
  appConfig: AppConfig
  baseUrl: string
  catalog: CopilotModelCatalog | undefined
  // Set up even a client that has never run here.
  force: boolean
}

const capabilities = (context: SetupContext, id: string) => context.catalog?.models.get(id)

export const setupClaudeCodeCli = async (context: SetupContext): Promise<SetupOutcome> => {
  const { appConfig } = context
  const gptLimits = capabilities(context, appConfig.gptModel)?.limits
  const opusLimits = capabilities(context, appConfig.opusModel)?.limits
  const result = await applyClaudeConfig({
    apiKey: appConfig.apiKey,
    baseUrl: context.baseUrl,
    configPath: getClaudeConfigPath(),
    gptModel: appConfig.gptModel,
    gptLimits,
    maxOutputTokens: gptLimits && opusLimits ?
        Math.max(gptLimits.max_output_tokens, opusLimits.max_output_tokens)
      : undefined,
  })

  return { target: "claude-code-cli", path: result.configPath, status: result.changed ? "updated" : "already up to date" }
}

// Codex CLI and the Codex app read the same $CODEX_HOME/config.toml.
export const setupCodex = async (context: SetupContext, target: string): Promise<SetupOutcome> => {
  const { appConfig } = context
  const result = await applyCodexSetup({
    apiKey: appConfig.apiKey,
    baseUrl: context.baseUrl,
    catalogPath: paths.codexCatalogPath,
    codexHome: getCodexHome(),
    // The same two models Claude Code offers; gptModel first, as Codex's default.
    models: [appConfig.gptModel, appConfig.opusModel].map((id) => ({ id, capabilities: capabilities(context, id) })),
    force: context.force,
  })

  if (result.skipped) {
    return { target, path: result.configPath, status: "skipped: Codex has not run here" }
  }

  return { target, path: result.configPath, status: result.changed ? "updated" : "already up to date" }
}

// The app lists opusModel first, its default as in Claude Code CLI, then gptModel for the sonnet and
// haiku aliases, as the CLI maps them.
export const setupClaudeCodeApp = async (context: SetupContext): Promise<SetupOutcome> => {
  const { appConfig } = context
  const result = await applyClaudeAppSetup({
    apiKey: appConfig.apiKey,
    baseUrl: context.baseUrl,
    models: [
      { id: appConfig.opusModel, capabilities: capabilities(context, appConfig.opusModel), tier: "opus" },
      { id: appConfig.gptModel, capabilities: capabilities(context, appConfig.gptModel), tier: "sonnet" },
    ],
    force: context.force,
  })

  if (result.skipped) {
    return { target: "claude-code-app", path: result.dataDir, status: "skipped: the app has not run here" }
  }

  return { target: "claude-code-app", path: result.dataDir, status: result.changed ? "updated" : "already up to date" }
}

/** Sets up each target once, in the order given; codex-cli and codex-app write one shared file. */
export const runSetup = async (targets: Array<SetupTarget>, context: SetupContext): Promise<Array<SetupOutcome>> => {
  const outcomes: Array<SetupOutcome> = []
  let codex: SetupOutcome | undefined
  for (const target of new Set(targets)) {
    try {
      if (target === "claude-code-cli") {
        outcomes.push(await setupClaudeCodeCli(context))
      } else if (target === "claude-code-app") {
        outcomes.push(await setupClaudeCodeApp(context))
      } else if (codex === undefined) {
        codex = await setupCodex(context, target)
        outcomes.push(codex)
      } else {
        outcomes.push({ ...codex, target, status: "shares the Codex config above" })
      }
    } catch (error) {
      outcomes.push({ target, path: "", status: `failed: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  return outcomes
}
