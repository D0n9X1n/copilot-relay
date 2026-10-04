import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-client-test-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { fetchCopilot } = await import("../../src/copilot/client")
const { flushLogs } = await import("../../src/lib/log")

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

// An upstream that counts the TCP connections it accepts. Like Copilot, it sends no Keep-Alive
// hint, and it never closes an idle connection itself, so only the relay's client can close one.
const countingUpstream = async () => {
  let connections = 0
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" })
    response.end("{}")
  })
  server.keepAliveTimeout = 0
  server.on("connection", () => {
    connections++
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address === "object")

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    connections: () => connections,
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

const get = async (baseUrl: string): Promise<void> => {
  const response = await fetchCopilot({ baseUrl, token: "test-token", vsCodeVersion: "1.99.3" }, "/models", { method: "GET" })
  await response.text()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// undici 7.28 held each request on a reused idle connection for an unref'd setTimeout(0). On
// Windows that lasts until the next system timer tick unless other I/O wakes the event loop.
test("a request on a reused idle upstream connection does not wait for a zero-delay timer", async (t) => {
  const upstream = await countingUpstream()
  t.after(() => upstream.close())

  await get(upstream.baseUrl)
  await sleep(100)

  const original = globalThis.setTimeout
  const delays: Array<number | undefined> = []
  const recording = ((callback: (...args: Array<unknown>) => void, delay?: number, ...args: Array<unknown>) => {
    delays.push(delay)
    return original(callback, delay, ...args)
  }) as typeof setTimeout
  t.mock.method(globalThis, "setTimeout", recording)

  await get(upstream.baseUrl)
  t.mock.restoreAll()

  assert.equal(upstream.connections(), 1, "the second request must reuse the idle connection")
  assert.deepEqual(delays.filter((delay) => !delay), [])
})

// Copilot sends no Keep-Alive hint, so undici's 4 s default closed every upstream connection idle
// for longer, and the next request paid for a new TCP and TLS handshake.
test("an upstream connection idle for longer than undici's 4 s default is reused", async (t) => {
  const upstream = await countingUpstream()
  t.after(() => upstream.close())

  await get(upstream.baseUrl)
  await sleep(5_500)
  await get(upstream.baseUrl)

  assert.equal(upstream.connections(), 1)
})
