// scripts/test-bootstrap.mjs keeps a test file's stdout for the result frames its runner reads back.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import v8 from "node:v8"

const execute = promisify(execFile)
const root = path.resolve(import.meta.dirname, "../..")
const bootstrap = pathToFileURL(path.join(root, "scripts/test-bootstrap.mjs")).href
const logModule = pathToFileURL(path.join(root, "src/lib/log.ts")).href

// The runner frames each result as the V8 serialization header, a 4-byte size and the serialized value.
const serializer = new v8.Serializer()
serializer.writeHeader()
const frameHeader = serializer.releaseBuffer()

// Splits a test file's stdout into its result frames and the plain text between them.
const separateFrames = (stdout: Buffer) => {
  const plainText: Array<Buffer> = []
  let frameCount = 0
  let index = 0

  while (index < stdout.length) {
    const start = stdout.indexOf(frameHeader, index)
    const end = start === -1 ? stdout.length : start
    plainText.push(stdout.subarray(index, end))

    if (start === -1) {
      break
    }

    const sizeOffset = start + frameHeader.length
    frameCount += 1
    index = sizeOffset + 4 + stdout.readUInt32BE(sizeOffset)
  }

  return { plainText: Buffer.concat(plainText).toString(), frameCount }
}

// The probe writes one line through the relay logger and one through the console.
const probeImport = `import { flushLogs, log, setLogLevel } from ${JSON.stringify(logModule)}\n`
const probeLines = [
  `setLogLevel("info")`,
  `log.info("relay logger line")`,
  `console.log("console line")`,
  `await flushLogs()`,
].join("\n")

// Runs a probe as the test runner runs a test file: with the bootstrap, tsx and NODE_TEST_CONTEXT.
const runProbe = async (name: string, source: string) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "relay-bootstrap-"))

  try {
    const file = path.join(directory, name)
    await fs.writeFile(file, source)
    return await execute(process.execPath, ["--import", bootstrap, "--import", "tsx", file], {
      cwd: root,
      env: { ...process.env, NODE_TEST_CONTEXT: "child-v8" },
      encoding: "buffer",
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

test("a test file the runner starts writes only result frames to stdout", async () => {
  const source = `${probeImport}import test from "node:test"\n\ntest("probe", async () => {\n${probeLines}\n})\n`
  const { stdout, stderr } = await runProbe("probe.test.mjs", source)
  const { plainText, frameCount } = separateFrames(stdout)

  assert.equal(plainText, "")
  assert.ok(frameCount > 0)
  assert.match(stderr.toString(), /relay logger line/)
  assert.match(stderr.toString(), /console line/)
})

test("a process a test starts keeps its stdout", async () => {
  const { stdout } = await runProbe("probe.mjs", `${probeImport}${probeLines}\n`)

  assert.match(stdout.toString(), /relay logger line/)
  assert.match(stdout.toString(), /console line/)
})
