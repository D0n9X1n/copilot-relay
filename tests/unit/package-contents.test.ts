import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const root = fileURLToPath(new URL("../../", import.meta.url))

// npm always packs package.json, README and LICENSE; the `files` allowlist in
// package.json adds config.default.yaml and dist/. Repository media such as the
// README's introduction video under .github/assets must never be published.
const allowedTopLevel = new Set(["package.json", "README.md", "LICENSE", "config.default.yaml"])

test("npm package contains only the manifest, docs, default config and build output", { timeout: 60_000 }, async () => {
  // Run npm's CLI script through Node: on Windows, execFile cannot launch the npm.cmd shim.
  const npmCLI = process.env.npm_execpath ?? (process.platform === "win32"
    ? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : undefined)
  const args = ["pack", "--dry-run", "--ignore-scripts", "--json"]
  const { stdout } = await execute(npmCLI ? process.execPath : "npm", npmCLI ? [npmCLI, ...args] : args, { cwd: root, timeout: 30_000 })
  const [{ files }] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>
  const packed = files.map(file => file.path.replaceAll("\\", "/"))

  assert(packed.includes("package.json"))
  for (const file of packed) {
    assert(allowedTopLevel.has(file) || file.startsWith("dist/"), `unexpected file in the npm package: ${file}`)
    assert.doesNotMatch(file, /\.(mp4|mov|webm|gif|png|jpe?g)$/i, `media file in the npm package: ${file}`)
  }
})
