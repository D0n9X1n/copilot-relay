import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inspect } from "node:util"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const tempHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "copilot-relay-log-redact-"),
)
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const consola = (await import("consola")).default
const { log, setLogLevel } = await import("../../src/lib/log")
const { registerSensitiveOrigin } = await import("../../src/lib/redact")
const { getLogPath, paths } = await import("../../src/lib/paths")

/**
 * Captures what the console sink would render, without writing to stdout.
 *
 * Non-string arguments are inspected the way a real reporter would, so a secret
 * reaching the console inside an object is caught rather than stringified into
 * "[object Object]" and silently passing.
 */
const consoleOutput: Array<string> = []
consola.setReporters([
  {
    log: (logObject: { args: Array<unknown> }) => {
      consoleOutput.push(
        logObject.args
          .map((arg) => (typeof arg === "string" ? arg : inspect(arg)))
          .join(" "),
      )
    },
  },
])

const readActiveLog = async (): Promise<string> => {
  // File writes are fire-and-forget so logging never blocks a request.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const content = await fs.readFile(getLogPath(), "utf8").catch(() => "")
    if (content) {
      return content
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("log file was never written")
}

test.beforeEach(async () => {
  await fs.rm(paths.logsDir, { force: true, recursive: true })
  consoleOutput.length = 0
  setLogLevel("debug")
})

// Unique per test: registerSensitiveOrigin is process-lifetime and append-only,
// so sharing a host would make these depend on execution order.
let originCounter = 0
const uniqueHost = (label: string): string => {
  originCounter += 1
  return `${label}-${originCounter}.log-test.invalid`
}

// Why: #47's core claim is that both sinks are protected. A fix that redacts
// the file but not the console still puts the secret on a screen the user
// screenshots, and vice versa.
test("redacts a nested response.url in both console and file output", async () => {
  const host = uniqueHost("nested")
  registerSensitiveOrigin(`https://${host}/tenant/NESTED_SECRET`)

  log.error("Failed to create chat completions", {
    response: {
      body: "upstream boom",
      status: 500,
      url: `https://${host}/tenant/NESTED_SECRET/chat/completions`,
    },
  })

  const fileContent = await readActiveLog()
  const consoleContent = consoleOutput.join("\n")

  for (const [sink, content] of [
    ["file", fileContent],
    ["console", consoleContent],
  ] as const) {
    assert.ok(
      !content.includes("NESTED_SECRET"),
      `${sink} leaked the secret: ${content}`,
    )
    assert.ok(content.includes("[redacted]"), `${sink} missing marker`)
    // The diagnostics that make the entry worth logging survive.
    assert.ok(content.includes("500"), `${sink} lost the status`)
    assert.ok(content.includes("upstream boom"), `${sink} lost the body`)
  }
})

// Why: an Error's message and cause are rendered by a different path than a
// plain object, and a connection-refused failure carries the URL in exactly
// those fields.
test("redacts urls in an error message and its cause", async () => {
  const host = uniqueHost("errcause")
  registerSensitiveOrigin(`https://${host}/tenant/CAUSE_SECRET`)

  const cause = new Error(
    `connect ECONNREFUSED https://${host}/tenant/CAUSE_SECRET/models`,
  )
  const error = new Error(
    `request to https://${host}/tenant/CAUSE_SECRET/models failed`,
    { cause },
  )

  log.error("Startup preflight failed:", error)

  const fileContent = await readActiveLog()
  const consoleContent = consoleOutput.join("\n")

  for (const [sink, content] of [
    ["file", fileContent],
    ["console", consoleContent],
  ] as const) {
    assert.ok(
      !content.includes("CAUSE_SECRET"),
      `${sink} leaked the secret: ${content}`,
    )
    assert.ok(content.includes("[redacted]"), `${sink} missing marker`)
    assert.ok(
      content.includes("ECONNREFUSED"),
      `${sink} lost the cause diagnostic`,
    )
  }
})

// Why: redaction must not become a licence to rewrite unrelated URLs. The
// public Copilot endpoint has no registered policy and must read back exactly.
test("leaves an unregistered url untouched in both sinks", async () => {
  log.info("copilot base url: https://api.githubcopilot.com/models")

  const fileContent = await readActiveLog()
  const consoleContent = consoleOutput.join("\n")

  assert.ok(fileContent.includes("https://api.githubcopilot.com/models"))
  assert.ok(consoleContent.includes("https://api.githubcopilot.com/models"))
  assert.ok(!fileContent.includes("[redacted]"))
})

// Why: the 9.3 GB lesson. Redaction runs on the same path that renders payloads
// and must not reintroduce multi-line dumps, which would break every grep
// recipe in docs/logging.md. See CLAUDE.md.
test("keeps one entry on one physical line while redacting", async () => {
  const host = uniqueHost("oneline")
  registerSensitiveOrigin(`https://${host}/tenant/LINE_SECRET`)

  log.error("Failed to create responses", {
    request: {
      messages: [{ content: "hello", role: "user" }],
      model: "gpt-5.6-sol",
      tools: [{ function: { name: "Read", parameters: { type: "object" } } }],
    },
    response: {
      body: { error: { message: "bad request" } },
      status: 400,
      url: `https://${host}/tenant/LINE_SECRET/responses`,
    },
  })

  const content = await readActiveLog()
  const lines = content.trimEnd().split("\n")

  assert.equal(lines.length, 1)
  assert.ok(!lines[0].includes("LINE_SECRET"))
  assert.ok(lines[0].includes("[redacted]"))
  assert.match(lines[0], /status: 400/)
})

// Why: the disk gate is a separate decision from the console one. Redacting
// must not accidentally start writing debug entries at info level.
test("still honours the disk level gate", async () => {
  setLogLevel("error")
  log.debug("debug entry that must not reach disk")
  log.error("error entry that must reach disk")

  const content = await readActiveLog()
  assert.ok(content.includes("error entry that must reach disk"))
  assert.ok(!content.includes("debug entry that must not reach disk"))
})
