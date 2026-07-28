// HTTP server assembly: exposes only Claude Code-compatible public routes.
import { randomUUID } from "node:crypto"

import { createAdaptorServer, type ServerType } from "@hono/node-server"
import { Hono } from "hono"
import { cors } from "hono/cors"

import type { ProxyConfig, ProxyEnv } from "~/lib/config"
import { log } from "~/lib/log"
import { claudeRoutes } from "~/routes/claude"

const loggedRequestHeaders = [
  "anthropic-beta",
  "anthropic-version",
  "claude-beta",
  "content-type",
]

const readRequestPayloadForLog = async (request: Request): Promise<unknown> => {
  const text = await request.clone().text().catch(() => "")
  if (!text) {
    return undefined
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

const getLoggedHeaders = (request: Request): Record<string, string> =>
  Object.fromEntries(
    loggedRequestHeaders.flatMap((name) => {
      const value = request.headers.get(name)
      return value ? [[name, value]] : []
    }),
  )

const formatStatusLog = (
  requestId: string,
  method: string,
  path: string,
  status: number,
  ms: number,
  errorMessage: string | undefined,
): string => {
  const base = `request_id=${requestId} ${method} ${path} -> ${status} ${ms}ms`
  return status >= 400 && errorMessage ? `${base} error=${JSON.stringify(errorMessage)}` : base
}

export const createServer = (config: ProxyConfig) => {
  const app = new Hono<ProxyEnv>()

  app.use("*", async (c, next) => {
    const requestId = randomUUID()
    c.set("config", config)
    c.set("requestId", requestId)
    c.header("x-copilot-relay-request-id", requestId)
    log.info(`request_id=${requestId} request received method=${c.req.method} path=${c.req.path}`)

    const started = performance.now()
    try {
      await next()
    } finally {
      const ms = Math.round(performance.now() - started)
      // Emit exactly one info-level request summary even when downstream route
      // handling throws; deeper diagnostics belong to debug/error logs.
      log.info(formatStatusLog(
        requestId,
        c.req.method,
        c.req.path,
        c.res.status,
        ms,
        c.get("requestErrorMessage"),
      ))
    }
  })
  app.use("*", cors())

  app.onError((error, c) => {
    c.set("requestErrorMessage", error.message)
    log.error("Unhandled Claude API request error", {
      method: c.req.method,
      path: c.req.path,
      requestId: c.get("requestId"),
      error,
    })
    return c.json({ error: { message: "Internal server error" } }, 500)
  })

  app.get("/", (c) =>
    c.json({
      name: "copilot-relay",
      status: "ok",
    }),
  )

  app.get("/healthz", (c) => c.json({ ok: true }))

  // Claude Code probes this before and around real traffic. Three call sites in
  // the CLI: a fire-and-forget HEAD connection warmup that reads
  // ANTHROPIC_BASE_URL and lands here, plus a connectivity diagnostic and a
  // startup preflight that currently read the first-party base URL. The
  // preflight gates on status !== 200 and exits the process on failure, so the
  // cost of answering is a static 200 and the cost of not answering is a client
  // that hard-fails if that call site is ever pointed at a configured base URL.
  //
  // Static by design, like /healthz: it must not contact Copilot upstream. It
  // proves the relay is reachable, nothing more.
  app.on(["GET", "HEAD"], "/api/hello", (c) => c.body(null, 200))

  app.route("/v1", claudeRoutes)
  app.notFound(async (c) => {
    const message = "Unsupported Claude API route"
    c.set("requestErrorMessage", message)
    log.error("Unsupported Claude API request", {
      method: c.req.method,
      path: c.req.path,
      requestId: c.get("requestId"),
      headers: getLoggedHeaders(c.req.raw),
      payload: await readRequestPayloadForLog(c.req.raw),
    })
    return c.json({ error: { message } }, 500)
  })

  return app
}

export const startServer = (config: ProxyConfig): Promise<ServerType> =>
  new Promise((resolve, reject) => {
    const server = createAdaptorServer({
      fetch: createServer(config).fetch,
      hostname: config.host,
      port: config.port,
    })

    const onError = (error: Error) => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      server.off("error", onError)
      resolve(server)
    }

    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(config.port, config.host)
  })
