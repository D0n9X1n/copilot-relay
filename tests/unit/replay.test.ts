import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-replay-unit-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"
const { replayCapture } = await import("../../src/replay")
const { RequestTrace } = await import("../../src/lib/request-trace")
const { createServer } = await import("../../src/server")
const { withoutLogging, flushLogs } = await import("../../src/lib/log")
type CaptureManifest = import("../../src/lib/request-trace").CaptureManifest
let sequence = 0

const fixture = async () => {
  const id = `10000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
  const config = { host: "localhost", port: 0, copilotBaseUrl: "https://fixture.invalid", copilotToken: "fixture-token", upstreamTimeoutMs: 1000, vsCodeVersion: "test" }
  const request = new Request("http://localhost/v1/messages/count_tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "opus", messages: [{ role: "user", content: "PRIVATE_PROMPT" }] }) })
  const trace = await withoutLogging(() => RequestTrace.create(id, request, config, {}, true))
  await withoutLogging(async () => {
    const response = await createServer(config).fetch(trace.captureRequest(request))
    await trace.captureResponse(response).arrayBuffer()
    trace.handlerSettled()
    await trace.finished
  })
  const directory = trace.captureDirectory!
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "meta.json"), "utf8")) as CaptureManifest
  const save = async () => fs.writeFile(path.join(directory, "meta.json"), JSON.stringify(manifest))
  return { id, directory, manifest, save }
}

test.after(async () => { await flushLogs(); await fs.rm(home, { recursive: true, force: true }) })

test("request IDs resolve only the private captures date tree", async () => {
  const f = await fixture()
  assert.equal((await replayCapture(f.id)).verdict, "MATCH")
})

for (const [name, mutate] of [
  ["unsupported format", (m: CaptureManifest) => { (m as unknown as { format: number }).format = 999 }],
  ["unsafe request path", (m: CaptureManifest) => { m.path = "//PRIVATE_HOST/v1/messages" }],
  ["path traversal", (m: CaptureManifest) => { m.request.file = "../client-request.bin" }],
  ["unexpected basename", (m: CaptureManifest) => { m.request.file = "copilot_token.json" }],
  ["wrong byte count", (m: CaptureManifest) => { m.request.bytes++ }],
  ["wrong chunk total", (m: CaptureManifest) => { m.request.chunks = [1] }],
  ["negative chunk", (m: CaptureManifest) => { m.request.chunks = [-1, m.request.bytes + 1] }],
  ["invalid policy", (m: CaptureManifest) => { m.config.upstreamTimeoutMs = -1 }],
  ["invalid routing", (m: CaptureManifest) => { m.runtime.modelRouting = { gptModel: "", opusModel: "opus" } }],
  ["invalid catalog", (m: CaptureManifest) => { m.runtime.models = [["bad", { limits: { max_output_tokens: -1 } }]] }],
] as const) {
  test(`rejects ${name} before handling a request`, async () => {
    const f = await fixture()
    mutate(f.manifest)
    await f.save()
    const result = await replayCapture(f.directory)
    assert.equal(result.verdict, "MALFORMED")
    assert.equal(result.exitCode, 1)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT|PRIVATE_HOST/)
  })
}

for (const item of ["meta.json", "client-request.bin", "directory"] as const) {
  test(`rejects symlinked ${item}`, async (t) => {
    const f = await fixture()
    const original = item === "directory" ? f.directory : path.join(f.directory, item)
    const destination = `${original}.real`
    await fs.rename(original, destination)
    try { await fs.symlink(destination, original, item === "directory" ? "junction" : "file") }
    catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { t.skip("File symlinks require Windows developer mode"); return }
      throw error
    }
    assert.equal((await replayCapture(f.directory)).verdict, "MALFORMED")
  })
}

for (const state of ["pending", "cancelled", "error"] as const) {
  test(`complete-labelled captures with ${state} bodies are INCOMPLETE`, async () => {
    const f = await fixture()
    f.manifest.request.state = state
    await f.save()
    const result = await replayCapture(f.directory)
    assert.equal(result.verdict, "INCOMPLETE")
    assert.equal(result.exitCode, 2)
  })
}

test("rejects a symlinked parent between a capture root and its directory", async () => {
  const f = await fixture()
  const alias = path.join(home, "date-alias")
  await fs.symlink(path.dirname(f.directory), alias, "junction")
  assert.equal((await replayCapture(path.join(alias, path.basename(f.directory)))).verdict, "MALFORMED")
})

test("declared incomplete captures report INCOMPLETE even when chunk totals were truncated", async () => {
  const f = await fixture()
  f.manifest.captureState = "incomplete"
  f.manifest.captureError = "capture_queue_limit"
  f.manifest.request.chunks = []
  await f.save()
  assert.equal((await replayCapture(f.directory)).verdict, "INCOMPLETE")
})

test("an invalid manifest is malformed rather than a missing capture", async () => {
  const directory = await fs.mkdtemp(path.join(home, "malformed-"))
  await fs.writeFile(path.join(directory, "meta.json"), "PRIVATE_INVALID_JSON")
  const result = await replayCapture(directory)
  assert.equal(result.verdict, "MALFORMED")
  assert.equal(result.exitCode, 1)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INVALID_JSON/)
})

test("missing captures return an exit-1 result without exposing the target", async () => {
  const result = await replayCapture(path.join(home, "PRIVATE_CAPTURE_NAME"))
  assert.equal(result.verdict, "MISSING")
  assert.equal(result.exitCode, 1)
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CAPTURE_NAME/)
})
