// Runtime YAML config loader/writer with hot-reload support for ~/.copilot-relay/config.yaml.
import fs from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  defaultReasoningEffort,
  isReasoningEffort,
  type ReasoningEffort,
} from "~/lib/models"
import { paths } from "~/lib/paths"

export const logLevels = ["error", "info", "debug"] as const
export type LogLevelName = (typeof logLevels)[number]
export interface AppConfig {
  claudeSetup: boolean
  copilotBaseUrl: string
  gptModel: string
  host: string
  logLevel: LogLevelName
  logRetentionDays: number
  opusModel: string
  port: number
  thinkEffort: ReasoningEffort
  upstreamTimeoutSeconds: number
  webSearchBackend?: string
}

const defaultConfig: AppConfig = {
  claudeSetup: true,
  copilotBaseUrl: "https://api.githubcopilot.com",
  gptModel: "gpt-5.6-sol",
  host: "127.0.0.1",
  logLevel: "info",
  logRetentionDays: 3,
  opusModel: "claude-opus-4.8",
  port: 4142,
  thinkEffort: defaultReasoningEffort,
  upstreamTimeoutSeconds: 180,
  webSearchBackend: undefined,
}

export const isLogLevelName = (value: unknown): value is LogLevelName =>
  typeof value === "string"
  && logLevels.includes(value.toLowerCase() as LogLevelName)

export const normalizeLogLevel = (value: unknown): LogLevelName | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== "string") {
    throw new Error(
      `Invalid logLevel: expected one of ${logLevels.join(", ")}`,
    )
  }

  const normalized = value.toLowerCase()
  if (!isLogLevelName(normalized)) {
    throw new Error(
      `Invalid logLevel "${value}": expected one of ${logLevels.join(", ")}`,
    )
  }

  return normalized
}

const normalizeBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") {
    return value
  }
  if (typeof value !== "string") {
    return undefined
  }
  const normalized = value.toLowerCase()
  if (normalized === "true") return true
  if (normalized === "false") return false
  return undefined
}

const normalizePort = (value: unknown): number | undefined => {
  const port =
    typeof value === "number" ? value
    : typeof value === "string" ? Number.parseInt(value, 10)
    : Number.NaN
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined
}

const normalizePositiveInteger = (value: unknown): number | undefined => {
  const number =
    typeof value === "number" ? value
    : typeof value === "string" ? Number.parseInt(value, 10)
    : Number.NaN
  return Number.isInteger(number) && number > 0 ? number : undefined
}

const normalizeString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined

export const normalizeThinkEffort = (
  value: unknown,
): ReasoningEffort | undefined => {
  if (typeof value !== "string") {
    return undefined
  }
  const normalized = value.toLowerCase() === "minimal" ? "low" : value.toLowerCase()
  return isReasoningEffort(normalized) ? normalized : undefined
}

export const normalizeUpstreamTimeoutSeconds = (
  value: unknown,
): number | undefined => {
  if (value === undefined) {
    return undefined
  }

  const timeout = normalizePositiveInteger(value)
  if (timeout === undefined) {
    throw new Error("Invalid upstreamTimeoutSeconds: expected a positive integer")
  }

  return timeout
}

const readRawConfig = async (): Promise<Record<string, unknown>> => {
  try {
    const content = await fs.readFile(paths.configPath, "utf8")
    return parseConfigYaml(content)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      for (const legacyPath of paths.legacyConfigPaths) {
        try {
          const content = await fs.readFile(legacyPath, "utf8")
          return parseConfigYaml(content)
        } catch (legacyError) {
          if ((legacyError as NodeJS.ErrnoException).code !== "ENOENT") {
            throw legacyError
          }
        }
      }
      return readDefaultConfigTemplate()
    }
    throw error
  }
}

const readDefaultConfigTemplate = async (): Promise<Record<string, unknown>> => {
  let currentDir = dirname(fileURLToPath(import.meta.url))

  // Bundled code may run from src/ during development or from dist/ after
  // packaging, so walk upward until the package-level config template is found.
  while (true) {
    try {
      const content = await fs.readFile(
        resolve(currentDir, "config.default.yaml"),
        "utf8",
      )
      return parseConfigYaml(content)
    } catch {
      const parentDir = dirname(currentDir)
      if (parentDir === currentDir) {
        return {}
      }
      currentDir = parentDir
    }
  }
}

const unquoteYamlScalar = (value: string): string => {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const parseConfigYaml = (content: string): Record<string, unknown> => {
  const config: Record<string, unknown> = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) {
      continue
    }

    const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/)
    if (!match) {
      throw new Error(`Invalid config line in ${paths.configPath}: ${line}`)
    }

    const [, key, value] = match
    // The runtime config intentionally supports only a flat key/value YAML
    // subset. That keeps startup dependency-free and makes bad edits fail
    // predictably instead of being partially interpreted.
    switch (key) {
      case "claudeSetup":
      case "claude_setup": {
        config.claudeSetup = unquoteYamlScalar(value)
        break
      }
      case "copilotBaseUrl":
      case "copilot_base_url": {
        config.copilotBaseUrl = unquoteYamlScalar(value)
        break
      }
      case "host": {
        config.host = unquoteYamlScalar(value)
        break
      }
      case "gptModel":
      case "gpt_model": {
        config.gptModel = unquoteYamlScalar(value)
        break
      }
      case "logLevel":
      case "log_level": {
        config.logLevel = unquoteYamlScalar(value)
        break
      }
      case "logRetentionDays":
      case "log_retention_days": {
        config.logRetentionDays = unquoteYamlScalar(value)
        break
      }
      case "opusModel":
      case "opus_model": {
        config.opusModel = unquoteYamlScalar(value)
        break
      }
      case "port": {
        config.port = unquoteYamlScalar(value)
        break
      }
      case "thinkEffort":
      case "think_effort": {
        config.thinkEffort = unquoteYamlScalar(value)
        break
      }
      case "upstreamTimeoutSeconds":
      case "upstream_timeout_seconds": {
        config.upstreamTimeoutSeconds = unquoteYamlScalar(value)
        break
      }
      case "webSearchBackend":
      case "web_search_backend": {
        config.webSearchBackend = unquoteYamlScalar(value)
        break
      }
      default: {
        break
      }
    }
  }
  return config
}

const writeConfig = async (config: AppConfig): Promise<void> => {
  await fs.mkdir(paths.appDir, { recursive: true })
  const content = serializeConfig(config)
  const existing = await fs.readFile(paths.configPath, "utf8").catch(() => "")
  if (existing === content) {
    return
  }
  await fs.writeFile(paths.configPath, content, { mode: 0o600 })
}

const serializeConfig = (config: AppConfig): string =>
  [
    "# copilot-relay configuration",
    "#",
    "# This file is hot-reloaded while copilot-relay is running.",
    "",
    "# Local host for the Claude Code-compatible HTTP server.",
    `host: ${config.host}`,
    "",
    "# Local port for the HTTP server.",
    `port: ${config.port}`,
    "",
    "# GitHub Copilot API base URL.",
    `copilotBaseUrl: ${config.copilotBaseUrl}`,
    "",
    "# Update ~/.claude/settings.json on start.",
    `claudeSetup: ${config.claudeSetup}`,
    "",
    "# Log verbosity:",
    "#   error - startup/preflight/request failures only",
    "#   info  - error logs plus startup status, preflight status, and local HTTP",
    "#           status codes",
    "#   debug - info logs plus model routing summaries, Copilot upstream timings,",
    "#           and request payloads",
    `logLevel: ${config.logLevel}`,
    "",
    "# Number of days to keep files in ~/.copilot-relay/logs.",
    `logRetentionDays: ${config.logRetentionDays}`,
    "",
    "# Default upstream thinking/reasoning effort: none, low, medium, high, xhigh, max.",
    `thinkEffort: ${config.thinkEffort}`,
    "",
    "# Max seconds to wait for a single Claude request's upstream Copilot calls.",
    `upstreamTimeoutSeconds: ${config.upstreamTimeoutSeconds}`,
    "",
    "# Copilot model used for bridge-managed Claude WebSearch. Empty uses gptModel.",
    `webSearchBackend: ${config.webSearchBackend ?? ""}`,
    "",
    "# Model routing: requests containing \"opus\" use opusModel; all others use gptModel.",
    "",
    "# Upstream Copilot model used for non-Opus requests.",
    `gptModel: ${config.gptModel}`,
    "",
    "# Upstream Copilot model used for requests containing \"opus\".",
    `opusModel: ${config.opusModel}`,
    "",
  ].join("\n")

export async function readAppConfig(): Promise<AppConfig> {
  const raw = await readRawConfig()
  const claudeSetup = normalizeBoolean(raw.claudeSetup)
  const host = normalizeString(raw.host)
  const logLevel = normalizeLogLevel(raw.logLevel)
  const logRetentionDays = normalizePositiveInteger(raw.logRetentionDays)
  const port = normalizePort(raw.port)
  const thinkEffort = normalizeThinkEffort(raw.thinkEffort)
  const upstreamTimeoutSeconds = normalizeUpstreamTimeoutSeconds(
    raw.upstreamTimeoutSeconds,
  )

  const config: AppConfig = {
    claudeSetup: claudeSetup ?? defaultConfig.claudeSetup,
    copilotBaseUrl: normalizeString(raw.copilotBaseUrl) ?? defaultConfig.copilotBaseUrl,
    gptModel: normalizeString(raw.gptModel) ?? defaultConfig.gptModel,
    host: host ?? defaultConfig.host,
    logLevel: logLevel ?? defaultConfig.logLevel,
    logRetentionDays: logRetentionDays ?? defaultConfig.logRetentionDays,
    opusModel: normalizeString(raw.opusModel) ?? defaultConfig.opusModel,
    port: port ?? defaultConfig.port,
    thinkEffort: thinkEffort ?? defaultConfig.thinkEffort,
    upstreamTimeoutSeconds:
      upstreamTimeoutSeconds ?? defaultConfig.upstreamTimeoutSeconds,
    webSearchBackend: normalizeString(raw.webSearchBackend),
  }

  await writeConfig(config)
  return config
}

const getConfigMtime = async (): Promise<number> => {
  try {
    return (await fs.stat(paths.configPath)).mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0
    }
    throw error
  }
}

export const watchAppConfig = (
  onReload: (config: AppConfig) => void,
): ReturnType<typeof setInterval> => {
  let lastMtime = 0

  const timer = setInterval(async () => {
    try {
      const nextMtime = await getConfigMtime()
      if (nextMtime === lastMtime) {
        return
      }

      lastMtime = nextMtime
      onReload(await readAppConfig())
    } catch {
      // Config editors can briefly write invalid partial files. Keep the last
      // good runtime config rather than degrading live requests mid-edit.
    }
  }, 1000)

  if (typeof timer.unref === "function") {
    timer.unref()
  }

  void getConfigMtime().then((mtime) => {
    lastMtime = mtime
  })

  return timer
}
