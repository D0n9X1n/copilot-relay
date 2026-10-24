// OpenAI Responses route for Codex CLI and the Codex app: POST /v1/responses, forwarded to Copilot's
// /responses with only the fields Copilot rejects changed, and its SSE or JSON returned unchanged.
import { Hono } from "hono"

import {
  contextOverflowStream,
  getCodexInitiator,
  includesImage,
  parseCodexPayload,
  prepareCodexPayload,
  resolveCodexModel,
} from "~/codex/request"
import {
  createCopilotRequestSignal,
  fetchCopilot,
  getCopilotProviderContext,
  readCopilotText,
  toPromptTooLongError,
} from "~/copilot/client"
import { getCachedCopilotModel } from "~/copilot/models"
import type { ProxyEnv } from "~/lib/config"
import { HTTPError, ProxyNotImplementedError } from "~/lib/error"
import { log } from "~/lib/log"
import { sanitizeTerminalString } from "~/lib/redact"
import type { RequestTrace } from "~/lib/request-trace"

export const responsesRoutes = new Hono<ProxyEnv>()

// Upstream headers Codex reads or a person needs to match a request with Copilot's logs.
const forwardedHeaders = [
  "content-type",
  "retry-after",
  "openai-model",
  "x-request-id",
  "x-github-request-id",
  "x-copilot-service-request-id",
]

const copyForwardedHeaders = (source: Headers): Headers => {
  const headers = new Headers()
  for (const name of forwardedHeaders) {
    const value = source.get(name)
    if (value !== null) {
      headers.set(name, value)
    }
  }

  return headers
}

// Codex names its subagents in this header; anything unexpected is logged as "other".
const readSubagent = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined
  }

  return /^[\w.-]{1,64}$/.test(value) ? value : "other"
}

/**
 * Passes the upstream body to the client and settles the request trace when it ends.
 *
 * The trace cancels every upstream body still open once the handler settles, so a streamed answer
 * must settle the handler only after its last byte, an error, or the client's cancellation.
 */
const settleWhenDone = (body: ReadableStream<Uint8Array>, trace: RequestTrace | undefined): ReadableStream<Uint8Array> => {
  const reader = body.getReader()
  // The end, an error and the client's cancellation can race; whichever comes first settles.
  let settled = false
  const settle = (error?: unknown) => {
    if (settled) {
      return
    }

    settled = true
    trace?.handlerSettled(error)
  }

  return new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const next = await reader.read()
        if (settled) {
          return
        }

        if (next.done) {
          controller.close()
          settle()
          return
        }

        controller.enqueue(next.value)
      } catch (error) {
        if (!settled) {
          controller.error(error)
        }

        settle(error)
      }
    },
    cancel: async (reason) => {
      settle()
      await reader.cancel(reason).catch(() => {})
    },
  }, { highWaterMark: 0 })
}

responsesRoutes.post("/responses", async (c) => {
  const config = c.get("config")
  const requestId = c.get("requestId")
  const trace = c.get("requestTrace")
  const signal = createCopilotRequestSignal(c.req.raw.signal, config.upstreamTimeoutMs)

  let response: Response
  let stream = false
  try {
    const payload = parseCodexPayload(await c.req.text())
    stream = payload.stream === true

    const model = await resolveCodexModel(config, payload.model)
    const prepared = prepareCodexPayload(payload, model, getCachedCopilotModel(config, model))
    const subagent = readSubagent(c.req.header("x-openai-subagent"))
    const initiator = getCodexInitiator(payload.input, subagent)

    log.info(sanitizeTerminalString([
      `request_id=${requestId}`,
      "Model request client=codex",
      `requested_model=${payload.model}`,
      `upstream_model=${model}`,
      "upstream_api=responses",
      `requested_think_effort=${prepared.requestedEffort ?? "unset"}`,
      `effective_think_effort=${prepared.effectiveEffort ?? "omitted"}`,
      `initiator=${initiator}`,
      ...(subagent === undefined ? [] : [`subagent=${subagent}`]),
      ...(prepared.removed.length === 0 ? [] : [`removed=${prepared.removed.join(",")}`]),
    ].join(" ")))

    response = await fetchCopilot(
      getCopilotProviderContext(config),
      "/responses",
      {
        method: "POST",
        headers: { accept: stream ? "text/event-stream" : "application/json", "content-type": "application/json" },
        body: JSON.stringify(prepared.payload),
      },
      {
        initiator,
        requestId,
        signal,
        timeoutMs: config.upstreamTimeoutMs,
        vision: includesImage(prepared.payload.input),
      },
    )

    if (!response.ok) {
      const detail = await readCopilotText(response, signal, config.upstreamTimeoutMs)
      const overflow = toPromptTooLongError(response.status, detail)

      if (overflow && stream) {
        c.set("requestErrorMessage", overflow.message)
        log.error(`request_id=${requestId} ${overflow.message}; sent to Codex as context_length_exceeded`)
        return new Response(contextOverflowStream(requestId, overflow.message), {
          status: 200,
          headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        })
      }

      // The body goes to Codex as it is; the log gets only the status, since a cut of upstream
      // text could split a secret the logger would otherwise recognize and redact.
      const message = `Copilot /responses returned ${response.status}`
      c.set("requestErrorMessage", message)
      log.error(`request_id=${requestId} ${message}`)
      return new Response(detail, { status: response.status, headers: copyForwardedHeaders(response.headers) })
    }
  } catch (error) {
    if (error instanceof ProxyNotImplementedError) {
      c.set("requestErrorMessage", error.message)
      return c.json({ error: { message: error.message, type: "server_error", code: "relay_not_configured" } }, 501)
    }

    if (!(error instanceof HTTPError)) {
      throw error
    }

    // A rejected request's message can quote the client's model name, so it is made terminal-safe.
    const message = sanitizeTerminalString(error.message)
    c.set("requestErrorMessage", message)
    log.error(`request_id=${requestId} ${message}`)
    if (error.response.status === 400 && trace?.manifest.exchanges.length === 0) {
      trace.recordFailure("local-validation")
    }

    return new Response(await error.response.arrayBuffer(), {
      status: error.response.status,
      headers: copyForwardedHeaders(error.response.headers),
    })
  }

  const headers = copyForwardedHeaders(response.headers)
  if (stream) {
    headers.set("cache-control", "no-cache")
  }

  if (!response.body) {
    return new Response(null, { status: response.status, headers })
  }

  trace?.deferHandler()
  return new Response(settleWhenDone(response.body, trace), { status: response.status, headers })
})
