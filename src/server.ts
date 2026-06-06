import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { cors } from "hono/cors"

import type { ProxyConfig, ProxyEnv } from "~/lib/config"
import { log } from "~/lib/log"
import { claudeRoutes } from "~/routes/claude"

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
      log.info(`${c.req.method} ${c.req.path} -> ${c.res.status} ${ms}ms`)
    }
  })

  app.onError((error, c) => {
    log.error(`${c.req.method} ${c.req.path} failed`, error)
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

  return app
}

export const startServer = (config: ProxyConfig) =>
  serve({
    fetch: createServer(config).fetch,
    hostname: config.host,
    port: config.port,
  })
