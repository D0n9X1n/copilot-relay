import { advertisesNoReasoningEffort, type CopilotModel } from "~/copilot/models"
import type { ProxyConfig } from "~/lib/config"
import { log, withoutConsoleLogging, withoutLogging } from "~/lib/log"
import { RequestTrace, withTraceObserver, type RequestDiagnostic } from "~/lib/request-trace"
import { colorEnabled } from "~/lib/terminal"
import {
  probeColumnWidth,
  probeHint,
  renderProbeDetails,
  renderProbeHeader,
  renderProbeRow,
  renderProbeSummary,
  type ProbeRow,
} from "~/lib/model-probe-output"
import { isReasoningEffort, normalizeCopilotModelId, type ReasoningEffort } from "~/lib/models"
import { scrubSensitiveUrls } from "~/lib/redact"
import { runtimeState } from "~/lib/state"
import { createServer } from "~/server"
import { copilotEndpoints, selectCopilotEndpoint } from "~/copilot/endpoint"

export interface ModelProbeOptions {
  maxTokens: number
  timeoutMs: number
  totalTimeoutMs: number
  effort?: ReasoningEffort
  details?: boolean
}

interface ProbeResult extends ProbeRow {
  diagnostic?: RequestDiagnostic
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const safeId = (id: unknown, token?: string): id is string =>
  typeof id === "string" && /^[A-Za-z0-9._\[\]-]{1,128}$/.test(id)
  && !(token && id.includes(token)) && !/(?:gh[pousr]_|github_pat_|sk-|eyJ)/.test(id)

const httpCategory = (status: number): string => {
  if (status === 401) {
    return "authentication-rejected"
  }

  if (status === 403) {
    return "access-denied"
  }

  if (status === 429) {
    return "rate-limited"
  }

  if (status === 499) {
    return "cancelled"
  }

  if (status === 504) {
    return "upstream-timeout-or-HTTP-504"
  }

  return `HTTP-${status}`
}

// Print only known endpoint constants: catalog strings are untrusted and can contain
// secrets, so anything unrecognized is reported only as a count.
const summarizeAdvertisedEndpoints = (supportedEndpoints: string[] | undefined) => {
  if (supportedEndpoints === undefined) {
    return { advertisedEndpoints: "unknown", unknownEndpoints: 0 }
  }

  if (supportedEndpoints.length === 0) {
    return { advertisedEndpoints: "none", unknownEndpoints: 0 }
  }

  const knownEndpoints = copilotEndpoints.filter((endpoint) => supportedEndpoints.includes(endpoint))
  const unknownEndpoints = supportedEndpoints.filter(
    (endpoint) => !copilotEndpoints.some((known) => known === endpoint),
  ).length

  return { advertisedEndpoints: knownEndpoints.join(",") || "none-compatible", unknownEndpoints }
}

const settleDiagnostic = async (trace: RequestTrace): Promise<void> => {
  // The response must be consumed first; slow capture storage must not hold the CLI open.
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, 1000)
  })
  try {
    await Promise.race([trace.finished, deadline])
  } finally {
    clearTimeout(timer)
  }
}

const failureFromEvidence = (row: ProbeResult, diagnostic: RequestDiagnostic): string => {
  if (["probe-timeout", "cancelled", "total-deadline"].includes(row.detail)) {
    return row.detail
  }

  if (diagnostic.refreshes.includes("failure")) {
    return "refresh-failed"
  }

  if (diagnostic.failure === "invalid-tool-input" || diagnostic.failure === "local-validation") {
    return diagnostic.failure
  }

  const lastExchange = diagnostic.exchanges.findLast((exchange) => !exchange.discarded)
  if (lastExchange?.error && ["HTTP-500", "network-or-invalid-response"].includes(row.detail)) {
    return lastExchange.error === "SyntaxError" ? "malformed-response" : "transport-error"
  }

  if (diagnostic.failure === "internal-error" || row.detail === "network-or-invalid-response") {
    return "unknown-error"
  }

  return row.detail
}

export async function probeModels(
  config: ProxyConfig,
  entries: Array<[string, CopilotModel]>,
  options: ModelProbeOptions,
): Promise<number> {
  console.log(`\nModel check · ${entries.length} ${entries.length === 1 ? "model" : "models"} · real Copilot usage`)
  console.log("Isolated relay pipeline; not running-daemon health.")
  console.log(`Up to ${options.maxTokens} output tokens/probe; existing retries may add calls.\n`)
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  const total = AbortSignal.timeout(options.totalTimeoutMs)
  // Probes route exact catalog IDs in this process, then restore the caller's policy.
  const saved = {
    modelRouting: runtimeState.modelRouting,
    modelCatalog: runtimeState.modelCatalog,
    upstreamBaseUrl: runtimeState.upstreamBaseUrl,
  }
  const results: ProbeResult[] = []
  const app = createServer(config)
  const columns = Math.max(40, process.stdout.columns || 80)
  const width = probeColumnWidth(entries.map(([id]) => safeId(id, config.copilotToken) ? id : "[unsupported ID]"), columns)
  const color = colorEnabled()
  if (entries.length) {
    console.log(renderProbeHeader(width))
  }

  try {
    runtimeState.modelCatalog = config.modelCatalog
    runtimeState.upstreamBaseUrl = config.copilotBaseUrl
    for (const [id, model] of entries) {
      const recognizedEfforts = ["none", "low", "medium", "high", "xhigh", "max"].filter(
        (effort) => model.reasoningEfforts?.includes(effort),
      )
      // Probe the lowest advertised tier, send no effort to a model that advertises no
      // effort support, and fall back to "low" (marked unverified) when metadata is missing.
      const defaultProbeEffort = advertisesNoReasoningEffort(model)
        ? undefined
        : recognizedEfforts.find(isReasoningEffort) ?? "low"
      const effort = options.effort ?? defaultProbeEffort

      const maxTokens = Math.min(
        options.maxTokens,
        model.limits?.max_output_tokens ?? options.maxTokens,
        model.limits?.max_non_streaming_output_tokens ?? options.maxTokens,
      )
      const timeoutMs = Math.min(options.timeoutMs, config.upstreamTimeoutMs > 0 ? config.upstreamTimeoutMs : Infinity)
      const selection = selectCopilotEndpoint(config, id)
      const endpoint = selection.endpoint ?? "none"
      const { advertisedEndpoints, unknownEndpoints } = summarizeAdvertisedEndpoints(model.supportedEndpoints)

      const row: ProbeResult = {
        id: safeId(id, config.copilotToken) ? id : "[unsupported ID]",
        status: "NOT_TESTED",
        reported: "-",
        sent: false,
        endpoint,
        latency: 0,
        detail: "",
        maxTokens,
        effort: effort ?? "omitted",
        routeSource: selection.endpoint ? selection.source : "unavailable",
        advertisedEndpoints,
        unknownEndpoints,
        unverified: model.reasoningEfforts === undefined || model.supportedEndpoints === undefined,
      }

      if (controller.signal.aborted || total.aborted) {
        row.detail = controller.signal.aborted ? "cancelled" : "total-deadline"
      } else if (!safeId(id, config.copilotToken) || normalizeCopilotModelId(id) !== id) {
        row.status = "SKIPPED"
        row.detail = "unsafe-or-noncanonical-id"
      } else if (!selection.endpoint) {
        row.status = "SKIPPED"
        row.detail = selection.reason
      } else if (effort !== undefined && model.reasoningEfforts && !model.reasoningEfforts.includes(effort)) {
        row.status = "SKIPPED"
        row.detail = "unsupported-effort"
      } else {
        const signal = AbortSignal.any([controller.signal, total, AbortSignal.timeout(timeoutMs)])
        runtimeState.modelRouting = { gptModel: id, opusModel: id }
        const started = performance.now()
        row.sent = true
        let trace: RequestTrace | undefined
        let completedFetch = false

        const observeTrace = (value: RequestTrace) => {
          trace = value
        }

        const sendProbe = async () => {
          const response = await app.fetch(new Request(`http://localhost${config.port ? `:${config.port}` : ""}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal,
            body: JSON.stringify({
              model: id,
              stream: false,
              max_tokens: maxTokens,
              ...(effort !== undefined && { output_config: { effort } }),
              messages: [{ role: "user", content: "Reply with OK only." }],
            }),
          }))
          const body: unknown = await response.json().catch(() => undefined)
          return { response, body }
        }

        try {
          const { response, body } = await withoutLogging(() => withTraceObserver(observeTrace, sendProbe))
          completedFetch = true
          row.status = "FAIL"
          if (signal.aborted) {
            if (controller.signal.aborted) {
              row.status = "NOT_TESTED"
              row.detail = "cancelled"
            } else if (total.aborted) {
              row.status = "NOT_TESTED"
              row.detail = "total-deadline"
            } else {
              row.detail = "probe-timeout"
            }
          } else if (!response.ok) {
            row.detail = httpCategory(response.status)
            const code = record(body) && record(body.error) ? body.error.code : undefined
            if (code === "upstream_response_failed") {
              row.detail = "upstream-response-failed"
            }

            if (code === "upstream_response_incomplete") {
              row.status = "INCOMPLETE"
              row.detail = "upstream-response-incomplete"
            }

            if (code === "unsupported_api_for_model") {
              row.detail = "unsupported-api"
            }
          } else if (!record(body) || !Array.isArray(body.content)) {
            row.detail = "malformed-response"
          } else {
            row.reported = safeId(body.model, config.copilotToken) ? body.model : "unreported"
            const nativeOpusSpelling = endpoint === "/v1/messages" && id === "claude-opus-5.5" && row.reported === "claude-opus-5-5"
            if (normalizeCopilotModelId(row.reported) !== id && !nativeOpusSpelling) {
              row.detail = "model-mismatch"
            } else if (body.stop_reason === "max_tokens") {
              row.status = "INCOMPLETE"
              const tokens = record(body.usage) ? body.usage.output_tokens : undefined
              row.detail = typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0 ? "reachable-output-budget-exhausted" : "output-budget-exhausted-usage-unreported"
            } else if (body.stop_reason !== "end_turn" || body.content.some((part: unknown) => record(part) && part.type !== "text" && part.type !== "thinking")) {
              row.detail = body.stop_reason === "refusal" ? "refusal" : "refusal-or-unexpected-completion"
            } else if (body.content.some((part: unknown) => record(part) && part.type === "text" && typeof part.text === "string" && part.text.trim())) {
              row.status = "PASS"
              row.detail = "completed-text"
            } else {
              row.detail = "empty-completed-response"
            }
          }
        } catch {
          if (controller.signal.aborted) {
            row.status = "NOT_TESTED"
            row.detail = "cancelled"
          } else if (total.aborted) {
            row.status = "NOT_TESTED"
            row.detail = "total-deadline"
          } else {
            row.status = "FAIL"
            row.detail = signal.aborted ? "probe-timeout" : "network-or-invalid-response"
          }
        }

        row.latency = Math.round(performance.now() - started)
        if (trace) {
          if (completedFetch) {
            await settleDiagnostic(trace)
          }

          row.diagnostic = trace.diagnosticSnapshot()
          // The trace knows every attempted credential, including tokens refreshed during this probe.
          if (row.reported !== "-" && !row.diagnostic.reportedModel) {
            row.reported = "unreported"
          }

          if (row.status === "FAIL") {
            row.detail = failureFromEvidence(row, row.diagnostic)
          }
        }
      }

      if (!safeId(id, config.copilotToken)) {
        row.id = "[unsupported ID]"
      }

      results.push(row)
      for (const line of renderProbeRow(row, width, color, columns)) {
        console.log(scrubSensitiveUrls(line))
      }

      if (options.details) {
        for (const line of renderProbeDetails(row, row.diagnostic)) {
          console.log(line)
        }
      } else if (row.status !== "PASS" && row.diagnostic) {
        console.log(`  request_id=${row.diagnostic.requestId}`)
      }

      if (row.status !== "PASS" && row.sent) {
        withoutConsoleLogging(() => log.info(
          `request_id=${row.diagnostic?.requestId ?? "unknown"} model_probe model=${row.id} status=${row.status} reason=${row.detail}`,
        ))
      }
    }
  } finally {
    for (const key of ["modelRouting", "modelCatalog", "upstreamBaseUrl"] as const) {
      if (saved[key] === undefined) {
        delete runtimeState[key]
      }
    }

    if (saved.modelRouting !== undefined) {
      runtimeState.modelRouting = saved.modelRouting
    }

    if (saved.modelCatalog !== undefined) {
      runtimeState.modelCatalog = saved.modelCatalog
    }

    if (saved.upstreamBaseUrl !== undefined) {
      runtimeState.upstreamBaseUrl = saved.upstreamBaseUrl
    }

    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
  }

  console.log(`\n${renderProbeSummary(results)}`)
  if (results.some((row) => row.unverified)) {
    console.log("* Effort or endpoint metadata is unverified.")
  }

  const hints = new Set(results.filter((row) => row.status !== "PASS").map((row) => probeHint(row.detail)).filter(Boolean))
  for (const hint of hints) {
    console.log(hint)
  }

  if (!options.details && results.some((row) => row.status !== "PASS" && row.sent)) {
    console.log("Use --details for request evidence; another deep run consumes usage.")
  }

  if (controller.signal.aborted) {
    return 130
  }

  return results.length > 0 && results.every((row) => row.status === "PASS") ? 0 : 2
}
