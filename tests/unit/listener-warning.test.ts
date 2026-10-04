import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "relay-listener-warning-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome
process.env.CONSOLA_LEVEL = "0"

const { unauthenticatedListenerWarning } = await import("../../src/start")
const { paths } = await import("../../src/lib/paths")

test.after(async () => {
  await fs.rm(tempHome, { force: true, recursive: true })
})

// Why: a relay bound beyond loopback with no apiKey serves any client
// that reaches it. Startup warns rather than refusing, so an existing 0.0.0.0
// setup keeps working, and the warning names the setting that closes it.
test("warns about a listener beyond loopback without an apiKey", () => {
  for (const host of ["0.0.0.0", "::", "192.0.2.8", "relay.example"]) {
    const warning = unauthenticatedListenerWarning({ apiKey: "", host, port: 4142 })

    assert.ok(warning, host)
    assert.ok(warning.includes(`host ${host} is not a loopback address`), warning)
    assert.match(warning, /any client that can reach port 4142 can consume your Copilot usage/)
    assert.ok(warning.includes(`Set apiKey in ${paths.configPath}`), warning)
  }
})

test("stays quiet once an apiKey is set or the host is loopback", () => {
  for (const host of ["0.0.0.0", "192.0.2.8"]) {
    assert.equal(unauthenticatedListenerWarning({ apiKey: "relay-fixture-key-0001", host, port: 4142 }), undefined, host)
  }

  for (const host of ["127.0.0.1", "localhost", "::1"]) {
    assert.equal(unauthenticatedListenerWarning({ apiKey: "", host, port: 4142 }), undefined, host)
  }
})
