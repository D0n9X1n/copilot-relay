import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { stripVTControlCharacters } from "node:util"

const entry = new URL("../../src/main.ts", import.meta.url)
const cwd = fileURLToPath(new URL("../../", import.meta.url))

for (const effort of ["none", "NONE", "ultra", "\"\""]) {
  test(`start rejects thinkEffort=${effort} before auth or config write-back`, async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-start-effort-"))
    const configPath = path.join(home, ".copilot-relay", "config.yaml")
    const original = `thinkEffort: ${effort}\nclaudeSetup: false\n`
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, original)
    const script = `
      globalThis.fetch = async () => { throw new Error("NETWORK_ACCESS_FORBIDDEN"); };
      process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entry))}, "start"];
      await import(${JSON.stringify(entry.href)});
    `
    try {
      const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
        const child = execFile(process.execPath, [
          "--import", "tsx", "--input-type=module", "--eval", script,
        ], {
          cwd, timeout: 10_000,
          env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
        }, (error, stdout, stderr) => {
          const code = error ? error.code : 0
          if (error?.killed || typeof code !== "number") {
            reject(error ?? new Error("Missing startup exit code"))
            return
          }
          resolve({ code, output: stripVTControlCharacters(stdout + stderr) })
        })
        child.stdin?.end()
      })
      assert.equal(result.code, 1)
      assert.match(result.output, /Invalid thinkEffort/)
      assert.match(result.output, /Valid values: low, medium, high, xhigh, max/)
      assert.doesNotMatch(result.output, /NETWORK_ACCESS_FORBIDDEN|Running upstream preflight|Default think effort: none/)
      assert.equal(await fs.readFile(configPath, "utf8"), original)
      await assert.rejects(fs.stat(path.join(home, ".copilot-relay", "copilot-relay.pid")), { code: "ENOENT" })
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
}
