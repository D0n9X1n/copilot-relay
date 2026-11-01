import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

// Why: undici takes a noticeable share of CLI startup, and stop, cache, setup, --help and the
// shell completion run on every TAB make no HTTP call. Loading every command module must leave it
// unloaded until a command actually sends a request.
test("loading every CLI command does not load undici", () => {
  const script = `
    import { createRequire } from "node:module"
    const commands = ["auth", "cache", "completion", "models", "replay", "restart", "setup", "start", "status", "stop", "usage"]
    for (const command of commands) {
      await import("./src/" + command + ".ts")
    }

    const require = createRequire(import.meta.url)
    const undiciEntry = require.resolve("undici")
    console.log(JSON.stringify(Object.keys(require.cache).filter((file) => file.startsWith(undiciEntry.slice(0, undiciEntry.lastIndexOf("undici") + 6)))))
  `
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: new URL("../..", import.meta.url),
    encoding: "utf8",
    env: { ...process.env, CONSOLA_LEVEL: "0" },
  })

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1)!), [])
})
