// HTTP server assembly: exposes only Claude Code-compatible public routes.
import { serve } from "@hono/node-server"
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
  method: string,
  path: string,
  status: number,
  ms: number,
  errorMessage: string | undefined,
): string => {
  const base = `${method} ${path} -> ${status} ${ms}ms`
  return status >= 400 && errorMessage ? `${base} error=${JSON.stringify(errorMessage)}` : base
}

export const createServer = (config: ProxyConfig) => {
  const app = new Hono<ProxyEnv>()

  app.use("*", cors())
  app.use("*", async (c, next) => {
    c.set("config", config)
    const started = performance.now()
    try {
      await next()
    } finally {
      const ms = Math.round(performance.now() - started)
      // Emit exactly one info-level request summary even when downstream route
      // handling throws; deeper diagnostics belong to debug/error logs.
      log.info(formatStatusLog(
        c.req.method,
        c.req.path,
        c.res.status,
        ms,
        c.get("requestErrorMessage"),
      ))
    }
  })

  app.onError((error, c) => {
    c.set("requestErrorMessage", error.message)
    return c.json({ error: { message: "Internal server error" } }, 500)
  })

  app.get("/", (c) =>
    c.json({
      name: "copilot-relay",
      status: "ok",
    }),
  )

  app.get("/healthz", (c) => c.json({ ok: true }))
  app.route("/v1", claudeRoutes)
  app.notFound(async (c) => {
    const message = "Unknown Claude API route"
    c.set("requestErrorMessage", message)
    log.error("Unknown Claude API request", {
      method: c.req.method,
      path: c.req.path,
      headers: getLoggedHeaders(c.req.raw),
      payload: await readRequestPayloadForLog(c.req.raw),
    })
    return c.json({ error: { message } }, 404)
  })

  return app
}

export const startServer = (config: ProxyConfig) =>
  serve({
    fetch: createServer(config).fetch,
    hostname: config.host,
    port: config.port,
  })
