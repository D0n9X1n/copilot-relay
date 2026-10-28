// Claude Code desktop app setup: point the app's third-party (gateway) mode at this relay, so it
// opens without a claude.ai sign-in and lists the same models as Claude Code CLI.
//
// The app keeps third-party configuration in its "-3p" data directory: configLibrary/_meta.json
// names the applied configuration, configLibrary/<id>.json holds its keys (the keys documented for
// Claude Desktop on 3P, such as inferenceProvider), and claude_desktop_config.json records
// deploymentMode "3p", which opens the app in that mode instead of the sign-in chooser.
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { readFileSnapshot, writeFileSnapshot, type FileSnapshot } from "~/lib/atomic-file"
import type { CopilotModel } from "~/copilot/models"

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const configIdPattern = /^[a-f0-9-]{36}$/

export interface ClaudeAppPlatform {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  home: string
}

const currentPlatform = (): ClaudeAppPlatform => ({ platform: process.platform, env: process.env, home: os.homedir() })

/**
 * The app's third-party data directory: Electron's userData for "Claude" with "-3p" appended, or
 * %LOCALAPPDATA%\Claude-3p on Windows.
 */
export const claudeAppDataDir = ({ platform, env, home }: ClaudeAppPlatform = currentPlatform()): string => {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local")
    return path.win32.join(localAppData, "Claude-3p")
  }

  if (platform === "darwin") {
    return path.posix.join(home, "Library", "Application Support", "Claude-3p")
  }

  const configHome = env.XDG_CONFIG_HOME || path.posix.join(home, ".config")
  return path.posix.join(configHome, "Claude-3p")
}

// The app's standard data directory, next to the third-party one; it exists once the app has run.
const standardDataDir = (dataDir: string): string => dataDir.replace(/-3p$/, "")

export interface ClaudeAppModel {
  id: string
  capabilities?: CopilotModel
  // The Claude tier this model stands in for, so the app's bare aliases resolve to it.
  tier: "opus" | "sonnet" | "haiku"
}

// For a gateway, the app keeps an inferenceModels entry only when its name looks like an Anthropic
// model: it must name claude, a Claude family or anthropic, and must not contain a marker of another
// vendor. These are the markers the app checks.
const otherVendorMarker = /ark-code|astron|command-r|deepseek|doubao|gemini|gemma|glm|gpt|grok|hermes|hy3|kimi|lfm|\bling\b|llama|longcat|mimo|minimax|mistral|mixtral|moonshot|nemotron|openai|phi-|qianfan|qwen|tc-code|\bunic\b|yi-|stepfun|step-3|seed-|bytedance|hunyuan|granite|amazon\.nova|nova-|devstral|ministral|ernie|codex|arcee|trinity|abab|phi\d|\bk2\.|\bm2\.|jamba|arctic|solar|mercury|zamba|kat-coder|\bds-|dpsk/

const looksAnthropic = (id: string): boolean => {
  const lower = id.toLowerCase()
  return !otherVendorMarker.test(lower) && ["claude", "anthropic", "opus", "sonnet", "haiku", "fable", "mythos"].some((word) => lower.includes(word))
}

// The relay sends a name with "opus" to opusModel and any other to gptModel (routeModelId).
const routesToTier = (name: string, tier: ClaudeAppModel["tier"]): boolean =>
  name.toLowerCase().includes("opus") === (tier === "opus")

/**
 * The name the app sends for a model: its own ID when the app accepts it and the relay routes that
 * ID to the model's own slot, otherwise a Claude-style route for its tier, such as
 * claude-sonnet-relay. Each tier therefore has its own name. The relay sends every model name without "opus"
 * to gptModel and every one with it to opusModel, so the route reaches the same upstream model. The
 * route names no real Claude model, so the app and its Claude Code take none of that model's
 * built-in context window or tuning; supports1m and prefer1m on the entry say what the window is.
 */
export const appModelName = (model: Pick<ClaudeAppModel, "id" | "tier">): string =>
  looksAnthropic(model.id) && routesToTier(model.id, model.tier) ? model.id : `claude-${model.tier}-relay`

// An entry of the app's inferenceModels list for one Copilot model.
export const inferenceModel = (model: ClaudeAppModel): JsonRecord => {
  const promptTokens = model.capabilities?.limits?.max_prompt_tokens ?? 0
  const name = appModelName(model)
  // A route name says nothing about the model behind it, so the label names that model.
  const label = model.capabilities?.name?.trim() || (name === model.id ? undefined : model.id)
  return {
    name,
    ...(label ? { labelOverride: label } : {}),
    // supports1m alone offers a standard-window option beside the 1M one; prefer1m shows only the 1M one.
    ...(promptTokens >= 1_000_000 ? { supports1m: true, prefer1m: true } : {}),
    anthropicFamilyTier: model.tier,
  }
}

export interface ClaudeAppSetupInput {
  // The relay's inbound apiKey. The app requires a key in static mode; without one the relay
  // accepts any value.
  apiKey?: string
  // The relay's base URL without /v1.
  baseUrl: string
  // In order; the first is the app's default model.
  models: Array<ClaudeAppModel>
  dataDir?: string
  // Write even when the app has never run here.
  force?: boolean
}

export interface ClaudeAppSetupResult {
  dataDir: string
  // The app has never run for this user, so nothing was written.
  skipped: boolean
  changed: boolean
}

const readJson = (snapshot: FileSnapshot): JsonRecord => {
  if (snapshot.raw === null) {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(snapshot.raw)
  } catch {
    throw new Error(`${snapshot.requestedPath} is not valid JSON; fix or remove it, then run setup again.`)
  }

  if (!isRecord(parsed)) {
    throw new Error(`${snapshot.requestedPath} is not a JSON object; fix or remove it, then run setup again.`)
  }

  return parsed
}

// A file holding the key is published again when other local users can read it, even when its
// content is current. Windows has no POSIX mode bits.
const writeJson = async (snapshot: FileSnapshot, value: JsonRecord, ownerOnly: boolean): Promise<boolean> => {
  const content = `${JSON.stringify(value, null, 2)}\n`
  const exposed = ownerOnly && process.platform !== "win32" && snapshot.raw !== null && (snapshot.mode & 0o077) !== 0
  if (snapshot.raw === content && !exposed) {
    return false
  }

  await writeFileSnapshot(snapshot, content, { ownerOnly })
  return true
}

// The applied configuration's id, adding one to the library when none is applied.
const appliedConfigId = (meta: JsonRecord): { id: string; meta: JsonRecord } => {
  const entries = Array.isArray(meta.entries) ? meta.entries.filter(isRecord) : []
  const applied = meta.appliedId
  if (typeof applied === "string" && configIdPattern.test(applied) && entries.some((entry) => entry.id === applied)) {
    return { id: applied, meta }
  }

  const id = randomUUID()
  return { id, meta: { ...meta, appliedId: id, entries: [...entries, { id, name: "copilot-relay" }] } }
}

/**
 * Points the Claude Code desktop app at the relay. Updates only the keys it manages in the applied
 * configuration and keeps every other setting. Skips a machine where the app has never run unless
 * forced. The app rewrites these files while it runs, so quit it before setup and reopen it after.
 */
export const applyClaudeAppSetup = async (input: ClaudeAppSetupInput): Promise<ClaudeAppSetupResult> => {
  const dataDir = input.dataDir ?? claudeAppDataDir()
  const installed = await Promise.all([dataDir, standardDataDir(dataDir)].map(async (dir) =>
    (await fs.stat(dir).catch(() => undefined))?.isDirectory() === true))
  if (!input.force && !installed.some(Boolean)) {
    return { dataDir, skipped: true, changed: false }
  }

  const libraryDir = path.join(dataDir, "configLibrary")
  await fs.mkdir(libraryDir, { recursive: true, mode: 0o700 })

  const metaSnapshot = await readFileSnapshot(path.join(libraryDir, "_meta.json"))
  const { id, meta } = appliedConfigId(readJson(metaSnapshot))

  const entrySnapshot = await readFileSnapshot(path.join(libraryDir, `${id}.json`))
  const current = readJson(entrySnapshot)
  const existingKey = typeof current.inferenceGatewayApiKey === "string" && current.inferenceGatewayApiKey ? current.inferenceGatewayApiKey : undefined
  const entry: JsonRecord = {
    ...current,
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: input.baseUrl,
    inferenceGatewayApiKey: input.apiKey || existingKey || "copilot-relay",
    inferenceCredentialKind: "static",
    inferenceModels: input.models.map(inferenceModel),
    // The list names every model by its full ID, so the app needs no discovery. With it on, the app
    // also asks the relay's /v1/models and flags a route name, such as claude-sonnet-relay, that the
    // relay does not list.
    modelDiscoveryEnabled: false,
  }

  const desktopSnapshot = await readFileSnapshot(path.join(dataDir, "claude_desktop_config.json"))
  const desktop = { ...readJson(desktopSnapshot), deploymentMode: "3p" }

  // The entry first: _meta.json names it, and the app must never find a name without its file.
  const entryChanged = await writeJson(entrySnapshot, entry, true)
  const metaChanged = await writeJson(metaSnapshot, meta, true)
  const desktopChanged = await writeJson(desktopSnapshot, desktop, true)
  return { dataDir, skipped: false, changed: entryChanged || metaChanged || desktopChanged }
}
