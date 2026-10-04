import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { inspect } from "node:util"

import { withProxyEnvironment } from "../fixtures/network"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const tempHome = await fs.mkdtemp(
  path.join(os.tmpdir(), "copilot-relay-log-redact-"),
)
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const consola = (await import("consola")).default
const {
  log,
  setLogLevel,
  withoutLogging,
  flushLogs,
  registerLogSecret
} = await import("../../src/lib/log")
const { registerSensitiveOrigin } = await import("../../src/lib/redact")
const { getLogPath, paths } = await import("../../src/lib/paths")
const { readAppConfig } = await import("../../src/lib/app-config")
const { parseCompletionLine } = await import("../../src/lib/cache-report")
const { configureUpstreamDispatcher } = await import("../../src/lib/upstream-dispatcher")

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
  await flushLogs()
  await fs.rm(paths.logsDir, { force: true, recursive: true })
  consoleOutput.length = 0
  setLogLevel("debug")
})

// Suppression follows the async scope: it is still open when the outside entry
// logs, and it ends by throwing, after which logging must be back to normal.
test("diagnostic suppression covers both sinks and restores normal async logging", async () => {
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const quiet = withoutLogging(async () => {
    log.error("PRIVATE_DIAGNOSTIC_ERROR")
    await waiting
    log.info("PRIVATE_DIAGNOSTIC_INFO")
    throw new Error("expected failure")
  })

  log.error("visible outside diagnostic")
  release()
  await assert.rejects(quiet, /expected failure/)
  log.error("visible after diagnostic")

  const file = await readActiveLog()
  assert.doesNotMatch(file + consoleOutput.join("\n"), /PRIVATE_DIAGNOSTIC/)
  assert.match(consoleOutput.join("\n"), /visible outside diagnostic/)
  assert.match(consoleOutput.join("\n"), /visible after diagnostic/)
})

// Unique per test: registerSensitiveOrigin is process-lifetime and append-only,
// so sharing a host would make these depend on execution order.
let originCounter = 0
const uniqueHost = (label: string): string => {
  originCounter += 1
  return `${label}-${originCounter}.log-test.invalid`
}

// Why: both sinks must be protected. A fix that redacts
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
// recipe in wiki/EN-Logging-Troubleshooting.md. See CLAUDE.md.
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

// Raw line separators delimit adjacent URLs. Escaping first turns them into
// path characters on the public URL and can hide the sensitive origin from the
// scrubber. Both sinks must receive the same redacted, then single-line value.
for (const [name, separator, escaped] of [
  ["LF", "\n", "\\n"],
  ["CRLF", "\r\n", "\\r\\n"],
  ["CR", "\r", "\\r"],
  ["U+2028", String.fromCodePoint(0x2028), "\\u2028"],
  ["U+2029", String.fromCodePoint(0x2029), "\\u2029"],
] as const) {
  for (const kind of ["string", "Error stack"] as const) {
    test(`redacts adjacent ${name} URLs from ${kind} before escaping both sinks`, async () => {
      const origin = `https://${uniqueHost("adjacent")}`
      const publicUrl = "https://public.fixture.invalid/"
      const secretUrl = `${origin}/PRIVATE_SENTINEL`
      registerSensitiveOrigin(secretUrl)
      const text = `${publicUrl}${separator}${secretUrl}`
      let value: string | Error = text
      if (kind === "Error stack") {
        value = new Error("adjacent URLs")
        value.stack = `Error: adjacent URLs ${text}`
      }

      log.error("Adjacent URLs", value)
      await flushLogs()

      const fileContent = await fs.readFile(getLogPath(), "utf8")
      assert.ok(fileContent.endsWith("\n"))
      assert.equal(consoleOutput.length, 1)

      const fileValue = fileContent.slice(0, -1).replace(/^\S+ error /, "")
      assert.equal(fileValue, consoleOutput[0], "both sinks must receive identical final text")

      for (const [sink, content] of [["file", fileValue], ["console", consoleOutput[0]]]) {
        assert.ok(!content.includes("PRIVATE_SENTINEL"), `${sink} leaked the adjacent URL secret`)
        assert.ok(
          content.includes(`${publicUrl}${escaped}${origin}[redacted]`),
          `${sink} lost the URL boundary`
        )
        assert.doesNotMatch(content, /[\r\n]/, `${sink} emitted a physical line separator`)
        assert.ok(!content.includes(separator), `${sink} retained the physical ${name} separator`)
      }
    })
  }
}

const nestedLogValue = (kind: "object" | "array" | "Error cause", text: string) => {
  if (kind === "object") {
    return { context: { nested: text }, status: 502 }
  }

  if (kind === "array") {
    return { context: [{ nested: [text] }], status: 502 }
  }

  return new Error("upstream failed", { cause: { nested: text, status: 502 } })
}

// Unlike top-level strings, nested strings have already been escaped by
// inspect() before the logger can scrub them. Exercise the real rendering path.
for (const [name, separator] of [
  ["LF", "\n"],
  ["CRLF", "\r\n"],
  ["CR", "\r"],
  ["TAB", "\t"],
  ["U+2028", "\\u2028"],
  ["U+2029", "\\u2029"],
] as const) {
  for (const kind of ["object", "array", "Error cause"] as const) {
    test(`redacts inspect-escaped ${name} URLs inside a nested ${kind} in both sinks`, async () => {
      const origin = `https://${uniqueHost("inspected-adjacent")}`
      const publicUrl = "https://public.fixture.invalid/a"
      registerSensitiveOrigin(`${origin}/NESTED_ADJACENT_SECRET`)
      const text = `${publicUrl}${separator}${origin}/NESTED_ADJACENT_SECRET`
      const value = nestedLogValue(kind, text)

      log.error("Nested adjacent URLs", value)
      await flushLogs()

      const file = await fs.readFile(getLogPath(), "utf8")
      assert.ok(file.endsWith("\n"))
      assert.equal(consoleOutput.length, 1)

      const fileValue = file.slice(0, -1).replace(/^\S+ error /, "")
      assert.equal(fileValue, consoleOutput[0])

      for (const [sink, content] of [["file", fileValue], ["console", consoleOutput[0]]]) {
        assert.ok(!content.includes("NESTED_ADJACENT_SECRET"), `${sink} leaked the nested URL secret`)
        assert.ok(content.includes(`${origin}[redacted]`), `${sink} lost the redaction marker`)
        assert.ok(content.includes(publicUrl), `${sink} altered the public URL`)
        assert.match(content, /status: 502/)
        assert.doesNotMatch(content, /[\r\n]/)
        for (const codePoint of [0x2028, 0x2029]) {
          assert.ok(!content.includes(String.fromCodePoint(codePoint)))
        }
      }
    })
  }
}

// The single logged entry, after checking that both sinks rendered it identically.
const readSinkValue = async (): Promise<string> => {
  await flushLogs()

  const file = await fs.readFile(getLogPath(), "utf8")
  assert.ok(file.endsWith("\n"))
  assert.equal(consoleOutput.length, 1)

  const rendered = file.slice(0, -1).replace(/^\S+ error /, "")
  assert.equal(rendered, consoleOutput[0])

  return rendered
}

const echoedLogValue = (
  kind: "plain" | "nested" | "Error" | "headers" | "JSON escaped" | "inspect escaped",
  echoed: string,
) => {
  if (kind === "plain") {
    return echoed
  }

  if (kind === "nested") {
    return { response: { body: [{ message: echoed }] } }
  }

  if (kind === "Error") {
    return new Error(echoed, { cause: { echoed } })
  }

  if (kind === "headers") {
    return { headers: { "x-upstream-error": echoed } }
  }

  if (kind === "JSON escaped") {
    return JSON.stringify({ error: { message: echoed } })
  }

  return inspect({ nested: echoed }, { compact: true, breakLength: Infinity })
}

for (const kind of ["plain", "nested", "Error", "headers", "JSON escaped", "inspect escaped"] as const) {
  test(`redacts a registered exact secret echoed in ${kind} output in both sinks`, async () => {
    // The backslash, newline, tab and quotes change when output is escaped, so
    // redaction must also catch the secret's escaped spellings.
    const secret = `LOG_SECRET_${kind.replaceAll(" ", "_")}_first\\part\n\t"quoted"_last`
    registerLogSecret(secret)
    const echoed = `Bearer ${secret}`
    const value = echoedLogValue(kind, echoed)

    log.error("upstream failure", value)
    const rendered = await readSinkValue()

    assert.ok(!rendered.includes(`LOG_SECRET_${kind.replaceAll(" ", "_")}_first`))
    assert.ok(!rendered.includes("quoted"))
    assert.match(rendered, /\[redacted\]/)
    assert.match(rendered, /upstream failure/)
  })
}

test("ignores empty secret registrations and retains every previously registered secret", async () => {
  registerLogSecret(undefined)
  registerLogSecret("")
  registerLogSecret("ROTATED_LOG_SECRET_OLD")
  registerLogSecret("ROTATED_LOG_SECRET_NEW")
  registerLogSecret("ROTATED_LOG_SECRET_OLD")

  log.error("old=ROTATED_LOG_SECRET_OLD new=ROTATED_LOG_SECRET_NEW keep=this")
  assert.equal(await readSinkValue(), "old=[redacted] new=[redacted] keep=this")
})

test("redacts overlapping registered values longest first", async () => {
  registerLogSecret("OVERLAPPING_LOG_SECRET")
  registerLogSecret("OVERLAPPING_LOG_SECRET_PRIVATE_SUFFIX")

  // Replacing the shorter value first would leave "_PRIVATE_SUFFIX" behind.
  log.error("token=OVERLAPPING_LOG_SECRET_PRIVATE_SUFFIX")
  assert.equal(await readSinkValue(), "token=[redacted]")
})

test("redacts complete secrets before the 16 KiB final argument boundary", async () => {
  const secret = "FINAL_CAP_SECRET_PREFIX_" + "s".repeat(600)
  registerLogSecret(secret)

  // The 16 KiB cut falls inside the secret, so truncating before redacting
  // would expose its start.
  log.error("x".repeat(16 * 1024 - 200) + secret + "z".repeat(2 * 1024 * 1024))
  const rendered = await readSinkValue()

  assert.ok(!rendered.includes("FINAL_CAP_SECRET_PREFIX"), "truncation exposed a partial secret")
  assert.match(rendered, /\[redacted\]/)
  assert.ok(rendered.endsWith("[truncated]"))
  assert.ok(Buffer.byteLength(rendered) <= 16 * 1024)
})

for (const [name, prefix, visibleLength] of [
  ["plain", "INSPECT_CAP_SECRET_PREFIX_", 20],
  ["escaped", "INSPECT_ESCAPED_\\segment\n\t\"quoted\"", 40],
] as const) {
  test(`redacts a ${name} secret cut by inspect's 4000-character nested-string limit`, async () => {
    const secret = prefix + "s".repeat(200)
    registerLogSecret(secret)

    // inspect cuts the nested string visibleLength characters into the secret,
    // leaving a fragment that no longer matches it whole.
    log.error({ nested: "x".repeat(4000 - visibleLength) + secret + "z".repeat(1000) })
    const rendered = await readSinkValue()

    assert.ok(!rendered.includes(prefix.slice(0, 15)), "inspect exposed a partial secret")
    assert.match(rendered, /\[redacted\]/)
    assert.match(rendered, /more characters/)
  })
}

test.after(async () => {
  await flushLogs()
  await fs.rm(tempHome, { recursive: true, force: true })
})

// Why: the disk gate is a separate decision from the console one. Redacting
// must not accidentally start writing debug entries the level excludes.
test("still honours the disk level gate", async () => {
  setLogLevel("error")

  log.debug("debug entry that must not reach disk")
  log.error("error entry that must reach disk")

  const content = await readActiveLog()

  assert.ok(content.includes("error entry that must reach disk"))
  assert.ok(!content.includes("debug entry that must not reach disk"))
})

// Reads config.yaml with this upstreamProxy and builds the upstream dispatcher from it, as start
// does.
const startWithProxy = async (upstreamProxy: string): Promise<void> => {
  await fs.mkdir(paths.appDir, { recursive: true })
  await fs.writeFile(paths.configPath, `upstreamProxy: ${upstreamProxy}\n`)
  configureUpstreamDispatcher((await readAppConfig()).upstreamProxy)
}

// Why: a proxy URL's user name and password become a Proxy-Authorization header, so
// they are credentials like a token. Building the dispatcher registers user:password, as written
// in the URL and decoded, and the Basic value undici sends, so an echo of any of them is redacted.
// A user name or password alone is not registered: redaction replaces a value in every log line.
test("building the dispatcher registers the proxy's user:password and Basic value, not either part alone", async (t) => {
  t.after(() => configureUpstreamDispatcher(undefined))
  await startWithProxy("http://PROXY_USER_SENTINEL:PROXY%23PASS_SENTINEL@proxy.invalid:3128")
  const basic = Buffer.from("PROXY_USER_SENTINEL:PROXY#PASS_SENTINEL").toString("base64")

  log.error(`echoed PROXY_USER_SENTINEL:PROXY%23PASS_SENTINEL PROXY_USER_SENTINEL:PROXY#PASS_SENTINEL Basic ${basic}`)
  log.error("named PROXY_USER_SENTINEL")
  await flushLogs()

  const content = await readActiveLog()
  assert.ok(content.includes("echoed [redacted] [redacted] Basic [redacted]\n"), content)
  assert.ok(content.includes("named PROXY_USER_SENTINEL\n"), content)
  assert.doesNotMatch(content + consoleOutput.join("\n"), /PASS_SENTINEL/)
  assert.ok(!(content + consoleOutput.join("\n")).includes(basic))
})

// Why: a proxy user name such as "a" or "copilot" occurs in ordinary text. Registered alone,
// "a" cut into "completion path=", so `copilot-relay cache` skipped the record, and "copilot"
// turned "copilot-relay" into "[redacted]-relay".
test("a short or common proxy user name leaves ordinary log lines and completion records intact", async (t) => {
  t.after(() => configureUpstreamDispatcher(undefined))
  await startWithProxy("http://a:proxy-pass-sentinel@proxy.invalid:3128")
  await startWithProxy("http://copilot:proxy-pass-sentinel@proxy.invalid:3128")

  const completion = "request_id=req-proxy-user upstream_request_id=up-proxy-user completion path=/v1/messages http_status=200 body=complete model=claude-opus-5-5 input_tokens=2 output_tokens=55 cache_read_input_tokens=31136"
  log.info(completion)
  log.info("copilot-relay applied a config change")
  await flushLogs()

  const lines = (await readActiveLog()).split("\n")
  const recorded = lines.find((line) => line.endsWith(` info ${completion}`))
  assert.ok(recorded, lines.join("\n"))
  assert.equal(parseCompletionLine(recorded)?.inputTokens, 2)
  assert.ok(lines.some((line) => line.endsWith(" info copilot-relay applied a config change")), lines.join("\n"))
})

// Why: with upstreamProxy: env the proxy URLs come from the environment. Each one undici
// reads, HTTPS_PROXY or HTTP_PROXY in either case, has its credentials registered the same way.
test("upstreamProxy: env registers the credentials of each proxy variable undici reads", async (t) => {
  t.after(() => configureUpstreamDispatcher(undefined))
  await withProxyEnvironment({
    HTTPS_PROXY: "http://env-user-sentinel:ENV%40PASS_SENTINEL@proxy.invalid:3128",
    http_proxy: "http://http-user-sentinel:HTTP_PASS_SENTINEL@proxy.invalid:3129",
  }, () => startWithProxy("env"))

  log.error("env-echoed env-user-sentinel:ENV@PASS_SENTINEL http-user-sentinel:HTTP_PASS_SENTINEL")
  await flushLogs()

  const content = await readActiveLog()
  assert.ok(content.includes("env-echoed [redacted] [redacted]\n"), content)
  assert.doesNotMatch(content + consoleOutput.join("\n"), /PASS_SENTINEL/)
})
