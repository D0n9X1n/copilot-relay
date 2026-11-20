// Runs in a child started with --expose-gc. Logs one entry inside a request-like async context, lets
// the write finish and the idle-close timer start, then prints whether that context's store is still
// reachable while the timer is pending.
import fs from "node:fs/promises"
import { AsyncLocalStorage } from "node:async_hooks"
import os from "node:os"
import path from "node:path"

// src/lib/paths reads the home directory on import, so redirect HOME and USERPROFILE (Windows) first.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-log-context-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { log } = await import("../../src/lib/log")

const gc = (globalThis as { gc?: () => void }).gc
if (gc === undefined) {
  throw new Error("Run with --expose-gc.")
}

const storage = new AsyncLocalStorage<object>()
// Only a WeakRef to the store outlives the function that logs inside it.
const logInside = async (): Promise<WeakRef<object>> => {
  const store = { request: "finished" }
  await storage.run(store, async () => {
    log.info("log-context-heap-marker")
  })
  return new WeakRef(store)
}

const reference = await logInside()

// The drain writes the entry, then arms the one-second idle close; sample well inside that second.
await new Promise((resolve) => setTimeout(resolve, 200))
for (let round = 0; round < 10; round++) {
  await new Promise((resolve) => setTimeout(resolve, 10))
  gc()
}

process.stdout.write(`${JSON.stringify({ storeReachable: reference.deref() !== undefined })}\n`)
await fs.rm(home, { recursive: true, force: true })
process.exit(0)
