// HTTP server assembly: exposes only Claude Code-compatible public routes.
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { isIPv4 } from "node:net"

import { createAdaptorServer, type HttpBindings, type ServerType } from "@hono/node-server"
import { Hono } from "hono"

import { snapshotProxyConfig, type ProxyConfig, type ProxyEnv } from "~/lib/config"
import { isDebugLogging, log } from "~/lib/log"
import { snapshotRuntimeState, withRuntimeState } from "~/lib/state"
import { cleanupCapturesIfDue, getReplayRequestId, isReplayTransport, RequestTrace, withRequestTrace } from "~/lib/request-trace"
import { appVersion } from "~/lib/version"
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

// Parse an authority, not an arbitrary URL. WHATWG URL alone would also accept
// userinfo, paths, escaped hostnames and shorthand/octal IPv4 spellings.
const parseAuthority = (authority: string, protocol: string): URL | undefined => {
  if (protocol !== "http:" && protocol !== "https:") {
    return undefined
  }

  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::([0-9]+))?$/i.exec(authority)
  if (!match || (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535))) {
    return undefined
  }

  try {
    const url = new URL(`${protocol}//${authority}`)
    if (isIPv4(url.hostname) && url.hostname !== match[1]) {
      return undefined
    }

    return url
  } catch {
    return undefined
  }
}

const effectivePort = (url: URL): number => Number(url.port || (url.protocol === "https:" ? 443 : 80))

const isAllowedHostname = (hostname: string, configuredHost: string | undefined): boolean =>
  hostname === "localhost"
  || hostname === "[::1]"
  || (isIPv4(hostname) && hostname.startsWith("127."))
  || (hostname !== "0.0.0.0" && hostname !== "[::]" && hostname === configuredHost)

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest()

/**
 * True when the request carries the relay's apiKey as x-api-key or Authorization: Bearer.
 *
 * The configured key and each presented value are hashed with SHA-256, and timingSafeEqual compares
 * the fixed-length digests, so the comparison never stops at the first byte that differs. Both
 * headers are compared even after one matches.
 */
const presentsApiKey = (headers: Headers, apiKey: string): boolean => {
  const expected = sha256(apiKey)
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1]
  let matched = false
  for (const presented of [headers.get("x-api-key"), bearer]) {
    if (typeof presented === "string" && timingSafeEqual(sha256(presented), expected)) {
      matched = true
    }
  }

  return matched
}

// Static probes: they answer every caller the same way and never contact Copilot, so health
// checks and Claude Code's reachability probe work without the key. See their handlers below.
const isOpenProbe = (method: string, path: string): boolean =>
  (method === "GET" && path === "/healthz")
  || ((method === "GET" || method === "HEAD") && path === "/api/hello")

export const createServer = (config: ProxyConfig) => {
  const app = new Hono<ProxyEnv & { Bindings: Partial<HttpBindings> }>()
  // Hot reload mutates config, but cannot rebind the socket. Admission must
  // continue describing this listener until it is restarted.
  const { host, port } = config
  const configuredHost = parseAuthority(host.includes(":") && !host.startsWith("[") ? `[${host}]` : host, "http:")?.hostname

  app.use("*", async (c, next) => {
    const requestId = getReplayRequestId() ?? randomUUID()
    c.set("config", config)
    c.set("requestId", requestId)
    c.header("x-copilot-relay-request-id", requestId)
    log.info(`request_id=${requestId} request received method=${c.req.method} path=${c.req.path}`)

    const started = performance.now()
    try {
      await next()
    } finally {
      // A route can return a new Response and replace headers prepared before next().
      c.header("x-copilot-relay-request-id", requestId)
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

  // Browser-origin and local-request checks, then the optional apiKey. Without an apiKey, nothing
  // here authenticates the caller.
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url)
    // The Node adapter supplies the real socket. This also pins an ephemeral
    // listener; an unbound in-process app with port 0 has no actual port yet.
    const incoming = c.env?.incoming
    const boundPort = incoming?.socket.localPort ?? port
    const rawTarget = incoming?.url
    // An absolute-form request target names its own authority, which Host must match.
    const absoluteTarget =
      rawTarget && !rawTarget.startsWith("/") ?
        /^(https?):\/\/([^/?#]+)/i.exec(rawTarget)
      : undefined
    const authority =
      absoluteTarget ?
        parseAuthority(absoluteTarget[2], `${absoluteTarget[1].toLowerCase()}:`)
      : parseAuthority(url.host, url.protocol)
    const hostHeader = c.req.header("host")
    const headerAuthority = hostHeader === undefined ? authority : parseAuthority(hostHeader, url.protocol)
    if (!authority || !headerAuthority || url.username || url.password
      || (rawTarget !== undefined && !rawTarget.startsWith("/") && !absoluteTarget)
      || headerAuthority.origin !== authority.origin
      || !isAllowedHostname(authority.hostname, configuredHost)
      || (boundPort !== 0 && effectivePort(authority) !== boundPort)
      || (incoming && (hostHeader === undefined || url.protocol !== "http:"))) {
      const message = "Request authority is not allowed"
      c.set("requestErrorMessage", message)
      return c.json({ error: { message } }, 403)
    }

    const origin = c.req.header("origin")
    if (origin !== undefined) {
      const match = /^(https?:)\/\/([^/?#]+)$/i.exec(origin)
      const parsedOrigin = match ? parseAuthority(match[2], match[1].toLowerCase()) : undefined
      if (!parsedOrigin || parsedOrigin.origin !== authority.origin) {
        const message = "Request origin is not allowed"
        c.set("requestErrorMessage", message)
        return c.json({ error: { message } }, 403)
      }
    }

    // Read from the live config on every request, so a hot reload applies to the next one. Checked
    // before the body or any route, including the unknown-route handler that logs payloads.
    const apiKey = config.apiKey
    if (apiKey && !isOpenProbe(c.req.method, c.req.path) && !presentsApiKey(c.req.raw.headers, apiKey)) {
      // Never echo the presented value.
      const message = "Missing or invalid API key: send the relay apiKey as x-api-key or Authorization: Bearer"
      c.set("requestErrorMessage", message)
      return c.json(
        { type: "error", error: { type: "authentication_error", message } },
        401,
        { "www-authenticate": "Bearer" },
      )
    }

    // A message request that carries a body must declare it as JSON.
    if (
      c.req.method === "POST"
      && (c.req.path === "/v1/messages" || c.req.path === "/v1/messages/count_tokens")
      && (incoming
        ? Boolean(incoming.headers["transfer-encoding"]) || Number(incoming.headers["content-length"] ?? 0) > 0
        : c.req.raw.body !== null)
      && c.req.header("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    ) {
      const message = "Content-Type must be application/json"
      c.set("requestErrorMessage", message)
      return c.json({ error: { message } }, 415)
    }

    await next()
  })

  app.use("/v1/*", async (c, next) => {
    if (c.req.method !== "POST") {
      await next()
      return
    }

    if (!isReplayTransport()) {
      cleanupCapturesIfDue()
    }

    // Each request keeps the policy it was admitted with, even across a hot reload.
    const policy = snapshotProxyConfig(config)
    const runtime = snapshotRuntimeState()
    const trace = await RequestTrace.create(c.get("requestId"), c.req.raw, policy, runtime, !isReplayTransport() && isDebugLogging())
    c.set("config", policy)
    c.set("requestTrace", trace)
    c.req.raw = trace.captureRequest(c.req.raw)

    await withRuntimeState(runtime, () => withRequestTrace(trace, next))
    c.res = trace.captureResponse(c.res)
    trace.responseReady()
  })

  app.onError((error, c) => {
    c.set("requestErrorMessage", error.message)
    log.error("Unhandled Claude API request error", {
      method: c.req.method,
      path: c.req.path,
      requestId: c.get("requestId"),
      error,
    })
    c.get("requestTrace")?.recordFailure("internal-error")
    return c.json({ error: { message: `Internal server error (request_id=${c.get("requestId")})` } }, 500)
  })

  app.get("/", (c) =>
    c.json({
      name: "copilot-relay",
      status: "ok",
    }),
  )

  // `version` is the build answering this request, which is what makes it
  // worth serving here: `status` already probes /healthz, so reporting the
  // daemon's own version costs no extra round trip and no new route. See #43.
  // Still static — process-local data, never an upstream call.
  app.get("/healthz", (c) => c.json({ ok: true, version: appVersion }))

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
