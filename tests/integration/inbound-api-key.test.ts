import assert from "node:assert/strict"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { stripVTControlCharacters } from "node:util"

// Why (#159): apiKey crosses boundaries that unit tests reach one at a time:
// daemon admission, config hot reload, the Claude Code settings writer, the
// `status` probes and the startup warning. This runs the real CLI against a
// local fake Copilot upstream; a fetch stub answers GitHub auth, so nothing
// here contacts GitHub or Copilot.
const entry = fileURLToPath(new URL("../../src/main.ts", import.meta.url))
const cwd = fileURLToPath(new URL("../../", import.meta.url))

// Fixture keys and tokens only. Each is distinct, so a leak names its source.
const firstKey = "inbound-fixture-key-0001"
const secondKey = "inbound-fixture-key-0002"
const githubToken = "github-fixture-token-sentinel"
const copilotToken = "copilot-fixture-token-sentinel"

// Loaded through NODE_OPTIONS rather than argv, so a relay child keeps the
// command line `status` recognizes. GitHub auth gets fixtures, loopback passes
// through, and anything else fails loudly.
const fetchStub = `
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.startsWith("http://127.0.0.1:")) {
    return realFetch(input, init);
  }
  if (url === "https://api.github.com/user") {
    return Response.json({ login: "fixture-user" });
  }
  if (url === "https://api.github.com/copilot_internal/v2/token") {
    return Response.json({ token: ${JSON.stringify(copilotToken)}, refresh_in: 86400 });
  }
  if (url.startsWith("https://github.com/login/")) {
    throw new Error("DEVICE_LOGIN_STOPPED_FOR_TEST");
  }
  throw new Error("UNEXPECTED_NETWORK_ACCESS " + url);
};
`

const catalogModel = (id: string) => ({
  id,
  supported_endpoints: ["/chat/completions"],
  capabilities: {
    type: "chat",
    limits: { max_context_window_tokens: 128_000, max_prompt_tokens: 96_000, max_output_tokens: 32_000 },
    supports: { reasoning_effort: ["low", "max"] },
  },
})

// Stands in for Copilot: the catalog, and an "ok" completion for any other request.
async function fakeCopilot(t: TestContext) {
  const requests: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders }> = []
  const server = createServer(async (request, response) => {
    requests.push({ method: request.method, url: request.url, headers: request.headers })
    let body = ""
    for await (const chunk of request) {
      body += String(chunk)
    }

    response.setHeader("content-type", "application/json")
    if (request.url === "/models") {
      response.end(JSON.stringify({ data: [catalogModel("gpt-fixture-chat"), catalogModel("claude-opus-5.5")] }))
      return
    }

    const sent = JSON.parse(body) as { model: string }
    response.end(JSON.stringify({
      id: "chat_inbound_fixture",
      created: 1,
      model: sent.model,
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const address = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests }
}

const freePort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

interface RelayHome {
  appDir: string
  configPath: string
  env: NodeJS.ProcessEnv
  home: string
  settingsPath: string
}

// An isolated install. HOME and USERPROFILE point every child here, so no child
// reads or writes the real relay config, tokens, logs or Claude Code settings.
const relayHome = async (options: { tokens: boolean }): Promise<RelayHome> => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-inbound-key-"))
  const appDir = path.join(home, ".copilot-relay")
  await fs.mkdir(appDir, { recursive: true })
  await fs.mkdir(path.join(home, ".claude"), { recursive: true })

  if (options.tokens) {
    await fs.writeFile(path.join(appDir, "github_token"), `${githubToken}\n`)
    await fs.writeFile(path.join(appDir, "copilot_token.json"), JSON.stringify({
      token: copilotToken,
      refreshedAt: Date.now(),
      refreshIn: 86400,
    }))
  }

  const stub = path.join(home, "fetch-stub.mjs")
  await fs.writeFile(stub, fetchStub)
  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${pathToFileURL(stub).href}`].filter(Boolean).join(" ")

  return {
    appDir,
    configPath: path.join(appDir, "config.yaml"),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      NO_COLOR: "1",
      CONSOLA_LEVEL: "3",
      NODE_OPTIONS: nodeOptions,
    },
    home,
    settingsPath: path.join(home, ".claude", "settings.json"),
  }
}

// Windows can hold a just-killed child's files for a moment.
const removeHome = (home: string): Promise<void> =>
  fs.rm(home, { force: true, recursive: true, maxRetries: 10, retryDelay: 200 })

const readLogs = async (appDir: string): Promise<string> => {
  const logsDir = path.join(appDir, "logs")
  const logFiles = await fs.readdir(logsDir).catch(() => [])
  const contents = await Promise.all(logFiles.map((name) => fs.readFile(path.join(logsDir, name), "utf8").catch(() => "")))
  return contents.join("\n")
}

interface RelayProcess {
  child: ChildProcess
  exited: () => boolean
  output: () => string
}

// The argv shape `status` recognizes for a source checkout: node --import tsx src/main.ts start.
const spawnRelay = (home: RelayHome): RelayProcess => {
  const child = spawn(process.execPath, ["--import", "tsx", entry, "start"], {
    cwd,
    env: home.env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  let spawnFailed = false
  child.stdout?.on("data", (chunk) => {
    output += String(chunk)
  })
  child.stderr?.on("data", (chunk) => {
    output += String(chunk)
  })
  child.on("error", () => {
    spawnFailed = true
  })

  return {
    child,
    exited: () => spawnFailed || child.exitCode !== null || child.signalCode !== null,
    output: () => stripVTControlCharacters(output),
  }
}

// SIGTERM is the graceful shutdown on POSIX and an immediate kill on Windows.
const stopRelay = (relay: RelayProcess): Promise<void> => new Promise<void>((resolve) => {
  if (relay.exited()) {
    resolve()
    return
  }

  const force = setTimeout(() => relay.child.kill("SIGKILL"), 10_000)
  relay.child.once("exit", () => {
    clearTimeout(force)
    resolve()
  })
  relay.child.kill("SIGTERM")
})

const waitFor = async (relay: RelayProcess, ready: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 90_000
  while (!(await ready())) {
    if (relay.exited()) {
      throw new Error(`relay exited early:\n${relay.output()}`)
    }

    if (Date.now() > deadline) {
      throw new Error(`relay never became ready:\n${relay.output()}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

const runCli = (home: RelayHome, args: string[]) =>
  new Promise<{ code: number; stdout: string; output: string }>((resolve, reject) => {
    const child = execFile(process.execPath, ["--import", "tsx", entry, ...args], {
      cwd,
      env: home.env,
      timeout: 120_000,
    }, (error, stdout, stderr) => {
      const code = error ? error.code : 0
      if (error?.killed || typeof code !== "number") {
        reject(error ?? new Error("Missing CLI exit code"))
        return
      }

      resolve({ code, stdout: stripVTControlCharacters(stdout), output: stripVTControlCharacters(stdout + stderr) })
    })
    child.stdin?.end()
  })

const statusOf = async (url: string, init?: RequestInit): Promise<number> => {
  const response = await fetch(url, init)
  await response.arrayBuffer()
  return response.status
}

test("a relay with an apiKey admits only keyed clients and applies a rotated key without a restart", { timeout: 240_000 }, async (t) => {
  const upstream = await fakeCopilot(t)
  const port = await freePort()
  const home = await relayHome({ tokens: true })
  const baseUrl = `http://127.0.0.1:${port}`

  await fs.writeFile(home.configPath, [
    "host: 127.0.0.1",
    `port: ${port}`,
    `apiKey: ${firstKey}`,
    `copilotBaseUrl: ${upstream.baseUrl}`,
    "claudeSetup: true",
    "logLevel: info",
    "gptModel: gpt-fixture-chat",
    "opusModel: claude-opus-5.5",
    "",
  ].join("\n"))
  // A stale token for the settings writer to replace, beside a value it must keep.
  await fs.writeFile(home.settingsPath, `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "dummy", UNRELATED: "kept" } }, null, 2)}\n`)

  const relay = spawnRelay(home)
  t.after(async () => {
    await stopRelay(relay)
    await removeHome(home.home)
  })

  const reloads = async (): Promise<number> => (await readLogs(home.appDir)).split("Config reloaded:").length - 1

  // The watcher's first poll logs this after the listener, the pid file and the Claude Code settings.
  await waitFor(relay, async () => (await reloads()) >= 1)

  // Open probes answer without the key; protected routes refuse a request without it.
  assert.equal(await statusOf(`${baseUrl}/healthz`), 200)
  const refused = await fetch(`${baseUrl}/v1/models`)
  assert.equal(refused.status, 401)
  assert.equal((await refused.json() as { error: { type: string } }).error.type, "authentication_error")
  assert.equal(await statusOf(`${baseUrl}/v1/models`, { headers: { "x-api-key": firstKey } }), 200)

  // Claude Code sends ANTHROPIC_AUTH_TOKEN as Authorization: Bearer.
  const message = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${firstKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-fixture-chat", max_tokens: 16, messages: [{ role: "user", content: "Reply ok" }] }),
  })
  assert.equal(message.status, 200)
  assert.deepEqual((await message.json() as { content: unknown }).content, [{ type: "text", text: "ok" }])

  // Startup wrote the key as Claude Code's token, replacing the dummy and keeping the rest.
  const settings = JSON.parse(await fs.readFile(home.settingsPath, "utf8")) as { env: Record<string, string> }
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, firstKey)
  assert.equal(settings.env.ANTHROPIC_BASE_URL, baseUrl)
  assert.equal(settings.env.UNRELATED, "kept")

  // Rotate the key while the relay runs.
  const config = await fs.readFile(home.configPath, "utf8")
  assert.match(config, new RegExp(`^apiKey: ${firstKey}$`, "m"))
  await fs.writeFile(home.configPath, config.replace(`apiKey: ${firstKey}`, `apiKey: ${secondKey}`))
  await waitFor(relay, async () => (await statusOf(`${baseUrl}/v1/models`, { headers: { "x-api-key": secondKey } })) === 200)
  assert.equal(await statusOf(`${baseUrl}/v1/models`, { headers: { "x-api-key": firstKey } }), 401)

  // The settings writer runs only at startup, so Claude Code keeps the key it was given.
  const afterRotation = JSON.parse(await fs.readFile(home.settingsPath, "utf8")) as { env: Record<string, string> }
  assert.equal(afterRotation.env.ANTHROPIC_AUTH_TOKEN, firstKey)

  // status reads the rotated key and sends it on both protected probes: without it, models
  // would be empty and the deep check would fail with 401.
  const status = await runCli(home, ["status", "--json", "--deep"])
  assert.equal(status.code, 0, status.output)
  const report = JSON.parse(status.stdout.slice(status.stdout.indexOf("{"))) as {
    config: { apiKey: string }
    deep?: { ok: boolean; detail?: string }
    health?: { ok: boolean }
    models?: string[]
    running: boolean
  }
  assert.equal(report.running, true)
  assert.equal(report.health?.ok, true)
  assert.ok(report.models?.length, status.output)
  assert.equal(report.deep?.ok, true, report.deep?.detail)
  assert.equal(report.config.apiKey, "[redacted]")

  await waitFor(relay, async () => (await reloads()) >= 2)
  await stopRelay(relay)

  const logs = await readLogs(home.appDir)
  assert.match(logs, / -> 401 /)
  for (const secret of [firstKey, secondKey, githubToken, copilotToken]) {
    assert.ok(!logs.includes(secret), "a key or token reached the log")
    assert.ok(!relay.output().includes(secret), "a key or token reached the relay console")
    assert.ok(!status.output.includes(secret), "a key or token reached status output")
  }

  assert.doesNotMatch(logs + relay.output(), /UNEXPECTED_NETWORK_ACCESS|DEVICE_LOGIN_STOPPED_FOR_TEST|not a loopback address/)

  // Upstream sees only the relay's own Copilot token, never a client's key.
  for (const request of upstream.requests) {
    const headers = JSON.stringify(request.headers)
    assert.ok(!headers.includes(firstKey) && !headers.includes(secondKey), `${request.method} ${request.url}`)
  }
})

test("startup warns about a listener beyond loopback without an apiKey and never prints a key", { timeout: 240_000 }, async (t) => {
  // No stored GitHub token: startup stops at device login, before it binds a listener or
  // contacts copilotBaseUrl.
  const home = await relayHome({ tokens: false })
  t.after(() => removeHome(home.home))
  const unusedPort = await freePort()

  const start = async (host: string, apiKey: string): Promise<string> => {
    await fs.writeFile(home.configPath, [
      `host: ${host}`,
      `port: ${await freePort()}`,
      `apiKey: ${apiKey}`,
      `copilotBaseUrl: http://127.0.0.1:${unusedPort}`,
      "claudeSetup: false",
      "",
    ].join("\n"))
    const result = await runCli(home, ["start"])

    assert.equal(result.code, 1, result.output)
    assert.match(result.output, /DEVICE_LOGIN_STOPPED_FOR_TEST/)
    assert.doesNotMatch(result.output, /UNEXPECTED_NETWORK_ACCESS|copilot-relay listening/)
    return result.output
  }

  // 192.0.2.1 is TEST-NET-1, never a local address.
  const exposed = await start("192.0.2.1", "")
  assert.match(exposed, /apiKey is empty and host 192\.0\.2\.1 is not a loopback address: any client that can reach port \d+ can consume your Copilot usage\. Set apiKey in /)

  const keyed = await start("192.0.2.1", firstKey)
  assert.doesNotMatch(keyed, /not a loopback address/)
  assert.ok(!keyed.includes(firstKey), "startup printed the key")
  assert.ok(!(await readLogs(home.appDir)).includes(firstKey), "startup logged the key")

  assert.doesNotMatch(await start("127.0.0.1", ""), /not a loopback address/)
})
