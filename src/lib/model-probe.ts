import { advertisesNoReasoningEffort, type CopilotModel } from "~/copilot/models"
import type { ProxyConfig } from "~/lib/config"
import { log, scrubLogSecrets, withoutConsoleLogging, withoutLogging } from "~/lib/log"
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

// Whether text contains the live Copilot token or the relay's apiKey. Both are read from the
// config on each call, so a token refreshed during a probe is checked too.
const holdsCredential = (text: string, config: ProxyConfig): boolean => {
  for (const secret of [config.copilotToken, config.apiKey]) {
    if (secret && text.includes(secret)) {
      return true
    }
  }

  return false
}

// Model IDs come from the catalog and from response bodies, so one is probed and printed only when
// it is a plain identifier that holds neither credential above nor a known credential prefix
// (GitHub tokens, sk- keys, JWTs).
const safeId = (id: unknown, config: ProxyConfig): id is string =>
  typeof id === "string"
  && /^[A-Za-z0-9._\[\]-]{1,128}$/.test(id)
  && !holdsCredential(id, config)
  && !/(?:gh[pousr]_|github_pat_|sk-|eyJ)/.test(id)

// Every line probeModels prints, --details included, is scrubbed again as a backstop behind
// safeId and the trace's allowlist.
const printLine = (line: string): void => {
  console.log(scrubLogSecrets(scrubSensitiveUrls(line)))
}

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

const datedSnapshot = /^(.+)-\d{4}-\d{2}-\d{2}$/

// Whether a probe reply names the catalog ID the probe selected. Beyond the relay's known GPT
// context suffix, each accepted difference is an exact provider behavior seen in live replies.
const reportsSelectedModel = (endpoint: string, id: string, reported: string): boolean => {
  if (normalizeCopilotModelId(reported) === id) {
    return true
  }

  // The native Messages endpoint reports this model with a hyphen where the catalog ID has a dot.
  if (endpoint === "/v1/messages" && id === "claude-opus-5.5" && reported === "claude-opus-5-5") {
    return true
  }

  // The catalog's gpt-5.6-sol-fast is the priority service tier of gpt-5.6-sol; its Responses
  // reply reports the base model (#126).
  if (endpoint === "/responses" && id === "gpt-5.6-sol-fast" && normalizeCopilotModelId(reported) === "gpt-5.6-sol") {
    return true
  }

  // Copilot answers some undated IDs with a dated snapshot of the same model: gpt-5.5 reported
  // gpt-5.5-2026-04-23 (#137). A dated request must match exactly, and an alias served by
  // another model is still a mismatch.
  return !datedSnapshot.test(id) && datedSnapshot.exec(reported)?.[1] === id
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
  printLine(`\nModel check · ${entries.length} ${entries.length === 1 ? "model" : "models"} · real Copilot usage`)
  printLine("Isolated relay pipeline; not running-daemon health.")
  printLine(`Up to ${options.maxTokens} output tokens/probe; existing retries may add calls.\n`)

  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  const totalDeadline = AbortSignal.timeout(options.totalTimeoutMs)

  // Probes route exact catalog IDs in this process, then restore the caller's policy.
  const saved = {
    modelRouting: runtimeState.modelRouting,
    modelCatalog: runtimeState.modelCatalog,
    upstreamBaseUrl: runtimeState.upstreamBaseUrl,
  }

  const results: ProbeResult[] = []
  const app = createServer(config)
  const columns = Math.max(40, process.stdout.columns || 80)
  const width = probeColumnWidth(
    entries.map(([id]) => safeId(id, config) ? id : "[unsupported ID]"),
    columns,
  )
  const color = colorEnabled()

  if (entries.length) {
    printLine(renderProbeHeader(width))
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
      // "none" is probed only when it is the sole tier: the relay never sends it on its own,
      // and gpt-6.1-sol advertises it yet rejects it with HTTP 400 (#126).
      const lowestRealEffort = recognizedEfforts.find((effort) => effort !== "none")
      const lowestEffort = lowestRealEffort ?? recognizedEfforts.find(isReasoningEffort)
      const defaultProbeEffort = advertisesNoReasoningEffort(model)
        ? undefined
        : lowestEffort ?? "low"
      const effort = options.effort ?? defaultProbeEffort

      const maxTokens = Math.min(
        options.maxTokens,
        model.limits?.max_output_tokens ?? options.maxTokens,
        model.limits?.max_non_streaming_output_tokens ?? options.maxTokens,
      )

      // upstreamTimeoutSeconds: 0 disables the relay deadline, leaving only the probe's own timeout.
      const timeoutMs = Math.min(
        options.timeoutMs,
        config.upstreamTimeoutMs > 0 ? config.upstreamTimeoutMs : Infinity,
      )
      const selection = selectCopilotEndpoint(config, id)
      const endpoint = selection.endpoint ?? "none"
      const { advertisedEndpoints, unknownEndpoints } = summarizeAdvertisedEndpoints(model.supportedEndpoints)

      const row: ProbeResult = {
        id: safeId(id, config) ? id : "[unsupported ID]",
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

      if (controller.signal.aborted || totalDeadline.aborted) {
        row.detail = controller.signal.aborted ? "cancelled" : "total-deadline"
      } else if (!safeId(id, config) || normalizeCopilotModelId(id) !== id) {
        row.status = "SKIPPED"
        row.detail = "unsafe-or-noncanonical-id"
      } else if (!selection.endpoint) {
        row.status = "SKIPPED"
        row.detail = selection.reason
      } else if (effort !== undefined && model.reasoningEfforts && !model.reasoningEfforts.includes(effort)) {
        row.status = "SKIPPED"
        row.detail = "unsupported-effort"
      } else {
        const signal = AbortSignal.any([controller.signal, totalDeadline, AbortSignal.timeout(timeoutMs)])
        runtimeState.modelRouting = { gptModel: id, opusModel: id }
        const started = performance.now()
        row.sent = true

        let trace: RequestTrace | undefined
        let completedFetch = false

        const observeTrace = (value: RequestTrace) => {
          trace = value
        }

        // app.fetch handles the request in this process, so nothing has to listen on this URL.
        const sendProbe = async () => {
          const response = await app.fetch(
            new Request(`http://localhost${config.port ? `:${config.port}` : ""}/v1/messages`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                // The in-process app admits a probe exactly as the daemon would, apiKey included.
                ...(config.apiKey ? { "x-api-key": config.apiKey } : {}),
              },
              signal,
              body: JSON.stringify({
                model: id,
                stream: false,
                max_tokens: maxTokens,
                ...(effort !== undefined && { output_config: { effort } }),
                messages: [{ role: "user", content: "Reply with OK only." }],
              }),
            }),
          )
          const body: unknown = await response.json().catch(() => undefined)
          return { response, body }
        }

        try {
          // The pipeline's own logging is silenced so it cannot interleave with the table. A failed
          // row is logged once below, to the file only.
          const { response, body } = await withoutLogging(() => withTraceObserver(observeTrace, sendProbe))
          completedFetch = true
          row.status = "FAIL"
          if (signal.aborted) {
            if (controller.signal.aborted) {
              row.status = "NOT_TESTED"
              row.detail = "cancelled"
            } else if (totalDeadline.aborted) {
              row.status = "NOT_TESTED"
              row.detail = "total-deadline"
            } else {
              row.detail = "probe-timeout"
            }
          } else if (!response.ok) {
            row.detail = httpCategory(response.status)

            // A known error code in the body refines the HTTP category.
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

            if (code === "model_not_supported") {
              row.detail = "model-not-supported"
            }
          } else if (!record(body) || !Array.isArray(body.content)) {
            row.detail = "malformed-response"
          } else {
            // PASS needs all of: a reported model that matches the probe, an end_turn stop, no
            // content block with a type other than text or thinking, and some non-empty text.
            // Content entries that are not objects are skipped, not treated as blocks.
            row.reported = safeId(body.model, config) ? body.model : "unreported"

            if (!reportsSelectedModel(endpoint, id, row.reported)) {
              row.detail = "model-mismatch"
            } else if (body.stop_reason === "max_tokens") {
              row.status = "INCOMPLETE"
              const outputTokens = record(body.usage) ? body.usage.output_tokens : undefined
              row.detail = typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) && outputTokens > 0
                ? "reachable-output-budget-exhausted"
                : "output-budget-exhausted-usage-unreported"
            } else if (
              body.stop_reason !== "end_turn"
              || body.content.some(
                (part: unknown) => record(part) && part.type !== "text" && part.type !== "thinking",
              )
            ) {
              row.detail = body.stop_reason === "refusal" ? "refusal" : "refusal-or-unexpected-completion"
            } else if (
              body.content.some(
                (part: unknown) => record(part)
                  && part.type === "text"
                  && typeof part.text === "string"
                  && part.text.trim(),
              )
            ) {
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
          } else if (totalDeadline.aborted) {
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

      // The token may have been refreshed during the probe, so the ID is checked against the
      // current one too.
      if (!safeId(id, config)) {
        row.id = "[unsupported ID]"
      }

      results.push(row)
      for (const line of renderProbeRow(row, width, color, columns)) {
        printLine(line)
      }

      if (options.details) {
        for (const line of renderProbeDetails(row, row.diagnostic)) {
          printLine(line)
        }
      } else if (row.status !== "PASS" && row.diagnostic) {
        printLine(`  request_id=${row.diagnostic.requestId}`)
      }

      // File only: the table above has already shown this row on the console.
      if (row.status !== "PASS" && row.sent) {
        withoutConsoleLogging(() => log.info(
          `request_id=${row.diagnostic?.requestId ?? "unknown"} model_probe model=${row.id} status=${row.status} reason=${row.detail}`,
        ))
      }
    }
  } finally {
    // A key that was unset before the probe is deleted again rather than left holding undefined.
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

  printLine(`\n${renderProbeSummary(results)}`)
  if (results.some((row) => row.unverified)) {
    printLine("* Effort or endpoint metadata is unverified.")
  }

  // A Set, so a hint shared by several failed rows prints once.
  const hints = new Set(
    results
      .filter((row) => row.status !== "PASS")
      .map((row) => probeHint(row.detail))
      .filter((hint) => hint !== undefined),
  )

  for (const hint of hints) {
    printLine(hint)
  }

  if (!options.details && results.some((row) => row.status !== "PASS" && row.sent)) {
    printLine("Use --details for request evidence; another deep run consumes usage.")
  }

  // 130 is what a shell reports for Ctrl-C (128 + SIGINT); a SIGTERM abort exits the same way.
  if (controller.signal.aborted) {
    return 130
  }

  return results.length > 0 && results.every((row) => row.status === "PASS") ? 0 : 2
}
