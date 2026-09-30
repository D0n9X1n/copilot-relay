import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const source = new URL("../../src/lib/version.ts", import.meta.url)
const bootstrap = new URL("../../scripts/test-bootstrap.mjs", import.meta.url).href
const tsx = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href

test("version lookup supports scoped package manifests in both source and bundled layouts", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "relay-version-"))
  try {
    for (const name of ["@owner/copilot-relay", "copilot-relay"]) {
      for (const layout of ["src/lib/version.ts", "dist/main.ts"]) {
        const directory = await fs.mkdtemp(path.join(fixture, "package-"))
        const entry = path.join(directory, layout)
        await fs.mkdir(path.dirname(entry), { recursive: true })
        await fs.copyFile(source, entry)
        await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({
          name, version: "4.5.6-rc.1", type: "module",
        }))
        const { stdout } = await execute(process.execPath, [
          "--import", bootstrap, "--import", tsx, "--input-type=module", "--eval",
          `import { appVersion } from ${JSON.stringify(pathToFileURL(entry).href)}; console.log(appVersion)`,
        ])
        assert.equal(stdout.trim(), "4.5.6-rc.1", `${name} at ${layout}`)
      }
    }
  } finally {
    await fs.rm(fixture, { recursive: true, force: true })
  }
})
