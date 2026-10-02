import { colorText, terminalText, type TerminalTone } from "./terminal"
import type { RequestDiagnostic } from "./request-trace"

export type ProbeStatus = "PASS" | "FAIL" | "INCOMPLETE" | "SKIPPED" | "NOT_TESTED"
export interface ProbeRow {
  id: string
  status: ProbeStatus
  reported: string
  sent: boolean
  endpoint: string
  routeSource?: string
  advertisedEndpoints?: string
  unknownEndpoints?: number
  latency: number
  detail: string
  maxTokens: number
  effort: string
  unverified: boolean
}

const tones: Record<ProbeStatus, TerminalTone> = {
  PASS: "good", FAIL: "bad", INCOMPLETE: "warning", SKIPPED: "muted", NOT_TESTED: "muted",
}
const reasonLabels: Record<string, string> = {
  "completed-text": "Ready",
  "probe-timeout": "Timed out",
  "upstream-timeout-or-HTTP-504": "Upstream timeout (504)",
  "authentication-rejected": "Auth rejected (401)",
  "access-denied": "Access denied (403)",
  "rate-limited": "Rate limited (429)",
  "cancelled": "Cancelled",
  "total-deadline": "Time budget reached",
  "unsupported-model-type": "Not a chat model",
  "unsupported-relay-endpoint": "Unsupported route",
  "no-advertised-endpoint": "No advertised route",
  "protocol-policy-conflict": "Protocol policy conflict",
  "unsupported-api": "Unsupported API",
  "unsupported-effort": "Unsupported effort",
  "unsafe-or-noncanonical-id": "Unsupported model ID",
  "upstream-response-failed": "Upstream failed",
  "upstream-response-incomplete": "Incomplete response",
  "malformed-response": "Invalid response",
  "model-mismatch": "Model mismatch",
  "reachable-output-budget-exhausted": "Output limit reached",
  "output-budget-exhausted-usage-unreported": "Output limit reached",
  "refusal-or-unexpected-completion": "Unexpected completion",
  "refusal": "Refused",
  "empty-completed-response": "Empty response",
  "network-or-invalid-response": "Request failed",
  "transport-error": "Connection failed",
  "refresh-failed": "Token refresh failed",
  "invalid-tool-input": "Invalid tool input",
  "local-validation": "Request rejected",
  "unknown-error": "Unknown API error",
}

export const probeReason = (code: string): string => reasonLabels[code]
  ?? (/^HTTP-\d{3}$/.test(code) ? `HTTP ${code.slice(5)}` : "Unknown result")

export const probeColumnWidth = (ids: string[], columns: number): number =>
  Math.min(Math.max(14, ...ids.map((id) => terminalText(id).length)), Math.max(14, columns - 42))

export const renderProbeHeader = (width: number): string =>
  `${"MODEL".padEnd(width)}  ${"STATUS".padEnd(10)}  ${"TIME".padStart(6)}  RESULT`

const wrap = (text: string, width: number): string[] => {
  const lines: string[] = []
  for (let index = 0; index < text.length; index += width) {
    lines.push(text.slice(index, index + width))
  }

  return lines
}

const probeTime = (row: ProbeRow): string => {
  if (!row.sent) {
    return "-"
  }

  const seconds = row.latency / 1000
  if (seconds < 1000) {
    return `${seconds.toFixed(1)}s`
  }

  if (seconds < 3600) {
    return `${(seconds / 60).toFixed(1)}m`
  }

  return `${(seconds / 3600).toFixed(1)}h`
}

export const renderProbeRow = (row: ProbeRow, width: number, color: boolean, columns = 80): string[] => {
  const modelLines = wrap(terminalText(row.id), width)
  const time = probeTime(row)
  const label = probeReason(row.detail) + (row.unverified ? " *" : "")
  const resultLines = wrap(label, Math.max(1, columns - width - 22))
  // ANSI bytes do not occupy columns, so pad the uncolored label separately.
  const status = colorText(row.status, tones[row.status], color) + " ".repeat(10 - row.status.length)
  return Array.from({ length: Math.max(modelLines.length, resultLines.length) }, (_, index) => {
    const model = (modelLines[index] ?? "").padEnd(width)
    const statusAndTime = index === 0 ? `  ${status}  ${time.padStart(6)}  ` : " ".repeat(22)
    return `${model}${statusAndTime}${resultLines[index] ?? ""}`.trimEnd()
  })
}

export const renderProbeSummary = (rows: ProbeRow[]): string => {
  if (!rows.length) {
    return "Summary: no models to test"
  }

  const labels: Record<ProbeStatus, string> = { PASS: "passed", FAIL: "failed", INCOMPLETE: "incomplete", SKIPPED: "skipped", NOT_TESTED: "not tested" }
  return "Summary: " + (Object.keys(labels) as ProbeStatus[]).flatMap((status) => {
    const count = rows.filter((row) => row.status === status).length
    return count ? [`${count} ${labels[status]}`] : []
  }).join(" · ")
}

export const renderProbeDetails = (row: ProbeRow, diagnostic?: RequestDiagnostic): string[] => {
  // Diagnostic fields have already crossed the trace's disclosure-safe allowlist.
  const lines = [
    `  effort=${row.effort} max_tokens=${row.maxTokens} planned_route=${row.endpoint}`,
    `  reported=${row.reported} reason=${row.detail}`,
  ]
  if (row.routeSource) {
    lines.push(`  route_source=${row.routeSource} advertised_endpoints=${row.advertisedEndpoints} unknown_endpoints=${row.unknownEndpoints}`)
  }

  lines.push(`  sent=${row.sent ? row.id : "not-started"}`)

  if (!diagnostic) {
    return [...lines, "  request=not started"]
  }

  lines.push(`  request_id=${diagnostic.requestId}`)
  lines.push(`  client_http=${diagnostic.status ?? "unknown"} response=${diagnostic.responseState ?? "unknown"} terminal=${diagnostic.terminal ? "observed" : "not observed"}`)
  for (const exchange of diagnostic.exchanges) {
    lines.push(`  route=${exchange.path} upstream_http=${exchange.status ?? "unknown"} response=${exchange.responseState ?? "unknown"}${exchange.discarded ? " discarded=yes" : ""}`)
    lines.push(`  upstream_request_id=${exchange.upstreamRequestId ?? "unknown"}`)
    if (exchange.providerRequestId) {
      lines.push(`  provider_request_id=${exchange.providerRequestId}`)
    }

    if (exchange.model && exchange.model !== row.reported) {
      lines.push(`  upstream_model=${exchange.model}`)
    }

    if (exchange.messageId) {
      lines.push(`  message_id=${exchange.messageId}`)
    }

    const outcome = exchange.stopReason ?? exchange.finishReason ?? exchange.responseStatus
    if (outcome || exchange.error) {
      lines.push(`  outcome=${outcome ?? "unknown"}${exchange.error ? ` transport=${exchange.error}` : ""}`)
    }

    if (exchange.refusalCategory) {
      lines.push(`  refusal_category=${exchange.refusalCategory}`)
    }

    if (exchange.incompleteReason) {
      lines.push(`  incomplete_reason=${exchange.incompleteReason}`)
    }
  }

  if (diagnostic.refreshes.length) {
    lines.push(`  refresh=${diagnostic.refreshes.join(",")}`)
  }

  lines.push(`  capture=${diagnostic.capture.state}`)
  if (diagnostic.capture.state === "complete") {
    lines.push(`  Offline replay: copilot-relay replay ${diagnostic.requestId}`)
  } else if (diagnostic.capture.state === "off") {
    lines.push("  Replay unavailable: debug was off; capture privately if the error repeats.")
  } else {
    lines.push("  Replay unavailable: capture is not complete.")
  }

  return lines
}

const apiFailureCodes = [
  "invalid-tool-input",
  "malformed-response",
  "upstream-response-failed",
  "unknown-error",
  "network-or-invalid-response",
  "transport-error",
]

// One short next step per failure category; the summary deduplicates repeated hints.
export const probeHint = (code: string): string | undefined => {
  if (code === "protocol-policy-conflict") {
    return "Protocol policy: review claudeUpstreamApi and the advertised endpoints before changing an existing conversation's route."
  }

  // Skipped rows were never sent upstream, so they say nothing about account access.
  if (code === "unsupported-relay-endpoint" || code === "no-advertised-endpoint") {
    return "Route unavailable: --details distinguishes missing support from account access; skipped models were not sent an inference request."
  }

  if (code === "probe-timeout" || code === "upstream-timeout-or-HTTP-504") {
    return "Timeout: check connection and configured deadline."
  }

  if (code === "authentication-rejected" || code === "refresh-failed") {
    return "Authentication: run copilot-relay auth before another probe."
  }

  if (code === "access-denied") {
    return "Access: check this account's model entitlement and gateway policy."
  }

  if (code === "rate-limited") {
    return "Rate limit: wait before retrying; repeated probes consume usage."
  }

  if (code === "refusal") {
    return "Refusal: inspect the failing request's evidence; a short probe does not explain its cause."
  }

  if (code.includes("budget-exhausted")) {
    return "Output limit: reachability is not completion; review the probe's output budget."
  }

  if (code === "model-mismatch") {
    return "Model mismatch: compare selected, sent and reported IDs with --details."
  }

  if (apiFailureCodes.includes(code) || /^HTTP-5\d\d$/.test(code)) {
    return "API failure: the request ID locates the local summary; --details shows evidence on a new probe."
  }

  return undefined
}
