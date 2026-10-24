// Codex's OpenAI Responses requests: the Copilot model each one reaches, and the few fields Copilot
// rejects. Everything else in the body is forwarded as Codex sent it.
import type { ProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { getModelRouting, isClaudeModelId, normalizeCopilotModelId } from "~/lib/models"
import {
  ensureCopilotModelCatalog,
  getCachedCopilotModel,
  pinCopilotModelCatalog,
  type CopilotModel,
} from "~/copilot/models"

export type CodexPayload = Record<string, unknown> & { model: string; input: unknown }

export interface PreparedCodexRequest {
  payload: CodexPayload
  // Names of the fields removed because Copilot rejects them, for the request log.
  removed: Array<string>
  requestedEffort?: string
  effectiveEffort?: string
}

// The levels Copilot's /responses accepts, as its own error for an unknown level lists them. Used
// when the catalog does not say which levels a model takes.
const copilotReasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"]

// Every level Codex can send, lowest first. Codex offers "ultra" for several models; Copilot
// answers it with HTTP 400.
const effortOrder = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// An error in the shape the OpenAI Responses API uses, which is the shape Codex parses.
export const codexRequestError = (message: string, code: string, status = 400): HTTPError =>
  new HTTPError(
    message,
    Response.json({ error: { message, type: "invalid_request_error", code } }, { status }),
    message,
  )

export const parseCodexPayload = (text: string): CodexPayload => {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw codexRequestError("The request body is not valid JSON.", "invalid_json")
  }

  if (!isRecord(body) || typeof body.model !== "string" || body.model.trim() === "") {
    throw codexRequestError("The request needs a model.", "missing_model")
  }

  if (typeof body.input !== "string" && !Array.isArray(body.input)) {
    throw codexRequestError("The request needs an input string or array.", "missing_input")
  }

  return body as CodexPayload
}

const catalogDescribesUpstream = (config: ProxyConfig): boolean =>
  config.modelCatalog?.baseUrl === config.copilotBaseUrl

export interface CodexRoute {
  model: string
  // responses: Copilot /responses, forwarded. messages: Copilot /v1/messages, translated.
  api: "responses" | "messages"
}

/**
 * The Copilot model a Codex request is sent to, and the API that serves it.
 *
 * A model Copilot's catalog lists is used as named, so Codex's own model IDs reach the same
 * Copilot model. A GPT model listed with /responses is forwarded there; a Claude model listed with
 * /v1/messages is translated to Messages, because Copilot serves Claude only there and on Chat
 * Completions. A name the catalog does not list, such as Codex's internal codex-auto-review, goes
 * to the configured gptModel, as Claude Code's aliases do. Without a catalog a non-Claude name is
 * forwarded unchanged.
 */
export const resolveCodexModel = async (config: ProxyConfig, requested: string): Promise<CodexRoute> => {
  const normalized = normalizeCopilotModelId(requested)

  // Refreshes the catalog once when it does not list the model, so a newly added model is found,
  // then pins it: the effort clamp later reads the same capabilities that admitted the request.
  await ensureCopilotModelCatalog(config, normalized)
  pinCopilotModelCatalog(config)

  if (isClaudeModelId(normalized)) {
    const capabilities = getCachedCopilotModel(config, normalized)
    if (capabilities === undefined) {
      throw codexRequestError(
        `${requested} is not in Copilot's model list. Check copilot-relay models for the exact Claude model ID.`,
        "relay_unsupported_model",
      )
    }

    if (capabilities.supportedEndpoints !== undefined && !capabilities.supportedEndpoints.includes("/v1/messages")) {
      throw codexRequestError(
        `${normalized} does not serve Claude Messages on Copilot, which Codex needs for Claude models.`,
        "relay_unsupported_endpoint",
      )
    }

    return { model: normalized, api: "messages" }
  }

  const listed = getCachedCopilotModel(config, normalized) !== undefined
  const model = !listed && catalogDescribesUpstream(config) ? getModelRouting().gptModel : normalized
  const capabilities = getCachedCopilotModel(config, model)
  const notChat = capabilities?.type !== undefined && capabilities.type !== "chat"
  const noResponses =
    capabilities?.supportedEndpoints !== undefined && !capabilities.supportedEndpoints.includes("/responses")

  if (notChat || noResponses) {
    throw codexRequestError(
      `${model} does not serve the Responses API on Copilot. Choose a model that lists /responses in copilot-relay models.`,
      "relay_unsupported_endpoint",
    )
  }

  return { model, api: "responses" }
}

const effortRank = (effort: string): number => effortOrder.indexOf(effort)

/**
 * The reasoning effort to send for a requested one.
 *
 * A level the model advertises, or one this relay does not know, is sent as requested. Any other
 * level becomes the highest advertised level below it, or the lowest advertised level when none is
 * below it. A model that advertises no levels gets none, since Copilot rejects the field for it.
 */
export const clampReasoningEffort = (
  requested: string,
  advertised: Array<string> | undefined,
): string | undefined => {
  if (advertised?.length === 0) {
    return undefined
  }

  const accepted = advertised ?? copilotReasoningEfforts
  if (accepted.includes(requested) || effortRank(requested) === -1) {
    return requested
  }

  const ranked = accepted
    .filter((effort) => effortRank(effort) !== -1)
    .sort((left, right) => effortRank(left) - effortRank(right))
  const below = ranked.filter((effort) => effortRank(effort) <= effortRank(requested))

  return below.at(-1) ?? ranked[0]
}

/**
 * The body sent to Copilot for a Codex request.
 *
 * Copilot answers HTTP 400 to `service_tier`, to an `image_generation` tool, and to an effort it
 * does not accept; those are the only changes. Every other field, including Codex's
 * prompt_cache_key and its encrypted reasoning, is forwarded unchanged.
 */
export const prepareCodexPayload = (
  payload: CodexPayload,
  model: string,
  capabilities: CopilotModel | undefined,
): PreparedCodexRequest => {
  const prepared: CodexPayload = { ...payload, model }
  const removed: Array<string> = []

  if (Object.hasOwn(prepared, "service_tier")) {
    delete prepared.service_tier
    removed.push("service_tier")
  }

  if (Array.isArray(prepared.tools)) {
    const tools = prepared.tools.filter((tool) => !(isRecord(tool) && tool.type === "image_generation"))

    if (tools.length !== prepared.tools.length) {
      prepared.tools = tools
      removed.push("image_generation")
    }
  }

  const reasoning = isRecord(prepared.reasoning) ? prepared.reasoning : undefined
  const requestedEffort = typeof reasoning?.effort === "string" ? reasoning.effort : undefined
  let effectiveEffort = requestedEffort

  if (reasoning !== undefined && requestedEffort !== undefined) {
    effectiveEffort = clampReasoningEffort(requestedEffort, capabilities?.reasoningEfforts)

    if (effectiveEffort === undefined) {
      const withoutEffort = { ...reasoning }
      delete withoutEffort.effort
      prepared.reasoning = withoutEffort
    } else if (effectiveEffort !== requestedEffort) {
      prepared.reasoning = { ...reasoning, effort: effectiveEffort }
    }
  }

  return { payload: prepared, removed, requestedEffort, effectiveEffort }
}

/**
 * Who started a Codex request, for Copilot's x-initiator header.
 *
 * A request continues the agent's own work unless its last input item is a user message: after a
 * tool call the last item is the tool's output. Codex marks its subagents (review, compaction,
 * memory consolidation, spawned agents) with x-openai-subagent, and those are always the agent.
 */
export const getCodexInitiator = (input: unknown, subagent: string | undefined): "agent" | "user" => {
  if (subagent !== undefined) {
    return "agent"
  }

  if (typeof input === "string") {
    return "user"
  }

  const last = Array.isArray(input) ? input.at(-1) : undefined
  const isUserMessage =
    isRecord(last)
    && last.role === "user"
    && (last.type === undefined || last.type === "message")

  return isUserMessage ? "user" : "agent"
}

// Whether any input item carries an image, including images inside tool output.
export const includesImage = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(includesImage)
  }

  if (!isRecord(value)) {
    return false
  }

  return value.type === "input_image" || Object.values(value).some(includesImage)
}

/**
 * A stream holding only `response.failed` with code `context_length_exceeded`.
 *
 * Copilot reports a prompt over the model's input limit as HTTP 400, which Codex treats as a fatal
 * error. Codex recognizes a context-window overflow only from this event, and answers it by
 * compacting the conversation.
 */
export const contextOverflowStream = (requestId: string, message: string): string => {
  const event = {
    type: "response.failed",
    response: {
      id: `resp_relay_${requestId}`,
      object: "response",
      status: "failed",
      error: { code: "context_length_exceeded", message },
    },
  }

  return `event: response.failed\ndata: ${JSON.stringify(event)}\n\n`
}
