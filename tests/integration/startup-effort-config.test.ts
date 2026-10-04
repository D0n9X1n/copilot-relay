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
    const originalConfig = `thinkEffort: ${effort}\nclaudeSetup: false\n`
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, originalConfig)

    // Every outgoing connection and the global fetch throw, so reaching authentication or the
    // upstream preflight shows as NETWORK_ACCESS_FORBIDDEN. Both go through the relay's upstream
    // dispatcher rather than the global fetch, so the socket is guarded too. The preflight's
    // log line is checked as well.
    const script = `
      import net from "node:net";
      const forbidden = () => {
        console.log("NETWORK_ACCESS_FORBIDDEN");
        throw new Error("NETWORK_ACCESS_FORBIDDEN");
      };
      net.Socket.prototype.connect = forbidden;
      globalThis.fetch = async () => forbidden();
      process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entry))}, "start"];
      await import(${JSON.stringify(entry.href)});
    `

    try {
      const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
        const child = execFile(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", script],
          {
            cwd,
            // Each child compiles the relay through tsx with its disk cache disabled. In full
            // local runs on Windows the first case took longer than the others and sometimes
            // reached a 10-second limit. A child that hangs still fails, after 60 seconds.
            timeout: 60_000,
            env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
          },
          (error, stdout, stderr) => {
            const code = error ? error.code : 0

            // A timeout, a signal or a spawn failure leaves no exit code to check.
            if (error?.killed || typeof code !== "number") {
              reject(error ?? new Error("Missing startup exit code"))
              return
            }

            resolve({ code, output: stripVTControlCharacters(stdout + stderr) })
          },
        )

        // The relay never reads stdin; closing it anyway means an unexpected read gets EOF at
        // once instead of hanging until the timeout.
        child.stdin?.end()
      })

      assert.equal(result.code, 1)
      assert.match(result.output, /Invalid thinkEffort/)
      assert.match(result.output, /Valid values: low, medium, high, xhigh, max/)
      assert.doesNotMatch(
        result.output,
        /NETWORK_ACCESS_FORBIDDEN|Running upstream preflight|Default think effort: none/,
      )

      // The config is untouched and no relay process started.
      assert.equal(await fs.readFile(configPath, "utf8"), originalConfig)
      await assert.rejects(
        fs.stat(path.join(home, ".copilot-relay", "copilot-relay.pid")),
        { code: "ENOENT" },
      )
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
}
