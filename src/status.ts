// `copilot-relay status`: report whether a relay is running, and whether it works.
import { defineCommand } from "citty"

import type { AppConfig } from "~/lib/app-config"

import { readAppConfig } from "~/lib/app-config"
import { readProxyConfig } from "~/lib/config"
import { findRelayOnPort } from "~/lib/lifecycle"
import { setLogLevel } from "~/lib/log"
import { getLogPath, paths } from "~/lib/paths"
import { appVersion } from "~/lib/version"

/**
 * Exit codes, so `status` is usable in a health check or a script.
 *
 * 2 is distinct from 1 on purpose: "running but broken" and "not running" call
 * for different responses - restart the service versus re-authenticate.
 *
 * A failed health probe is a 2, not a 0. Printing FAILED while exiting 0 would
 * make every scripted caller treat an unreachable relay as fine. See #34.
 */
const exitCodes = {
  notRunning: 1,
  notUsable: 2,
  running: 0,
} as const

const localProbeTimeoutMs = 5_000
// Generous: a real Copilot round trip, not a local socket check.
const deepProbeTimeoutMs = 60_000

interface ProbeResult {
  detail?: string
  ms?: number
  ok: boolean
}

/**
 * The resolved config as `status` reports it.
 *
 * Derived from AppConfig rather than restated, so a twelfth config key cannot
 * be added without this type following it automatically. The one deliberate
 * difference: `webSearchBackend` is null rather than undefined when unset.
 * JSON.stringify drops undefined properties, so leaving it optional would make
 * `status --json` emit 10 config keys on a default install and 11 on a
 * customized one; anything parsing that deserves a stable key set.
 */
export type StatusConfig = Omit<AppConfig, "webSearchBackend"> & {
  webSearchBackend: string | null
}

export const toStatusConfig = (config: AppConfig): StatusConfig => ({
  ...config,
  webSearchBackend: config.webSearchBackend ?? null,
})

export interface RelayStatus {
  baseUrl?: string
  /**
   * Every key readAppConfig() resolved — not the two that happened to fit in a
   * parenthetical. These are the values on disk; see renderConfig for why that
   * distinction is printed rather than assumed.
   */
  config: StatusConfig
  configPath: string
  /**
   * The version the running daemon reports about itself, which is not
   * necessarily `version` — that one is whichever CLI was invoked. Undefined
   * when nothing is running, or when the daemon predates version reporting.
   * See #43.
   */
  daemonVersion?: string
  deep?: ProbeResult
  health?: ProbeResult
  logPath: string
  logLevel: string
  models?: Array<string>
  pid?: number
  port?: number
  running: boolean
  startedAt?: string
  thinkEffort: string
  /** The CLI binary being invoked. Says nothing about what is serving. */
  version: string
}

/**
 * True when the daemon is serving a different build than the invoked CLI.
 *
 * Pure and exported because it drives both the rendered warning and the
 * deliberate decision to leave the exit code at 0; both deserve direct
 * coverage. Undefined daemonVersion is not a mismatch - unknown is not
 * different, and claiming otherwise would warn on every pre-v0.3.1 daemon.
 */
export const hasVersionMismatch = (status: RelayStatus): boolean =>
  status.running
  && status.daemonVersion !== undefined
  && status.daemonVersion !== status.version

/**
 * Status to exit code. Pure, because this mapping is the contract every
 * scripted caller depends on and deserves direct coverage.
 *
 * 0 requires a live process *and* a passing health probe. Printing FAILED while
 * exiting 0 would make every scripted caller treat an unreachable relay as
 * fine. See #34.
 *
 * A version mismatch stays 0 on purpose (#43). The relay works; it is just not
 * the build that was installed. Mapping it to 2 would overstate it and break
 * every scripted caller that treats non-zero as broken. It is surfaced in the
 * text instead.
 */
export const resolveExitCode = (status: RelayStatus): number =>
  !status.running ? exitCodes.notRunning
  : !status.health?.ok ? exitCodes.notUsable
  : status.deep && !status.deep.ok ? exitCodes.notUsable
  : exitCodes.running

const formatUptime = (startedAt: string | undefined): string => {
  if (!startedAt) {
    return "unknown"
  }

  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) {
    return "unknown"
  }

  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
  }
  return `${Math.floor(seconds / 86_400)}d ${Math.floor((seconds % 86_400) / 3600)}h`
}

/**
 * Every config key with its position in the block, in config.default.yaml order
 * rather than alphabetical so it reads like the file it was resolved from.
 *
 * A Record keyed by StatusConfig rather than an array of keys: an array only
 * checks that each entry *is* a key, so a twelfth config key would type-check
 * while silently never appearing in `status` — the exact failure this command
 * exists to prevent. Keyed this way, adding one fails the build here.
 */
const configRowOrder: Record<keyof StatusConfig, number> = {
  host: 0,
  port: 1,
  copilotBaseUrl: 2,
  claudeSetup: 3,
  logLevel: 4,
  logRetentionDays: 5,
  thinkEffort: 6,
  upstreamTimeoutSeconds: 7,
  webSearchBackend: 8,
  gptModel: 9,
  opusModel: 10,
}

const configRowKeys = (
  Object.keys(configRowOrder) as Array<keyof StatusConfig>
).sort((a, b) => configRowOrder[a] - configRowOrder[b])

/**
 * The resolved config, one key per line.
 *
 * These are the values on disk. That is not the same question as "what is the
 * running daemon honouring", and the footnote says so rather than leaving it
 * implied: applyRuntimeConfig() in start.ts hot-reloads eight of these keys,
 * never reads claudeSetup, and deliberately does not rebind the listening
 * socket when host or port changes. Printing all eleven without that line
 * would imply a live daemon had read values it has not.
 *
 * Only shown when running, because with nothing up every value applies at the
 * next start and the note would be noise.
 */
const renderConfig = (
  config: StatusConfig,
  running: boolean,
): Array<string> => {
  const lines = configRowKeys.map((key) => {
    const value = config[key]
    const rendered =
      key === "webSearchBackend" && value === null ?
        "(unset — uses gptModel)"
      : String(value)
    return `    ${key.padEnd(24)}${rendered}`
  })

  if (running) {
    lines.push(
      "    host, port and claudeSetup take effect on restart; the rest hot-reload.",
    )
  }

  return lines
}

/**
 * Pure state-to-lines mapping, kept free of IO so it can be tested directly
 * without spawning a relay or opening a socket.
 */
export const renderStatus = (status: RelayStatus): Array<string> => {
  const lines = [`copilot-relay ${status.version}`]

  if (!status.running) {
    lines.push(
      "  process    not running",
      `  log        ${status.logPath}`,
      `  config     ${status.configPath}`,
      ...renderConfig(status.config, false),
      "",
      "  Start it with: copilot-relay start",
    )
    return lines
  }

  lines.push(
    `  process    running (pid ${status.pid}, up ${formatUptime(status.startedAt)})`,
  )

  // The daemon's own build, distinct from the header line above, which is the
  // CLI that was invoked. Always shown when running: the case this exists for
  // is an upgrade the user believes landed, and a row that appears only on
  // mismatch would leave "did it even check?" unanswered. See #43.
  lines.push(
    status.daemonVersion === undefined ?
      "  version    unknown (daemon predates version reporting — restart to report it)"
    : hasVersionMismatch(status) ?
      `  version    ${status.daemonVersion} — MISMATCH, ${status.version} is installed`
    : `  version    ${status.daemonVersion}`,
  )

  lines.push(`  listening  ${status.baseUrl}`)

  const health = status.health
  lines.push(
    health?.ok ?
      `  health     ok (${health.ms}ms)`
    : `  health     FAILED${health?.detail ? ` — ${health.detail}` : ""}`,
  )

  lines.push(
    status.models?.length ?
      `  models     ${status.models.join(", ")}`
    : "  models     unavailable",
  )

  if (status.deep) {
    lines.push(
      status.deep.ok ?
        `  upstream   ok (${status.deep.ms}ms) — end-to-end Copilot round trip`
      : `  upstream   FAILED${status.deep.detail ? ` — ${status.deep.detail}` : ""}`,
    )
  } else {
    lines.push("  upstream   not checked (use --deep)")
  }

  lines.push(
    `  log        ${status.logPath}`,
    `  config     ${status.configPath}`,
    ...renderConfig(status.config, true),
  )

  // Only /v1/messages proves the relay can serve Claude Code; the first two
  // layers pass on a relay whose Copilot token expired an hour ago.
  if (status.health?.ok && status.deep && !status.deep.ok) {
    lines.push(
      "",
      "  The relay is listening but cannot reach Copilot.",
      "  Try: copilot-relay auth",
    )
  }

  // A mismatch is nearly always an upgrade that installed but never restarted,
  // so the next step is named rather than left to be inferred. Surfaced, not
  // just recorded: the version row alone reads as trivia next to a green
  // health line. See #43.
  if (hasVersionMismatch(status)) {
    lines.push(
      "",
      `  The running relay is ${status.daemonVersion}; ${status.version} is installed.`,
      "  Restart it to serve the installed version: copilot-relay restart",
    )
  }

  return lines
}

const probe = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ body: unknown; ms: number; ok: boolean; status: number }> => {
  const started = performance.now()
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = (await response.json().catch(() => undefined)) as unknown
  return {
    body,
    ms: Math.round(performance.now() - started),
    ok: response.ok,
    status: response.status,
  }
}

const describeError = (error: unknown): string =>
  error instanceof Error ?
    error.name === "TimeoutError" ? "timed out"
    : error.message
  : String(error)

/**
 * Probes /healthz, which also reports the daemon's own version.
 *
 * The version rides along on a probe `status` already makes, so asking what is
 * running costs nothing extra. Absent for a daemon older than v0.3.1, which is
 * itself informative, so it stays optional rather than defaulting to the
 * caller's version - that substitution is the bug. See #43.
 */
const checkHealth = async (
  baseUrl: string,
): Promise<{ result: ProbeResult; version?: string }> => {
  try {
    const probeResult = await probe(`${baseUrl}/healthz`, {}, localProbeTimeoutMs)
    const version = (probeResult.body as { version?: unknown } | undefined)
      ?.version
    return {
      result:
        probeResult.ok ?
          { ms: probeResult.ms, ok: true }
        : { detail: `http ${probeResult.status}`, ms: probeResult.ms, ok: false },
      ...(typeof version === "string" && version ? { version } : {}),
    }
  } catch (error) {
    return { result: { detail: describeError(error), ok: false } }
  }
}

const readModels = async (baseUrl: string): Promise<Array<string>> => {
  try {
    const result = await probe(`${baseUrl}/v1/models`, {}, localProbeTimeoutMs)
    const data = (result.body as { data?: Array<{ id?: string }> } | undefined)?.data
    return Array.isArray(data) ?
        data.flatMap((model) => (typeof model.id === "string" ? [model.id] : []))
      : []
  } catch {
    return []
  }
}

/**
 * Layer 3: a real request through Copilot.
 *
 * Opt-in because it spends tokens. It is the only check that exercises token
 * refresh, the upstream call, and translation back to Claude shape.
 */
const checkDeep = async (
  baseUrl: string,
  model: string,
): Promise<ProbeResult> => {
  try {
    const result = await probe(
      `${baseUrl}/v1/messages`,
      {
        body: JSON.stringify({
          max_tokens: 16,
          messages: [{ content: "Reply with the single word: ok", role: "user" }],
          model,
        }),
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        method: "POST",
      },
      deepProbeTimeoutMs,
    )

    if (!result.ok) {
      const message = (
        result.body as { error?: { message?: string } } | undefined
      )?.error?.message
      return {
        detail: message ? `http ${result.status}: ${message}` : `http ${result.status}`,
        ms: result.ms,
        ok: false,
      }
    }

    const content = (result.body as { content?: Array<unknown> } | undefined)?.content
    return Array.isArray(content) && content.length > 0 ?
        { ms: result.ms, ok: true }
      : { detail: "empty response", ms: result.ms, ok: false }
  } catch (error) {
    return { detail: describeError(error), ok: false }
  }
}

export const collectStatus = async (options: {
  deep: boolean
}): Promise<RelayStatus> => {
  const appConfig = await readAppConfig()
  setLogLevel(appConfig.logLevel)

  const base = {
    // Both of these are derived from the same appConfig as `config`, so they
    // cannot drift from it. They predate the config block and something may
    // parse them out of `status --json`, so they stay.
    config: toStatusConfig(appConfig),
    configPath: paths.configPath,
    logLevel: appConfig.logLevel,
    logPath: getLogPath(),
    thinkEffort: appConfig.thinkEffort,
    version: appVersion,
  }

  // Scoped to the configured port on purpose. `stop` scans globally so it can
  // clean up strays; `status` was asked about one relay, and reporting a
  // different one is worse than reporting nothing because it looks
  // authoritative. See #33.
  const relay = await findRelayOnPort(readProxyConfig(appConfig))
  if (!relay) {
    return { ...base, running: false }
  }

  // Address comes from the same record as the pid, so the two can never
  // describe different processes. The pid file's port is where the socket is
  // actually bound: hot reload updates config.port without rebinding.
  const baseUrl = `http://${relay.host}:${relay.port}`

  const health = await checkHealth(baseUrl)
  const models = health.result.ok ? await readModels(baseUrl) : []
  const deep =
    options.deep && health.result.ok ?
      await checkDeep(baseUrl, models[0] ?? appConfig.gptModel)
    : undefined

  // /healthz first: it is answered by the process itself, so it cannot be
  // stale. The pid file backs it up for a daemon that is up but not yet
  // healthy, which is exactly when the two sources are complementary. Both
  // absent means a daemon older than v0.3.1 — reported as unknown rather than
  // silently filled in with the CLI's version. See #43.
  const daemonVersion = health.version ?? relay.version

  return {
    ...base,
    baseUrl,
    ...(daemonVersion ? { daemonVersion } : {}),
    ...(deep ? { deep } : {}),
    health: health.result,
    models,
    pid: relay.pid,
    port: relay.port,
    running: true,
    ...(relay.startedAt ? { startedAt: relay.startedAt } : {}),
  }
}

export const status = defineCommand({
  meta: {
    name: "status",
    description: "Show whether copilot-relay is running and reachable.",
  },
  args: {
    deep: {
      description:
        "Also send a real request through Copilot. Proves the relay works end to end; spends a few tokens.",
      type: "boolean",
    },
    json: {
      description: "Emit machine-readable JSON.",
      type: "boolean",
    },
  },
  async run({ args }) {
    const result = await collectStatus({ deep: Boolean(args.deep) })

    // stdout, not the logger: this is the command's output, and routing it
    // through the logger would write a log line every time it is polled.
    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(renderStatus(result).join("\n"))
    }

    // 0 requires both a live process and a passing health probe. A relay that
    // cannot answer /healthz is running but not usable, which is a 2.
    process.exitCode = resolveExitCode(result)
  },
})
