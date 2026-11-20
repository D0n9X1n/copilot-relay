import assert from "node:assert/strict"
import type { PathLike } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
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

// Captures a count_tokens request served by the real relay; `save` writes back
// a manifest that a test has changed.
const fixture = async () => {
  const id = `10000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`
  const config = { host: "localhost", port: 0, copilotBaseUrl: "https://fixture.invalid", copilotToken: "fixture-token", upstreamTimeoutMs: 1000, vsCodeVersion: "test" }
  const request = new Request("http://localhost/v1/messages/count_tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "opus", messages: [{ role: "user", content: "PRIVATE_PROMPT" }] }),
  })
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

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

test("request IDs resolve only the private captures date tree", async () => {
  const capture = await fixture()
  assert.equal((await replayCapture(capture.id)).verdict, "MATCH")
})

// On Windows, Node 22.13.1 reports dev 0 for a path stat and the volume serial number for a stat
// of the open handle, for the same file. Every path stat is made to look like that, whatever Node
// runs the test.
test("a capture written and replayed while path stats report dev 0 on Windows matches", { skip: process.platform !== "win32" }, async (t) => {
  const lstat = fs.lstat
  t.mock.method(fs, "lstat", async (target: PathLike) => {
    const stat = await lstat(target)
    stat.dev = 0
    return stat
  })

  const capture = await fixture()
  assert.equal((await replayCapture(capture.id)).verdict, "MATCH")
})

for (const [name, mutate] of [
  ["unsupported format", (manifest: CaptureManifest) => {
    (manifest as unknown as { format: number }).format = 999
  }],
  ["unsafe request path", (manifest: CaptureManifest) => {
    manifest.path = "//PRIVATE_HOST/v1/messages"
  }],
  ["path traversal", (manifest: CaptureManifest) => {
    manifest.request.file = "../client-request.bin"
  }],
  ["unexpected basename", (manifest: CaptureManifest) => {
    manifest.request.file = "copilot_token.json"
  }],
  ["wrong byte count", (manifest: CaptureManifest) => {
    manifest.request.bytes++
  }],
  ["wrong chunk total", (manifest: CaptureManifest) => {
    manifest.request.chunks = [1]
  }],
  ["negative chunk", (manifest: CaptureManifest) => {
    manifest.request.chunks = [-1, manifest.request.bytes + 1]
  }],
  ["invalid policy", (manifest: CaptureManifest) => {
    manifest.config.upstreamTimeoutMs = -1
  }],
  ["invalid routing", (manifest: CaptureManifest) => {
    manifest.runtime.modelRouting = { gptModel: "", opusModel: "opus" }
  }],
  ["invalid catalog", (manifest: CaptureManifest) => {
    manifest.runtime.models = [["bad", { limits: { max_output_tokens: -1 } }]]
  }],
] as const) {
  test(`rejects ${name} before handling a request`, async () => {
    const capture = await fixture()
    mutate(capture.manifest)
    await capture.save()

    const result = await replayCapture(capture.directory)

    assert.equal(result.verdict, "MALFORMED")
    assert.equal(result.exitCode, 1)
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PROMPT|PRIVATE_HOST/)
  })
}

for (const item of ["meta.json", "client-request.bin", "directory"] as const) {
  test(`rejects symlinked ${item}`, async (t) => {
    const capture = await fixture()
    const original = item === "directory" ? capture.directory : path.join(capture.directory, item)
    const destination = `${original}.real`
    await fs.rename(original, destination)
    try {
      await fs.symlink(destination, original, item === "directory" ? "junction" : "file")
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        t.skip("File symlinks require Windows developer mode")
        return
      }

      throw error
    }

    assert.equal((await replayCapture(capture.directory)).verdict, "MALFORMED")
  })
}

for (const state of ["pending", "cancelled", "error"] as const) {
  test(`complete-labelled captures with ${state} bodies are INCOMPLETE`, async () => {
    const capture = await fixture()
    capture.manifest.request.state = state
    await capture.save()

    const result = await replayCapture(capture.directory)

    assert.equal(result.verdict, "INCOMPLETE")
    assert.equal(result.exitCode, 2)
  })
}

test("rejects a symlinked parent between a capture root and its directory", async () => {
  const capture = await fixture()
  const alias = path.join(home, "date-alias")
  await fs.symlink(path.dirname(capture.directory), alias, "junction")

  assert.equal((await replayCapture(path.join(alias, path.basename(capture.directory)))).verdict, "MALFORMED")
})

test("declared incomplete captures report INCOMPLETE even when chunk totals were truncated", async () => {
  const capture = await fixture()
  capture.manifest.captureState = "incomplete"
  capture.manifest.captureError = "capture_queue_limit"
  capture.manifest.request.chunks = []
  await capture.save()

  assert.equal((await replayCapture(capture.directory)).verdict, "INCOMPLETE")
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
