// Stand-ins that keep tests off the network: GitHub answered locally, no socket that leaves this
// machine, proxy variables under the test's control, and a local proxy that records what it is sent.
//
// The relay sends GitHub calls through the same undici dispatcher as Copilot calls (#153), so a
// test can neither replace the global fetch to fake GitHub nor let a call reach github.com.
import { createServer, request as forward, type IncomingMessage, type ServerResponse } from "node:http"
import net from "node:net"
import type { Duplex } from "node:stream"

import { Agent, type Dispatcher } from "undici"

const githubHosts = new Set(["api.github.com", "github.com"])

export interface RedirectedCall {
  /** The Agent whose dispatch carried the call; for a direct route, the dispatcher itself. */
  dispatcher: Agent
  method: string
  url: string
}

export interface GitHubRedirect {
  calls: Array<RedirectedCall>
  restore: () => void
}

/**
 * Sends every request for github.com or api.github.com to `target`, a plain-HTTP origin, with the
 * real host as the first path segment.
 *
 * It patches undici's Agent rather than installing one dispatcher, because each command builds its
 * own dispatcher from its config after it starts. Every Agent the relay builds, the one inside a
 * ProxyAgent included, goes through it. `fail` makes a call fail without a response, as a dropped
 * connection would.
 */
export const redirectGitHubTo = (
  target: string,
  fail?: (url: URL) => Error | undefined,
): GitHubRedirect => {
  const prototype = Agent.prototype
  const hadOwnDispatch = Object.hasOwn(prototype, "dispatch")
  const original = prototype.dispatch
  const targetOrigin = new URL(target).origin
  const calls: Array<RedirectedCall> = []

  prototype.dispatch = function (
    this: Agent,
    options: Agent.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const origin = options.origin === undefined ? undefined : new URL(String(options.origin))
    if (origin === undefined || !githubHosts.has(origin.hostname)) {
      return original.call(this, options, handler)
    }

    const url = new URL(options.path, origin)
    calls.push({ dispatcher: this, method: options.method, url: url.href })

    const failure = fail?.(url)
    if (failure !== undefined) {
      throw failure
    }

    return original.call(
      this,
      { ...options, origin: targetOrigin, path: `/${url.host}${url.pathname}${url.search}` },
      handler,
    )
  }

  return {
    calls,
    restore: () => {
      if (hadOwnDispatch) {
        prototype.dispatch = original
      } else {
        delete (prototype as Partial<Agent>).dispatch
      }
    },
  }
}

export type FakeGitHubHandler = (
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>

export interface FakeGitHub {
  close: () => Promise<void>
  /** The plain-HTTP origin to pass to redirectGitHubTo. */
  origin: string
  /** Every request received, as "METHOD https://host/path". */
  requests: Array<string>
}

/**
 * A plain-HTTP stand-in for GitHub behind redirectGitHubTo. The handler sees the original GitHub
 * URL. A handler that throws drops the connection, which the relay sees as a network error.
 */
export const startFakeGitHub = async (handle: FakeGitHubHandler): Promise<FakeGitHub> => {
  const requests: Array<string> = []
  const server = createServer(async (request, response) => {
    try {
      const [, host = "", ...segments] = (request.url ?? "/").split("/")
      const url = new URL(`https://${host}/${segments.join("/")}`)
      requests.push(`${request.method} ${url.href}`)
      await handle(url, request, response)
    } catch {
      response.destroy()
    }
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address !== "object") {
    throw new Error("The fake GitHub server did not bind a port")
  }

  return {
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    origin: `http://127.0.0.1:${address.port}`,
    requests,
  }
}

export const replyJson = (response: ServerResponse, payload: unknown, status = 200): void => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(payload))
}

/** Writes a fetch Response to a node:http response. */
export const replyWith = async (response: ServerResponse, reply: Response): Promise<void> => {
  const body = Buffer.from(await reply.arrayBuffer())
  response.writeHead(reply.status, Object.fromEntries(reply.headers.entries()))
  response.end(body)
}

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"])

// The host net.Socket#connect was asked for, across the argument forms net.connect and tls.connect
// use. No host means localhost, and a path is a local pipe.
const connectHost = (args: Array<unknown>): string => {
  const [first, second] = args
  const options: unknown = Array.isArray(first) ? first[0] : first

  if (typeof options === "object" && options !== null) {
    const { host, path } = options as { host?: unknown; path?: unknown }
    if (typeof path === "string") {
      return "localhost"
    }

    return typeof host === "string" ? host : "localhost"
  }

  return typeof second === "string" ? second : "localhost"
}

/**
 * Makes every socket connection to a host other than this machine throw, so a test whose stand-in
 * was bypassed fails instead of reaching GitHub or Copilot. TLS is covered too: tls.connect
 * connects through net.Socket#connect. Returns the function that removes the guard.
 */
export const refuseExternalConnections = (): (() => void) => {
  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function (this: net.Socket, ...args: Array<unknown>) {
    const host = connectHost(args)
    if (!loopbackHosts.has(host)) {
      throw new Error(`UNEXPECTED_NETWORK_ACCESS: ${host}`)
    }

    return Reflect.apply(connect, this, args)
  } as typeof connect

  return () => {
    net.Socket.prototype.connect = connect
  }
}

const proxyVariableNames = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"]

/**
 * Runs `run` with exactly the given proxy variables set, and restores the environment after.
 *
 * Every spelling is cleared first, so a developer's own proxy settings cannot leak in. On Windows
 * the upper and lower case names are one variable, which restoring both still handles.
 */
export const withProxyEnvironment = async <T>(
  values: Record<string, string>,
  run: () => T | Promise<T>,
): Promise<T> => {
  const saved = proxyVariableNames.map((name) => [name, process.env[name]] as const)

  for (const name of proxyVariableNames) {
    delete process.env[name]
  }

  Object.assign(process.env, values)

  try {
    return await run()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = value
      }
    }
  }
}

/** A copy of `env` without proxy variables, for a child process whose network a test controls. */
export const withoutProxyVariables = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !/^(?:https?|no|all)_proxy$/i.test(name)))

/** A loopback port with nothing listening on it, so a connection to it is refused. */
export const closedPort = async (): Promise<number> => {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address !== "object") {
    throw new Error("The probe server did not bind a port")
  }

  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

export interface ProxyRecord {
  authorization: string | undefined
  method: string | undefined
  target: string | undefined
}

export interface RecordingProxy {
  close: () => Promise<void>
  /** Every request received: a CONNECT with its host:port target, or an absolute-form URL. */
  records: Array<ProxyRecord>
  url: string
}

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/**
 * A forward proxy that records every request it receives, in both forms a client may send: CONNECT
 * for a tunnel, which undici uses, and an absolute-form URL. It relays only to this machine and
 * answers 403 for any other host, so a call routed through it never reaches GitHub or Copilot.
 * With refuseAll it answers 403 to every request, one for this machine included.
 */
export const startRecordingProxy = async (options: { refuseAll?: boolean } = {}): Promise<RecordingProxy> => {
  const records: Array<ProxyRecord> = []
  const tunnels = new Set<Duplex>()
  const server = createServer((request, response) => {
    records.push({
      authorization: request.headers["proxy-authorization"],
      method: request.method,
      target: request.url,
    })
    const target = parseUrl(request.url ?? "")
    if (
      options.refuseAll === true
      || target === undefined
      || target.protocol !== "http:"
      || !loopbackHosts.has(target.hostname)
    ) {
      response.writeHead(403)
      response.end()
      return
    }

    const headers = { ...request.headers }
    delete headers["proxy-authorization"]
    const upstream = forward(target, { headers, method: request.method }, (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers)
      reply.pipe(response)
    })
    upstream.on("error", () => response.destroy())
    request.pipe(upstream)
  })

  server.on("connect", (request, socket, head) => {
    records.push({
      authorization: request.headers["proxy-authorization"],
      method: request.method,
      target: request.url,
    })
    socket.on("error", () => socket.destroy())
    const target = parseUrl(`http://${request.url ?? ""}`)
    if (options.refuseAll === true || target === undefined || !loopbackHosts.has(target.hostname)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
      return
    }

    const upstream = net.connect(Number(target.port), target.hostname, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    tunnels.add(socket)
    upstream.on("error", () => socket.destroy())
    socket.on("close", () => {
      tunnels.delete(socket)
      upstream.destroy()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address !== "object") {
    throw new Error("The recording proxy did not bind a port")
  }

  return {
    close: async () => {
      for (const socket of tunnels) {
        socket.destroy()
      }

      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    records,
    url: `http://127.0.0.1:${address.port}`,
  }
}

export interface EchoingProxy {
  close: () => Promise<void>
  /** The host:port target of each CONNECT received. */
  targets: Array<string>
  url: string
}

/**
 * A proxy that answers every CONNECT with a reply undici cannot parse, which echoes the
 * Proxy-Authorization value it received and the password inside it. undici keeps the unparsed
 * rest of such a reply in the error it throws, so a test can check that none of it is logged.
 */
export const startEchoingProxy = async (): Promise<EchoingProxy> => {
  const targets: Array<string> = []
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => socket.destroy())

    let received = ""
    socket.on("data", (chunk) => {
      received += String(chunk)
      if (!received.includes("\r\n\r\n")) {
        return
      }

      targets.push(/^CONNECT (\S+)/.exec(received)?.[1] ?? "")
      const basic = /^proxy-authorization: Basic (\S+)/im.exec(received)?.[1] ?? ""
      const decoded = Buffer.from(basic, "base64").toString()
      const password = decoded.slice(decoded.indexOf(":") + 1)
      received = ""
      socket.end(`HTTP/1.1 200 Connection Established\r\nEcho ${basic} ${password}: x\r\n\r\n`)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address !== "object") {
    throw new Error("The echoing proxy did not bind a port")
  }

  return {
    close: async () => {
      for (const socket of sockets) {
        socket.destroy()
      }

      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
    targets,
    url: `http://127.0.0.1:${address.port}`,
  }
}
