import type { CopilotModel } from "~/copilot/models"
import type { ProxyConfig } from "~/lib/config"
import { withoutLogging } from "~/lib/log"
import { isReasoningEffort, normalizeCopilotModelId, type ReasoningEffort } from "~/lib/models"
import { scrubSensitiveUrls } from "~/lib/redact"
import { runtimeState } from "~/lib/state"
import { createServer } from "~/server"
import { shouldUseResponsesApiForModel } from "~/copilot/responses"

export interface ModelProbeOptions {
  maxTokens: number
  timeoutMs: number
  totalTimeoutMs: number
  effort?: ReasoningEffort
}

type ProbeStatus = "PASS" | "FAIL" | "INCOMPLETE" | "SKIPPED" | "NOT_TESTED"
interface ProbeResult {
  id: string
  status: ProbeStatus
  reported: string
  sent: boolean
  latency: number
  detail: string
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const safeId = (id: unknown, token?: string): id is string =>
  typeof id === "string" && /^[A-Za-z0-9._\[\]-]{1,128}$/.test(id)
  && !(token && id.includes(token)) && !/(?:gh[pousr]_|github_pat_|sk-|eyJ)/.test(id)

const httpCategory = (status: number): string => {
  if (status === 401) return "authentication-rejected"
  if (status === 403) return "access-denied"
  if (status === 429) return "rate-limited"
  if (status === 499) return "cancelled"
  if (status === 504) return "upstream-timeout-or-HTTP-504"
  return `HTTP-${status}`
}

export async function probeModels(
  config: ProxyConfig,
  entries: Array<[string, CopilotModel]>,
  options: ModelProbeOptions,
): Promise<number> {
  console.log("\nDeep availability checks — isolated relay pipeline; not running-daemon health")
  console.log(`Real inference usage: up to ${entries.length} sequential probes, ${options.maxTokens} output tokens each (bounded client retries may add calls).`)
  const controller = new AbortController()
  const interrupt = () => controller.abort()
  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  const total = AbortSignal.timeout(options.totalTimeoutMs)
  const saved = { modelRouting: runtimeState.modelRouting, modelCatalog: runtimeState.modelCatalog, upstreamBaseUrl: runtimeState.upstreamBaseUrl }
  const results: ProbeResult[] = []
  const app = createServer(config)
  const width = entries.reduce((width, [id]) => Math.max(width, safeId(id, config.copilotToken) ? id.length : 16), 5)
  const reportWidth = width * 2 + 6
  console.log(`${"MODEL".padEnd(width)}  STATUS      ${"SENT/REPORTED".padEnd(reportWidth)}  LATENCY   DETAILS`)
  try {
    runtimeState.modelCatalog = config.modelCatalog
    runtimeState.upstreamBaseUrl = config.copilotBaseUrl
    for (const [id, model] of entries) {
      const row: ProbeResult = { id, status: "NOT_TESTED", reported: "-", sent: false, latency: 0, detail: "" }
      const efforts = ["none", "low", "medium", "high", "xhigh", "max"].filter((effort) => model.reasoningEfforts?.includes(effort))
      const effort = options.effort ?? efforts.find(isReasoningEffort) ?? "low"
      const maxTokens = Math.min(options.maxTokens, model.limits?.max_output_tokens ?? options.maxTokens,
        model.limits?.max_non_streaming_output_tokens ?? options.maxTokens)
      const timeoutMs = Math.min(options.timeoutMs, config.upstreamTimeoutMs > 0 ? config.upstreamTimeoutMs : Infinity)
      const endpoint = shouldUseResponsesApiForModel(id) ? "/responses" : "/chat/completions"
      if (controller.signal.aborted || total.aborted) {
        row.detail = controller.signal.aborted ? "cancelled" : "total-deadline"
      } else if (!safeId(id, config.copilotToken) || normalizeCopilotModelId(id) !== id) {
        row.status = "SKIPPED"; row.detail = "unsafe-or-noncanonical-id"
      } else if (model.type !== undefined && model.type !== "chat") {
        row.status = "SKIPPED"; row.detail = "unsupported-model-type"
      } else if (model.supportedEndpoints && !model.supportedEndpoints.includes(endpoint)) {
        row.status = "SKIPPED"; row.detail = "unsupported-relay-endpoint"
      } else if (model.reasoningEfforts && !model.reasoningEfforts.includes(effort)) {
        row.status = "SKIPPED"; row.detail = "unsupported-effort"
      } else {
        const signal = AbortSignal.any([controller.signal, total, AbortSignal.timeout(timeoutMs)])
        runtimeState.modelRouting = { gptModel: id, opusModel: id }
        const started = performance.now()
        row.sent = true
        try {
          const response = await withoutLogging(() => app.fetch(new Request("http://relay-probe.local/v1/messages", {
            method: "POST", headers: { "content-type": "application/json" }, signal,
            body: JSON.stringify({ model: id, stream: false, max_tokens: maxTokens,
              output_config: { effort }, messages: [{ role: "user", content: "Reply with OK only." }],
            }),
          })))
          const body: unknown = await response.json().catch(() => undefined)
          row.status = "FAIL"
          if (signal.aborted) {
            row.status = controller.signal.aborted || total.aborted ? "NOT_TESTED" : "FAIL"
            row.detail = controller.signal.aborted ? "cancelled" : total.aborted ? "total-deadline" : "probe-timeout"
          } else if (!response.ok) {
            row.detail = httpCategory(response.status)
            const code = record(body) && record(body.error) ? body.error.code : undefined
            if (code === "upstream_response_failed") row.detail = "upstream-response-failed"
            if (code === "upstream_response_incomplete") { row.status = "INCOMPLETE"; row.detail = "upstream-response-incomplete" }
            if (code === "unsupported_api_for_model") row.detail = "unsupported-api"
          } else if (!record(body) || !Array.isArray(body.content)) {
            row.detail = "malformed-response"
          } else {
            row.reported = safeId(body.model, config.copilotToken) ? body.model : "unreported"
            if (normalizeCopilotModelId(row.reported) !== id) row.detail = "model-mismatch"
            else if (body.stop_reason === "max_tokens") {
              row.status = "INCOMPLETE"
              const tokens = record(body.usage) ? body.usage.output_tokens : undefined
              row.detail = typeof tokens === "number" && Number.isSafeInteger(tokens) && tokens > 0 ? "reachable-output-budget-exhausted" : "output-budget-exhausted-usage-unreported"
            } else if (body.stop_reason !== "end_turn" || body.content.some((part: unknown) => record(part) && part.type !== "text" && part.type !== "thinking")) {
              row.detail = "refusal-or-unexpected-completion"
            } else if (body.content.some((part: unknown) => record(part) && part.type === "text" && typeof part.text === "string" && part.text.trim())) {
              row.status = "PASS"; row.detail = "completed-text"
            } else row.detail = "empty-completed-response"
          }
        } catch {
          row.status = controller.signal.aborted || total.aborted ? "NOT_TESTED" : "FAIL"
          row.detail = controller.signal.aborted ? "cancelled" : total.aborted ? "total-deadline" : signal.aborted ? "probe-timeout" : "network-or-invalid-response"
        }
        row.latency = Math.round(performance.now() - started)
      }
      row.detail += ` tokens=${maxTokens} effort=${effort}${model.reasoningEfforts === undefined ? "(unverified)" : ""}${model.supportedEndpoints === undefined ? " endpoints=unverified" : ""}`
      results.push(row)
      const displayId = safeId(id, config.copilotToken) ? id : "[unsupported ID]"
      console.log(scrubSensitiveUrls(`${displayId.padEnd(width)}  ${row.status.padEnd(10)}  ${(row.sent ? `${id}/${row.reported}` : "-/-").padEnd(reportWidth)}  ${`${row.latency}ms`.padEnd(8)}  ${row.detail}`))
    }
  } finally {
    for (const key of ["modelRouting", "modelCatalog", "upstreamBaseUrl"] as const) {
      if (saved[key] === undefined) delete runtimeState[key]
    }
    if (saved.modelRouting !== undefined) runtimeState.modelRouting = saved.modelRouting
    if (saved.modelCatalog !== undefined) runtimeState.modelCatalog = saved.modelCatalog
    if (saved.upstreamBaseUrl !== undefined) runtimeState.upstreamBaseUrl = saved.upstreamBaseUrl
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
  }
  const count = (status: ProbeStatus) => results.filter((row) => row.status === status).length
  console.log(`\nSummary: ${count("PASS")} passed, ${count("FAIL")} failed, ${count("INCOMPLETE")} incomplete, ${count("SKIPPED")} skipped, ${count("NOT_TESTED")} not tested`)
  console.log("PASS means completed text from the reported model, not tool/effort coverage or running-daemon health.")
  return controller.signal.aborted ? 130 : results.length > 0 && results.every((row) => row.status === "PASS") ? 0 : 2
}
