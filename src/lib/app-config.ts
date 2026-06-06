import fs from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  defaultReasoningEffort,
  isReasoningEffort,
  type ReasoningEffort,
} from "~/lib/models"
import { paths } from "~/lib/paths"

export const logLevels = ["silent", "error", "warn", "info", "debug", "trace"] as const
export type LogLevelName = (typeof logLevels)[number]
export interface AppConfig {
  claudeSetup: boolean
  copilotBaseUrl: string
  gptModel: string
  host: string
  logLevel: LogLevelName
  opusModel: string
  port: number
  thinkEffort: ReasoningEffort
}

const defaultConfig: AppConfig = {
  claudeSetup: true,
  copilotBaseUrl: "https://api.githubcopilot.com",
  gptModel: "gpt-5.5",
  host: "127.0.0.1",
  logLevel: "info",
  opusModel: "claude-opus-4.8",
  port: 4142,
  thinkEffort: defaultReasoningEffort,
}

export const isLogLevelName = (value: unknown): value is LogLevelName =>
  typeof value === "string"
  && logLevels.includes(value.toLowerCase() as LogLevelName)

const normalizeLogLevel = (value: unknown): LogLevelName | undefined =>
  isLogLevelName(value) ? (value.toLowerCase() as LogLevelName) : undefined

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
    "#   silent - no logs",
    "#   error  - startup/preflight/request failures only",
    "#   warn   - error logs plus recoverable warnings",
    "#   info   - warn logs plus startup status, preflight status, HTTP requests,",
    "#            and model routing summaries",
    "#   debug  - info logs plus Copilot upstream timings, token refresh scheduling,",
    "#            and upstream error request summaries",
    "#   trace  - debug logs plus full Claude request payloads and full upstream",
    "#            Copilot request payloads without redaction",
    `logLevel: ${config.logLevel}`,
    "",
    "# Default upstream thinking/reasoning effort: none, low, medium, high, xhigh.",
    `thinkEffort: ${config.thinkEffort}`,
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
  const port = normalizePort(raw.port)
  const thinkEffort = normalizeThinkEffort(raw.thinkEffort)

  const config: AppConfig = {
    claudeSetup: claudeSetup ?? defaultConfig.claudeSetup,
    copilotBaseUrl: normalizeString(raw.copilotBaseUrl) ?? defaultConfig.copilotBaseUrl,
    gptModel: normalizeString(raw.gptModel) ?? defaultConfig.gptModel,
    host: host ?? defaultConfig.host,
    logLevel: logLevel ?? defaultConfig.logLevel,
    opusModel: normalizeString(raw.opusModel) ?? defaultConfig.opusModel,
    port: port ?? defaultConfig.port,
    thinkEffort: thinkEffort ?? defaultConfig.thinkEffort,
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
      // Keep the active config if the file is temporarily invalid.
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
