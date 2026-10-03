// Runtime YAML config loader/writer with hot-reload support for ~/.copilot-relay/config.yaml.
import fs from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  configurableReasoningEfforts,
  defaultReasoningEffort,
  isConfiguredReasoningEffort,
  type ConfiguredReasoningEffort,
} from "~/lib/models"
import {
  FileConflictError,
  readFileSnapshot,
  writeFileSnapshot,
  type FileSnapshot,
} from "~/lib/atomic-file"
import { log } from "~/lib/log"
import { paths } from "~/lib/paths"
import { terminalText } from "~/lib/terminal"

export const logLevels = ["error", "info", "debug"] as const
export type LogLevelName = (typeof logLevels)[number]

export interface AppConfig {
  apiKey: string
  claudeSetup: boolean
  copilotBaseUrl: string
  gptModel: string
  host: string
  logLevel: LogLevelName
  logRetentionDays: number
  opusModel: string
  port: number
  thinkEffort: ConfiguredReasoningEffort
  upstreamTimeoutSeconds: number
  webSearchBackend?: string
  claudeUpstreamApi?: "auto" | "messages" | "chat-completions"
}

/**
 * Values used when a key is absent from the user's config.
 *
 * readAppConfig() writes the resolved config back to disk, so an existing
 * install has every key materialized and never consults these again. Changing
 * one therefore affects fresh installs only, by design: copilot-relay does not
 * rewrite a value the user's config already holds.
 */
const defaultConfig: AppConfig = {
  apiKey: "",
  claudeSetup: true,
  copilotBaseUrl: "https://api.githubcopilot.com",
  gptModel: "gpt-6-astra",
  host: "127.0.0.1",
  logLevel: "info",
  logRetentionDays: 3,
  opusModel: "claude-opus-5.5",
  port: 4142,
  thinkEffort: defaultReasoningEffort,
  upstreamTimeoutSeconds: 180,
  webSearchBackend: undefined,
  claudeUpstreamApi: "chat-completions",
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
    // Never repeat the value: this message is logged at startup and on hot reload, and a value
    // typed under the wrong key can be a credential.
    throw new Error(
      `Invalid logLevel: expected one of ${logLevels.join(", ")}`,
    )
  }

  return normalized
}

const normalizeClaudeUpstreamApi = (value: unknown): AppConfig["claudeUpstreamApi"] => {
  if (value === undefined) {
    return undefined
  }

  if (value === "auto" || value === "messages" || value === "chat-completions") {
    return value
  }

  throw new Error("Invalid claudeUpstreamApi: expected auto, messages, or chat-completions")
}

const normalizeBoolean = (value: unknown): boolean | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (typeof value === "boolean") {
    return value
  }

  if (typeof value === "string") {
    if (value.toLowerCase() === "true") {
      return true
    }

    if (value.toLowerCase() === "false") {
      return false
    }
  }

  throw new Error("Invalid claudeSetup: expected true or false")
}

const normalizeInteger = (
  value: unknown,
  key: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined => {
  if (value === undefined) {
    return undefined
  }

  // parseConfigYaml returns every scalar as a string, so a plain digit string is read as a number.
  const candidate = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value

  if (
    typeof candidate !== "number"
    || !Number.isSafeInteger(candidate)
    || candidate < minimum
    || candidate > maximum
  ) {
    throw new Error(`Invalid ${key}: expected an integer from ${minimum} to ${maximum}`)
  }

  return candidate
}

const normalizeString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined

const normalizeRequiredString = (value: unknown, key: string): string | undefined => {
  if (value === undefined) {
    return undefined
  }

  const normalized = normalizeString(value)
  if (normalized === undefined) {
    throw new Error(`Invalid ${key}: expected a non-empty string`)
  }

  return normalized
}

// A fixed string: the rejected value is never interpolated, for the reason given in normalizeLogLevel.
const invalidApiKeyMessage = "Invalid apiKey: expected empty, or at least 16 visible ASCII characters"

/**
 * Validates the optional inbound apiKey. Empty disables it.
 *
 * A set key is at least 16 visible ASCII characters. It travels in an HTTP
 * header, which cannot carry a space, a control byte or a non-ASCII character
 * reliably. Every logged copy of it is redacted as text, which would also hide
 * any ordinary text that a very short key happened to match.
 */
export const normalizeApiKey = (value: unknown): string | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== "string") {
    throw new Error(invalidApiKeyMessage)
  }

  const trimmed = value.trim()
  if (trimmed !== "" && !/^[\x21-\x7E]{16,}$/.test(trimmed)) {
    throw new Error(invalidApiKeyMessage)
  }

  return trimmed
}

/**
 * A conventional http(s) URL: scheme followed by a literal "//" authority.
 *
 * WHATWG is far more permissive than this. `https:host/path`, `https:/host/path`
 * and `https:\\host\path` all parse, all normalize to a real origin with the
 * tail in the path, and all work upstream - so a protocol check alone lets them
 * through. None of them can be found again in arbitrary log text: practical URL
 * detection anchors on a literal "://", and loosening that to chase a bare
 * "https:" would start matching ordinary prose. Requiring the authority prefix
 * is the one boundary where this has a definite answer. See #47.
 */
const conventionalHttpUrlPattern = /^https?:\/\//i

/**
 * Raw characters that cannot be delimited safely in rendered log text.
 *
 * A raw apostrophe is the clearest case. WHATWG accepts it and leaves it raw
 * in the path, so the configured value keeps it - and inspect() renders that
 * value inside quotes, where the apostrophe reads as the closing delimiter.
 * Any URL scan ends there, and the rest of the path prints in full. Quotes,
 * backticks and angle brackets are the same story; whitespace ends a URL for
 * every reader and scanner alike; and tab and newline are worse still,
 * because URL parsing strips them, so the stored value would not even match
 * what is sent upstream.
 *
 * Rejecting the raw byte costs nothing: every one of these has a
 * percent-encoded spelling that is unambiguous in log text and is accepted
 * here unchanged. See #47.
 */
const unsafeRawDelimiterPattern = /['"`<>\s\u0000-\u001F\u007F]/

/**
 * Both fixed strings. The rejected value is never interpolated: these messages
 * reach the terminal and, via the startup failure path, the log file, which is
 * exactly the disclosure being prevented.
 */
const invalidCopilotBaseUrlMessage =
  "Invalid copilotBaseUrl: expected an absolute http(s) URL, e.g. https://api.githubcopilot.com"
const copilotBaseUrlCredentialsMessage =
  "Invalid copilotBaseUrl: URL credentials (user:password@host) are not supported; remove them and use a plain https URL"
const copilotBaseUrlDelimiterMessage =
  "Invalid copilotBaseUrl: quotes, backticks, angle brackets, whitespace and control characters must be percent-encoded"

/**
 * Validates copilotBaseUrl as a conventional HTTP(S) URL without credentials.
 *
 * Four rules, all learned from #47:
 *
 * The value is concatenated as `${base}${path}` for every upstream call, so it
 * must be something Undici will accept. A relative or non-HTTP value fails at
 * request time as an unrelated-looking fetch error; failing here names the key.
 *
 * It must be written with an explicit `http://` or `https://` authority. See
 * conventionalHttpUrlPattern: the shorthand forms WHATWG also accepts are
 * unfindable in log text, so a configured secret in one of them cannot be
 * redacted by anything downstream. Rejecting is the only safe answer, and this
 * is the only place with enough context to give it.
 *
 * Raw quote-like characters, angle brackets, whitespace and control bytes are
 * rejected for the same reason - see unsafeRawDelimiterPattern. They are what
 * marks the end of a URL in rendered text, so a value containing one cannot be
 * matched whole afterwards. Their percent-encoded forms are accepted.
 *
 * URL userinfo (`https://user:pass@host`) is rejected rather than passed
 * through. Undici refuses it at request time anyway, so accepting it buys only
 * a confusing failure plus a credential written to the log on every start.
 *
 * The accepted value is returned as the trimmed original, never URL-normalized.
 * Round-tripping through URL would add a trailing slash, lowercase the host and
 * re-encode the path, silently changing both the request URL and what gets
 * written back to config.yaml.
 */
export const normalizeCopilotBaseUrl = (value: unknown): string | undefined => {
  const trimmed = normalizeString(value)
  if (trimmed === undefined) {
    return undefined
  }

  // Before new URL(), because the shorthand this rejects parses successfully -
  // it is a valid URL, just not one that can be redacted later.
  if (!conventionalHttpUrlPattern.test(trimmed)) {
    throw new Error(invalidCopilotBaseUrlMessage)
  }

  // Also before new URL(), for two reasons: it accepts every one of these, and
  // it silently strips tab and newline - so by the time it returned, the value
  // stored in config.yaml would no longer match the URL actually requested.
  if (unsafeRawDelimiterPattern.test(trimmed)) {
    throw new Error(copilotBaseUrlDelimiterMessage)
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(invalidCopilotBaseUrlMessage)
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(invalidCopilotBaseUrlMessage)
  }

  if (parsed.username || parsed.password) {
    throw new Error(copilotBaseUrlCredentialsMessage)
  }

  return trimmed
}

class InvalidThinkEffortError extends Error {
  constructor() {
    super(`Invalid thinkEffort. Valid values: ${configurableReasoningEfforts.join(", ")}. "none" is not allowed as a configured default.`)
    this.name = "InvalidThinkEffortError"
  }
}

export const normalizeThinkEffort = (
  value: unknown,
): ConfiguredReasoningEffort | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase() === "minimal" ? "low" : value.toLowerCase()
    if (isConfiguredReasoningEffort(normalized)) {
      return normalized
    }
  }

  throw new InvalidThinkEffortError()
}

export const normalizeUpstreamTimeoutSeconds = (
  value: unknown,
): number | undefined => {
  if (value === undefined) {
    return undefined
  }

  const timeout =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 0) {
    throw new Error("Invalid upstreamTimeoutSeconds: expected a non-negative integer (0 disables the deadline)")
  }

  return timeout
}

const readStartupDocument = async (snapshot: FileSnapshot): Promise<string> => {
  if (snapshot.raw !== null) {
    return snapshot.raw
  }

  for (const legacyPath of paths.legacyConfigPaths) {
    const legacy = await readFileSnapshot(legacyPath)
    if (legacy.raw !== null) {
      return legacy.raw
    }
  }

  return readDefaultConfigTemplate()
}

const readDefaultConfigTemplate = async (): Promise<string> => {
  let currentDir = dirname(fileURLToPath(import.meta.url))

  // Both src/ and a packaged dist/ locate the package-level template this way.
  while (true) {
    try {
      return await fs.readFile(resolve(currentDir, "config.default.yaml"), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }

      const parentDir = dirname(currentDir)
      if (parentDir === currentDir) {
        return ""
      }

      currentDir = parentDir
    }
  }
}

const configAliases: Record<string, keyof AppConfig> = {
  api_key: "apiKey",
  claude_setup: "claudeSetup",
  copilot_base_url: "copilotBaseUrl",
  gpt_model: "gptModel",
  log_level: "logLevel",
  log_retention_days: "logRetentionDays",
  opus_model: "opusModel",
  think_effort: "thinkEffort",
  upstream_timeout_seconds: "upstreamTimeoutSeconds",
  web_search_backend: "webSearchBackend",
  claude_upstream_api: "claudeUpstreamApi",
}

const configKeys = Object.keys(defaultConfig) as Array<keyof AppConfig>

// This is deliberately a flat scalar subset, not a permissive partial YAML
// parser. Quoted hashes stay literal; only whitespace-delimited hashes comment.
const parseYamlScalar = (value: string): string => {
  const trimmed = value.trim()
  if (trimmed.startsWith("'")) {
    const match = /^'((?:[^']|'')*)'(?:[ \t]+#.*)?[ \t]*$/.exec(trimmed)
    if (match) {
      return match[1].replaceAll("''", "'")
    }
  } else if (trimmed.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")(?:[ \t]+#.*)?[ \t]*$/.exec(trimmed)
    if (match) {
      try {
        return JSON.parse(match[1]) as string
      } catch {
        // An invalid escape falls through to the unsupported-syntax error below.
      }
    }
  } else {
    const plain = trimmed.replace(/(^|[ \t]+)#.*$/, "").trim()

    // A value that starts with one of these YAML indicators, or contains ": ", means something
    // other than a plain string to a full YAML parser, so it is rejected rather than read
    // differently here.
    if (!/^[\[\]{},&*!>|%@`]/.test(plain) && !/:[ \t]/.test(plain)) {
      return plain
    }
  }

  throw new Error("Invalid config scalar: unsupported YAML syntax")
}

const parseConfigYaml = (content: string): Record<string, unknown> => {
  const config: Record<string, unknown> = {}
  const seen = new Set<string>()

  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue
    }

    const match = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!match) {
      // Do not echo an invalid line: config values can contain private data.
      throw new Error(`Invalid config syntax on line ${index + 1}: expected a flat scalar key`)
    }

    const [, key, value] = match
    const canonical = Object.hasOwn(configAliases, key) ? configAliases[key] : key
    if (seen.has(canonical)) {
      throw new Error(`Duplicate config key on line ${index + 1}`)
    }

    seen.add(canonical)

    const scalar = parseYamlScalar(value)
    if (Object.hasOwn(defaultConfig, canonical)) {
      config[canonical] = scalar
    }
  }

  return config
}

const materializeMissingKeys = (
  document: string,
  raw: Record<string, unknown>,
  config: AppConfig,
): string => {
  const missing = new Set(configKeys.filter((key) => !Object.hasOwn(raw, key)))
  if (missing.size === 0) {
    return document
  }

  // Reuse the generated guidance only for absent keys. Never serialize an
  // explicitly supplied value over its spelling, comments, or unknown neighbors.
  // serializeConfig writes each key, with its guidance, as its own blank-line-separated section.
  const additions = serializeConfig(config)
    .split("\n\n")
    .filter((section) => {
      const key = /^([A-Za-z][A-Za-z0-9]*):/m.exec(section)?.[1]
      return key !== undefined && missing.has(key as keyof AppConfig)
    })
    .join("\n\n")
    .trimEnd()

  // Follow the document's own line endings, so a CRLF file is not left with mixed ones.
  const newline = document.includes("\r\n") ? "\r\n" : "\n"
  const separator = document && !document.endsWith("\n") ? newline : ""
  return document + separator + newline + additions.replaceAll("\n", newline) + newline
}

const serializeConfig = (config: AppConfig): string =>
  [
    "# copilot-relay configuration",
    "#",
    "# Valid complete edits hot-reload without rewriting this file.",
    "# host, port, and claudeSetup require restart.",
    "",
    "# Local host for the Claude Code-compatible HTTP server.",
    `host: ${config.host}`,
    "",
    "# Local port for the HTTP server.",
    `port: ${config.port}`,
    "",
    "# Key clients must send as x-api-key or Authorization: Bearer; empty disables it.",
    "# Set one before binding host beyond loopback.",
    `apiKey: ${config.apiKey}`,
    "",
    "# GitHub Copilot API base URL.",
    `copilotBaseUrl: ${config.copilotBaseUrl}`,
    "",
    "# Update ~/.claude/settings.json on start.",
    `claudeSetup: ${config.claudeSetup}`,
    "",
    "# Log verbosity:",
    "#   error - startup/preflight/request failures only",
    "#   info  - errors plus status, model/effort and semantic completion summaries",
    "#   debug - info plus full private bodies in ~/.copilot-relay/captures; may contain secrets",
    `logLevel: ${config.logLevel}`,
    "",
    "# Number of days to keep relay logs and settled debug captures.",
    `logRetentionDays: ${config.logRetentionDays}`,
    "",
    `# Fallback effort when the request omits it: ${configurableReasoningEfforts.join(", ")}.`,
    `thinkEffort: ${config.thinkEffort}`,
    "",
    "# Max seconds for one request's upstream calls; 0 disables the relay deadline.",
    `upstreamTimeoutSeconds: ${config.upstreamTimeoutSeconds}`,
    "",
    "# Copilot model used for bridge-managed Claude WebSearch. Empty uses gptModel.",
    `webSearchBackend: ${config.webSearchBackend ?? ""}`,
    "",
    "# Claude upstream protocol: auto, messages, or chat-completions.",
    `claudeUpstreamApi: ${config.claudeUpstreamApi ?? "chat-completions"}`,
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

const resolveConfig = (raw: Record<string, unknown>): AppConfig => ({
  apiKey: normalizeApiKey(raw.apiKey) ?? defaultConfig.apiKey,
  claudeSetup: normalizeBoolean(raw.claudeSetup) ?? defaultConfig.claudeSetup,
  copilotBaseUrl: normalizeCopilotBaseUrl(
    normalizeRequiredString(raw.copilotBaseUrl, "copilotBaseUrl"),
  ) ?? defaultConfig.copilotBaseUrl,
  gptModel: normalizeRequiredString(raw.gptModel, "gptModel") ?? defaultConfig.gptModel,
  host: normalizeRequiredString(raw.host, "host") ?? defaultConfig.host,
  logLevel: normalizeLogLevel(raw.logLevel) ?? defaultConfig.logLevel,
  logRetentionDays: normalizeInteger(raw.logRetentionDays, "logRetentionDays", 1)
    ?? defaultConfig.logRetentionDays,
  opusModel: normalizeRequiredString(raw.opusModel, "opusModel") ?? defaultConfig.opusModel,
  port: normalizeInteger(raw.port, "port", 1, 65_535) ?? defaultConfig.port,
  thinkEffort: normalizeThinkEffort(raw.thinkEffort) ?? defaultConfig.thinkEffort,
  upstreamTimeoutSeconds: normalizeUpstreamTimeoutSeconds(raw.upstreamTimeoutSeconds)
    ?? defaultConfig.upstreamTimeoutSeconds,
  webSearchBackend: normalizeString(raw.webSearchBackend),
  claudeUpstreamApi: normalizeClaudeUpstreamApi(raw.claudeUpstreamApi) ?? defaultConfig.claudeUpstreamApi,
})

export async function readAppConfig(): Promise<AppConfig> {
  const snapshot = await readFileSnapshot(paths.configPath)
  const document = await readStartupDocument(snapshot)
  const raw = parseConfigYaml(document)
  const config = resolveConfig(raw)
  const content = document ? materializeMissingKeys(document, raw, config) : serializeConfig(config)

  if (content !== snapshot.raw) {
    await writeFileSnapshot(snapshot, content)
  }

  return config
}

const sameSnapshot = (left: FileSnapshot, right: FileSnapshot): boolean =>
  left.resolvedPath === right.resolvedPath
  && left.raw === right.raw
  && left.mode === right.mode
  && JSON.stringify(left.identity) === JSON.stringify(right.identity)

// A reload failure the watcher has reported. snapshot is undefined when the file could not
// be read at all.
interface ReloadFailure {
  reason: string
  snapshot: FileSnapshot | undefined
}

const isSameFailure = (
  reported: ReloadFailure | undefined,
  reason: string,
  snapshot: FileSnapshot | undefined,
): boolean => {
  if (!reported || reported.reason !== reason) {
    return false
  }

  if (!reported.snapshot || !snapshot) {
    return reported.snapshot === snapshot
  }

  return sameSnapshot(reported.snapshot, snapshot)
}

// One read of the config file for a reload. Returns undefined when the file changed while it was
// read: that is a save in progress, not a failure, and the next tick reads the newer file.
const readConfigSnapshot = async (): Promise<FileSnapshot | undefined> => {
  try {
    return await readFileSnapshot(paths.configPath)
  } catch (error) {
    if (error instanceof FileConflictError) {
      return undefined
    }

    throw error
  }
}

export const watchAppConfig = (
  onReload: (config: AppConfig) => void,
): ReturnType<typeof setInterval> => {
  let lastSnapshot: FileSnapshot | undefined
  // The watcher retries an unchanged invalid file every tick. Logging every retry added one
  // identical error per second, so each pair of file snapshot and reason is logged once.
  let reportedFailure: ReloadFailure | undefined
  // setInterval does not wait for an async callback, so this keeps a slow reload from overlapping
  // the next tick.
  let reloading = false

  const timer = setInterval(async () => {
    if (reloading) {
      return
    }

    reloading = true
    let snapshot: FileSnapshot | undefined
    try {
      snapshot = await readConfigSnapshot()
      if (!snapshot) {
        return
      }

      if (lastSnapshot && sameSnapshot(lastSnapshot, snapshot)) {
        // A clean read of the applied file ends any failure logged since it was applied.
        reportedFailure = undefined
        return
      }

      if (snapshot.raw === null) {
        throw new Error("Config file is missing")
      }

      const raw = parseConfigYaml(snapshot.raw)
      // Removing even an optional-but-materialized field during an editor save
      // is not permission to restore its default or change the live backend.
      if (configKeys.some((key) => !Object.hasOwn(raw, key))) {
        throw new Error("Config reload requires every materialized key")
      }

      const config = resolveConfig(raw)

      // A save that lands while this one is being validated is picked up on the next tick.
      const current = await readConfigSnapshot()
      if (!current || !sameSnapshot(snapshot, current)) {
        return
      }

      onReload(config)

      // Failed verification or application must remain retryable without a new edit.
      lastSnapshot = snapshot
      reportedFailure = undefined
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (isSameFailure(reportedFailure, reason, snapshot)) {
        return
      }

      reportedFailure = { reason, snapshot }
      // Validation messages name a key, a line or a rule and never repeat a value, because a value
      // typed under the wrong key can be a credential. terminalText also drops C1 controls.
      const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`
      log.error(terminalText(
        `Could not reload config (${paths.configPath}): ${sentence} Keeping the previous runtime settings.`,
      ))
    } finally {
      reloading = false
    }
  }, 1000)

  // Unref'd, so the watcher alone does not keep the process running.
  if (typeof timer.unref === "function") {
    timer.unref()
  }

  return timer
}
