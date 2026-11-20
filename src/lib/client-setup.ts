// Points each client at the relay: Claude Code CLI, the Claude Code desktop app, and Codex (CLI and
// app share one config). Used by `copilot-relay setup` for any of them, and by `start` for the ones
// its claudeSetup and codexSetup keys turn on.
import fs from "node:fs/promises"
import path from "node:path"

import type { CatalogModel } from "~/codex/catalog"
import { applyCodexSetup } from "~/codex/setup"
import type { CopilotModelCatalog } from "~/copilot/models"
import type { AppConfig } from "~/lib/app-config"
import { applyClaudeAppSetup } from "~/lib/claude-app"
import { applyClaudeConfig } from "~/lib/claude-settings"
import { getClaudeConfigPath, getCodexHome } from "~/lib/defaults"
import { log } from "~/lib/log"
import { parseModelSelection, resolveExposedModels } from "~/lib/models"
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
  const configPath = getClaudeConfigPath()
  const configDir = await fs.stat(path.dirname(configPath)).catch(() => undefined)
  if (!context.force && !configDir?.isDirectory()) {
    return { target: "claude-code-cli", path: configPath, status: "skipped: Claude Code has not run here" }
  }

  const gptLimits = capabilities(context, appConfig.gptModel)?.limits
  const opusLimits = capabilities(context, appConfig.opusModel)?.limits
  const result = await applyClaudeConfig({
    apiKey: appConfig.apiKey,
    baseUrl: context.baseUrl,
    configPath,
    gptModel: appConfig.gptModel,
    gptLimits,
    contextWindowOf: (model) => capabilities(context, model)?.limits?.max_context_window_tokens,
    maxOutputTokens: gptLimits && opusLimits ?
        Math.max(gptLimits.max_output_tokens, opusLimits.max_output_tokens)
      : undefined,
  })

  if (result.skippedReason) {
    return { target: "claude-code-cli", path: result.configPath, status: `failed: left unchanged because ${result.skippedReason}` }
  }

  return { target: "claude-code-cli", path: result.configPath, status: result.changed ? "updated" : "already up to date" }
}

/** Codex's models: the exposed upstream IDs without [1m], gptModel first as Codex's default. */
export const codexModels = (appConfig: AppConfig, catalog: CopilotModelCatalog | undefined): Array<CatalogModel> =>
  resolveExposedModels(
    { gptModel: appConfig.gptModel, opusModel: appConfig.opusModel, models: parseModelSelection(appConfig.models) },
    catalog?.models,
  ).map((id) => ({ id, capabilities: catalog?.models.get(id) }))

// Codex CLI and the Codex app read the same $CODEX_HOME/config.toml.
export const setupCodex = async (context: SetupContext, target: string): Promise<SetupOutcome> => {
  const { appConfig } = context
  const result = await applyCodexSetup({
    apiKey: appConfig.apiKey,
    baseUrl: context.baseUrl,
    catalogPath: paths.codexCatalogPath,
    codexHome: getCodexHome(),
    models: codexModels(appConfig, context.catalog),
    force: context.force,
  })

  if (result.skipped) {
    return { target, path: result.configPath, status: "skipped: Codex has not run here" }
  }

  return { target, path: result.configPath, status: result.changed ? "updated" : "already up to date" }
}

/**
 * `start`'s Codex setup when codexSetup is on: the same setup as `copilot-relay setup`, never forced,
 * so a machine where Codex has not run is skipped. A failure is logged rather than stopping the relay.
 */
export const startupCodexSetup = async (
  appConfig: AppConfig,
  catalog: CopilotModelCatalog | undefined,
  baseUrl: string,
): Promise<void> => {
  const codexHome = getCodexHome()
  try {
    const outcome = await setupCodex({ appConfig, baseUrl, catalog, force: false }, "codex")
    if (outcome.status.startsWith("skipped")) {
      log.info(`codex setup skipped: ${codexHome} does not exist`)
    } else if (outcome.status === "updated") {
      log.info(`codex settings updated: ${outcome.path}`)
    } else {
      log.info(`codex settings already up to date: ${outcome.path}`)
    }
  } catch (error) {
    log.error(`Could not update codex settings (${codexHome}):`, error)
  }
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
