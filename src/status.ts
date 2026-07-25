// `copilot-relay status`: report whether a relay is running, and whether it works.
import { defineCommand } from "citty"

import { readAppConfig } from "~/lib/app-config"
import { readProxyConfig } from "~/lib/config"
import { findRelayProcessIds, readRelayPidFileEntry } from "~/lib/lifecycle"
import { setLogLevel } from "~/lib/log"
import { getLogPath, paths } from "~/lib/paths"
import { appVersion } from "~/lib/version"

/**
 * Exit codes, so `status` is usable in a health check or a script.
 *
 * 2 is distinct from 1 on purpose: "running but broken" and "not running" call
 * for different responses - restart the service versus re-authenticate.
 */
const exitCodes = {
  deepCheckFailed: 2,
  notRunning: 1,
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

export interface RelayStatus {
  baseUrl?: string
  configPath: string
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
  version: string
}

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
 * Pure state-to-lines mapping, kept free of IO so it can be tested directly
 * without spawning a relay or opening a socket.
 */
export const renderStatus = (status: RelayStatus): Array<string> => {
  const lines = [`copilot-relay ${status.version}`]

  if (!status.running) {
    lines.push(
      "  process    not running",
      `  config     ${status.configPath} (logLevel=${status.logLevel}, thinkEffort=${status.thinkEffort})`,
      `  log        ${status.logPath}`,
      "",
      "  Start it with: copilot-relay start",
    )
    return lines
  }

  lines.push(
    `  process    running (pid ${status.pid}, up ${formatUptime(status.startedAt)})`,
    `  listening  ${status.baseUrl}`,
  )

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
    `  config     ${status.configPath} (logLevel=${status.logLevel}, thinkEffort=${status.thinkEffort})`,
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

const checkHealth = async (baseUrl: string): Promise<ProbeResult> => {
  try {
    const result = await probe(`${baseUrl}/healthz`, {}, localProbeTimeoutMs)
    return result.ok ?
        { ms: result.ms, ok: true }
      : { detail: `http ${result.status}`, ms: result.ms, ok: false }
  } catch (error) {
    return { detail: describeError(error), ok: false }
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
    configPath: paths.configPath,
    logLevel: appConfig.logLevel,
    logPath: getLogPath(),
    thinkEffort: appConfig.thinkEffort,
    version: appVersion,
  }

  // Share detection with `stop` rather than reimplementing it, so the two can
  // never disagree about what counts as a running relay.
  const pids = await findRelayProcessIds(readProxyConfig(appConfig))
  if (pids.length === 0) {
    return { ...base, running: false }
  }

  const entry = await readRelayPidFileEntry()
  // The pid file is authoritative for the address, not the config: hot reload
  // updates config.port but deliberately does not rebind the listening socket,
  // so a config edited while the relay runs would send us at the wrong port.
  const host = entry?.host ?? appConfig.host
  const port = entry?.port ?? appConfig.port
  const baseUrl = `http://${host}:${port}`

  const health = await checkHealth(baseUrl)
  const models = health.ok ? await readModels(baseUrl) : []
  const deep =
    options.deep && health.ok ?
      await checkDeep(baseUrl, models[0] ?? appConfig.gptModel)
    : undefined

  return {
    ...base,
    baseUrl,
    ...(deep ? { deep } : {}),
    health,
    models,
    pid: entry?.pid ?? pids[0],
    port,
    running: true,
    ...(entry?.startedAt ? { startedAt: entry.startedAt } : {}),
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

    process.exitCode =
      !result.running ? exitCodes.notRunning
      : result.deep && !result.deep.ok ? exitCodes.deepCheckFailed
      : exitCodes.running
  },
})
