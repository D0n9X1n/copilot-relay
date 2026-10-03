import type { ProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { getCachedCopilotModel } from "./models"

export const copilotEndpoints = [
  "/chat/completions",
  "/responses",
  "/v1/messages",
] as const

export type CopilotEndpoint = typeof copilotEndpoints[number]
export type EndpointSource = "catalog" | "legacy" | "policy"

export type EndpointUnavailableReason =
  | "unsupported-model-type"
  | "no-advertised-endpoint"
  | "unsupported-relay-endpoint"
  | "protocol-policy-conflict"

export type EndpointSelection =
  | {
    endpoint: CopilotEndpoint
    source: EndpointSource
    // Whether an exact unsupported_api_for_model Chat failure may retry once on Responses.
    responsesFallback: boolean
  }
  | {
    endpoint?: undefined
    reason: EndpointUnavailableReason
  }

// Preserve existing dual-endpoint/cache preferences; new models need only catalog support.
// gpt-5.4 (not gpt-5.4-mini) is the one later entry: Copilot's /chat/completions answers its
// tool-bearing requests with HTTP 400, while /responses accepts them.
const legacyResponsesPattern = /^(?:gpt-5\.4(?!-mini)|gpt-5\.5|gpt-5\.6|gpt-6-astra)(?:-|$)/i

// The one protocol decision shared by deep probes, startup preflight and request
// admission, so a model that passes a check is routed the same way in real traffic.
export function selectCopilotEndpoint(
  config: ProxyConfig,
  model: string,
): EndpointSelection {
  const capabilities = getCachedCopilotModel(config, model)
  const advertisedEndpoints = capabilities?.supportedEndpoints

  if (capabilities?.type !== undefined && capabilities.type !== "chat") {
    return { reason: "unsupported-model-type" }
  }

  const isClaude = model.startsWith("claude-")
  const protocolMode = config.claudeUpstreamApi ?? "chat-completions"

  // Explicit native selection remains authoritative even with an incomplete catalog.
  if (isClaude && protocolMode === "messages") {
    return {
      endpoint: "/v1/messages",
      source: "policy",
      responsesFallback: false,
    }
  }

  if (isClaude && protocolMode === "auto" && advertisedEndpoints?.includes("/v1/messages")) {
    return {
      endpoint: "/v1/messages",
      source: "catalog",
      responsesFallback: false,
    }
  }

  const isChatPinned = isClaude && protocolMode === "chat-completions"
  const preferredEndpoint = legacyResponsesPattern.test(model) ? "/responses" : "/chat/completions"

  // Missing metadata is uncertainty; an explicit empty list is a different contract.
  if (advertisedEndpoints === undefined) {
    return {
      endpoint: isChatPinned ? "/chat/completions" : preferredEndpoint,
      source: isChatPinned ? "policy" : "legacy",
      responsesFallback: !isChatPinned && preferredEndpoint === "/chat/completions",
    }
  }

  if (advertisedEndpoints.length === 0) {
    return { reason: "no-advertised-endpoint" }
  }

  if (isChatPinned) {
    if (advertisedEndpoints.includes("/chat/completions")) {
      return {
        endpoint: "/chat/completions",
        source: "policy",
        responsesFallback: false,
      }
    }

    const hasAlternativeProtocol = advertisedEndpoints.some(
      (endpoint) => endpoint === "/responses" || endpoint === "/v1/messages",
    )

    return {
      reason: hasAlternativeProtocol ? "protocol-policy-conflict" : "unsupported-relay-endpoint",
    }
  }

  // Catalog order must not flip a working model's protocol or cache path.
  const alternativeEndpoint = preferredEndpoint === "/responses" ? "/chat/completions" : "/responses"
  const selectedEndpoint = ([preferredEndpoint, alternativeEndpoint] as const).find(
    (endpoint) => advertisedEndpoints.includes(endpoint),
  )

  if (!selectedEndpoint) {
    return { reason: "unsupported-relay-endpoint" }
  }

  return {
    endpoint: selectedEndpoint,
    source: "catalog",
    responsesFallback: selectedEndpoint === "/chat/completions" && advertisedEndpoints.includes("/responses"),
  }
}

// Fixed relay-owned explanations: untrusted catalog values never reach client errors.
const unavailableEndpointMessages: Record<EndpointUnavailableReason, string> = {
  "unsupported-model-type": "The selected upstream model does not advertise a chat interface.",
  "no-advertised-endpoint": "The selected upstream model advertises no inference endpoints.",
  "unsupported-relay-endpoint": "The selected upstream model advertises no compatible relay endpoint.",
  "protocol-policy-conflict": "The selected upstream model has no Chat endpoint allowed by claudeUpstreamApi. Choose an advertised protocol explicitly.",
}

// Rejects locally with a fixed reason before any inference request is sent.
export function requireCopilotEndpoint(config: ProxyConfig, model: string) {
  const selection = selectCopilotEndpoint(config, model)

  if (selection.endpoint) {
    return selection
  }

  const message = unavailableEndpointMessages[selection.reason]
  const response = Response.json({
    type: "error",
    error: {
      type: "invalid_request_error",
      code: "relay_unsupported_endpoint",
      reason: selection.reason,
      message,
    },
  }, { status: 400 })

  throw new HTTPError(message, response, message)
}
