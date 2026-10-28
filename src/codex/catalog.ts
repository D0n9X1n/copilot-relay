// The model catalog Codex gets from copilot-relay: exactly gptModel and opusModel, so the Codex CLI
// and app list the same two models Claude Code does. Codex reads it from model_catalog_json as its
// whole model list.
import fs from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { CopilotModel } from "~/copilot/models"

type JsonRecord = Record<string, unknown>

export interface CatalogModel {
  id: string
  capabilities?: CopilotModel
}

// Codex's reasoning levels, lowest first, with the descriptions its picker shows.
const effortDescriptions: Record<string, string> = {
  none: "No extra reasoning",
  minimal: "Minimal reasoning",
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
}

// The window Codex works in, and compacts at 90% of: the most input Copilot accepts that still leaves
// room for a full reply, or the whole input limit when a full reply may fill the total window. Codex
// takes a window of 0 as already full. max_context_window, Copilot's input limit, only bounds a
// model_context_window override in config.toml.
const contextWindows = (model: CatalogModel): JsonRecord => {
  const limits = model.capabilities?.limits
  if (limits === undefined) {
    return {}
  }

  const roomBesideReply = limits.max_context_window_tokens - limits.max_output_tokens
  return {
    context_window: roomBesideReply > 0 ? Math.min(limits.max_prompt_tokens, roomBesideReply) : limits.max_prompt_tokens,
    max_context_window: limits.max_prompt_tokens,
  }
}

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Both src/ and a packaged dist/ find the package-level vendor/ directory this way.
const readVendorFile = async (name: string): Promise<string> => {
  let currentDir = dirname(fileURLToPath(import.meta.url))
  while (true) {
    try {
      return await fs.readFile(resolve(currentDir, "vendor", "codex", name), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }

      const parentDir = dirname(currentDir)
      if (parentDir === currentDir) {
        throw new Error(`vendor/codex/${name} is missing from the package.`)
      }

      currentDir = parentDir
    }
  }
}

export interface CodexVendorFiles {
  // Codex's bundled model entries, by slug.
  bundled: Map<string, JsonRecord>
  // The instructions Codex uses for a model it does not know.
  prompt: string
}

export const readCodexVendorFiles = async (): Promise<CodexVendorFiles> => {
  const models: unknown = JSON.parse(await readVendorFile("models.json"))
  const entries = isRecord(models) && Array.isArray(models.models) ? models.models : []
  const bundled = new Map<string, JsonRecord>()
  for (const entry of entries) {
    if (isRecord(entry) && typeof entry.slug === "string") {
      bundled.set(entry.slug, entry)
    }
  }

  return { bundled, prompt: await readVendorFile("prompt.md") }
}

const displayName = (model: CatalogModel): string =>
  model.capabilities?.name || model.id

/**
 * A catalog entry for a model Codex does not ship.
 *
 * It enables Codex's freeform apply_patch tool and its shell tool, lists the reasoning levels Copilot
 * advertises, and uses the instructions Codex gives any model it does not know.
 */
const generatedEntry = (model: CatalogModel, priority: number, prompt: string): JsonRecord => {
  const levels = (model.capabilities?.reasoningEfforts ?? [])
    .filter((effort) => Object.hasOwn(effortDescriptions, effort))
    .map((effort) => ({ effort, description: effortDescriptions[effort] }))
  const defaultLevel = levels.find((level) => level.effort === "medium") ?? levels[0]

  return {
    slug: model.id,
    display_name: displayName(model),
    description: `${displayName(model)} through copilot-relay`,
    ...(defaultLevel && { default_reasoning_level: defaultLevel.effort }),
    supported_reasoning_levels: levels,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    support_verbosity: false,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    experimental_supported_tools: [],
    apply_patch_tool_type: "freeform",
    supports_parallel_tool_calls: true,
    input_modalities: ["text", "image"],
    ...contextWindows(model),
    model_messages: { instructions_template: prompt },
  }
}

/**
 * The catalog for these models, in order: the first is Codex's default.
 *
 * A model Codex ships keeps Codex's own entry, so its tuned instructions and settings are unchanged;
 * only its position, visibility and context window change, the window to the one Copilot allows. Any
 * other model, such as a Claude model, gets a generated entry.
 */
export const buildCodexCatalog = (models: Array<CatalogModel>, vendor: CodexVendorFiles): JsonRecord => {
  const seen = new Set<string>()
  const entries: Array<JsonRecord> = []
  for (const model of models) {
    if (seen.has(model.id)) {
      continue
    }

    seen.add(model.id)
    const priority = entries.length + 1
    const bundled = vendor.bundled.get(model.id)
    entries.push(bundled ? { ...bundled, visibility: "list", priority, ...contextWindows(model) } : generatedEntry(model, priority, vendor.prompt))
  }

  return { models: entries }
}
