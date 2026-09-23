import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { stripVTControlCharacters } from "node:util"

const entry = new URL("../../src/main.ts", import.meta.url)
const cwd = fileURLToPath(new URL("../../", import.meta.url))
const oldToken = "old-private-token-sentinel"
const newToken = "new-private-token-sentinel"
const secretPath = "/private-gateway-sentinel"

async function fixture(
  t: TestContext,
  handle: (request: IncomingMessage, response: ServerResponse, attempt: number) => void,
  options: { timeout?: number; failRefresh?: boolean; expiredToken?: boolean } = {},
) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-models-"))
  const requests: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined }> = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
    handle(request, response, requests.length)
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(home, { recursive: true, force: true })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address === "object")
  const appDir = path.join(home, ".copilot-relay")
  await fs.mkdir(appDir)
  await fs.mkdir(path.join(home, ".claude"))
  const settingsPath = path.join(home, ".claude", "settings.json")
  const settings = '{"env":{"UNCHANGED":"sentinel"}}\n'
  await fs.writeFile(settingsPath, settings)
  await fs.writeFile(path.join(appDir, "config.yaml"), [
    `copilotBaseUrl: http://127.0.0.1:${address.port}${secretPath}`,
    "gptModel: missing-gpt-model",
    "opusModel: missing-opus-model",
    "claudeSetup: true",
    "logLevel: debug",
    `port: ${address.port}`,
    `upstreamTimeoutSeconds: ${options.timeout ?? 3}`,
    "",
  ].join("\n"))
  await fs.writeFile(path.join(appDir, "github_token"), "github-private-token-sentinel\n")
  await fs.writeFile(path.join(appDir, "copilot_token.json"), JSON.stringify({
    token: oldToken, refreshedAt: options.expiredToken ? 0 : Date.now(), refreshIn: 86400,
  }))

  const run = async (args = ["models"]) => {
    const script = `
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url === "https://api.github.com/user") return Response.json({ login: "test" });
        if (url === "https://api.github.com/copilot_internal/v2/token") {
          ${options.failRefresh ? 'throw new Error("auth-private-error-sentinel");' : `return Response.json({ token: ${JSON.stringify(newToken)}, refresh_in: 86400 });`}
        }
        throw new Error("UNEXPECTED_NETWORK_ACCESS");
      };
      process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entry))}, ...${JSON.stringify(args)}];
      await import(${JSON.stringify(entry.href)});
    `
    const result = await new Promise<{ code: number; rawStdout: string; stdout: string; output: string }>((resolve, reject) => {
      const child = execFile(process.execPath, [
        "--import", "tsx", "--input-type=module", "--eval", script,
      ], {
        cwd, timeout: 15_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" },
      }, (error, stdout, stderr) => {
        const code = error ? error.code : 0
        if (error?.killed || typeof code !== "number") {
          reject(error ?? new Error("Missing CLI exit code"))
          return
        }
        resolve({ code, rawStdout: stdout, stdout: stripVTControlCharacters(stdout), output: stripVTControlCharacters(stdout + stderr) })
      })
      child.stdin?.end()
    })
    const logFiles = await fs.readdir(path.join(appDir, "logs")).catch(() => [])
    const logs = (await Promise.all(logFiles.map((name) => fs.readFile(path.join(appDir, "logs", name), "utf8")))).join("\n")
    assert.doesNotMatch(result.output + logs, /old-private-token-sentinel|new-private-token-sentinel|github-private-token-sentinel|private-gateway-sentinel|auth-private-error-sentinel|payload-private-sentinel|UNEXPECTED_NETWORK_ACCESS/)
    assert.doesNotMatch(result.output, /Running upstream preflight|copilot-relay listening/)
    assert.equal(await fs.readFile(settingsPath, "utf8"), settings)
    await assert.rejects(fs.stat(path.join(appDir, "copilot-relay.pid")), { code: "ENOENT" })
    const config = await fs.readFile(path.join(appDir, "config.yaml"), "utf8")
    assert.match(config, /gptModel: missing-gpt-model/)
    assert.match(config, /opusModel: missing-opus-model/)
    for (const request of requests) {
      assert.equal(request.method, "GET")
      assert.equal(request.url, `${secretPath}/models`)
    }
    return result
  }
  return { run, requests, server }
}

const respond = (response: ServerResponse, payload: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(payload))
}

test("models help is registered without authentication or upstream access", async (t) => {
  const f = await fixture(t, (_request, response) => respond(response, { data: [] }))
  const help = await f.run(["--help"])
  assert.equal(help.code, 0)
  assert.match(help.stdout, /models\s+.*upstream/i)
  const commandHelp = await f.run(["models", "--help"])
  assert.equal(commandHelp.code, 0)
  assert.match(commandHelp.stdout, /upstream/i)
  assert.equal(f.requests.length, 0)
})

test("models lists the fresh full catalog with sorted exact IDs, independent of configured models", async (t) => {
  let catalog: unknown = { data: [
    { id: "z-chat" }, { id: "a-embedding" }, { id: "gpt-example" },
    { id: "gpt-example" }, null, {}, { id: 7 }, { id: "" },
    { id: "b-no-limits", capabilities: { limits: "invalid" } },
  ] }
  const f = await fixture(t, (_request, response) => respond(response, catalog))
  const result = await f.run()
  assert.equal(result.code, 0)
  assert.match(result.stdout, /Upstream-advertised models \(4\):\na-embedding\nb-no-limits\ngpt-example\nz-chat\n/)
  assert.match(result.stdout, /not verified/i)
  assert.doesNotMatch(result.stdout, /\[1m\]|missing-gpt-model|missing-opus-model/)
  assert.deepEqual(f.requests.map((request) => request.authorization), [`Bearer ${oldToken}`])
  catalog = { data: [{ id: "newly-advertised" }] }
  const fresh = await f.run()
  assert.equal(fresh.code, 0)
  assert.match(fresh.stdout, /Upstream-advertised models \(1\):\nnewly-advertised\n/)
  assert.doesNotMatch(fresh.stdout, /a-embedding|z-chat/)
  assert.equal(f.requests.length, 2)
})

test("models sanitizes terminal controls and redacts sensitive URLs in upstream IDs", async (t) => {
  const f = await fixture(t, (request, response) => respond(response, { data: [
    { id: "a-\u001b[2K\u001b[1Aexample\r\nforged-row" },
    { id: `http://${request.headers.host}${secretPath}/model` },
  ] }))
  const result = await f.run()
  assert.equal(result.code, 0)
  const listing = result.rawStdout.slice(result.rawStdout.indexOf("Upstream-advertised models"))
  assert.doesNotMatch(listing, /\u001b|\r/)
  assert.match(listing, /a-exampleforged-row\n/)
  assert.match(listing, /http:\/\/127\.0\.0\.1:\d+\[redacted\]/)
})

test("models reports an empty catalog successfully", async (t) => {
  const f = await fixture(t, (_request, response) => respond(response, { data: [] }))
  const result = await f.run()
  assert.equal(result.code, 0)
  assert.match(result.stdout, /No models advertised by upstream/)
})

for (const payload of [{ models: [] }, { data: null }, { data: "payload-private-sentinel" }]) {
  test(`models rejects a malformed catalog: ${JSON.stringify(payload)}`, async (t) => {
    const f = await fixture(t, (_request, response) => respond(response, payload))
    const result = await f.run()
    assert.equal(result.code, 1)
    assert.match(result.output, /Could not fetch upstream model catalog/)
    assert.doesNotMatch(result.stdout, /Upstream-advertised models|No models advertised/)
  })
}

test("models rejects invalid JSON without leaking the response body", async (t) => {
  const f = await fixture(t, (_request, response) => response.end("payload-private-sentinel invalid JSON"))
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.output, /Could not fetch upstream model catalog/)
})

for (const status of [403, 503, 504]) {
  test(`models reports genuine HTTP ${status} without response-body disclosure`, async (t) => {
    const f = await fixture(t, (_request, response) => respond(response, { error: "payload-private-sentinel" }, status))
    const result = await f.run()
    assert.equal(result.code, 1)
    assert.match(result.output, new RegExp(`Could not fetch upstream model catalog: HTTP ${status}`))
    assert.doesNotMatch(result.output, /request timed out/)
    assert.equal(f.requests.length, status >= 500 ? 2 : 1)
  })
}

test("models distinguishes a local deadline from an upstream HTTP 504", async (t) => {
  const f = await fixture(t, () => {}, { timeout: 1 })
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.output, /Could not fetch upstream model catalog: request timed out/)
  assert.doesNotMatch(result.output, /HTTP 504/)
})

test("models returns a nonzero exit on connection failure", async (t) => {
  const f = await fixture(t, () => {})
  await new Promise<void>((resolve) => f.server.close(() => resolve()))
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.output, /Could not fetch upstream model catalog/)
})

test("models reuses bounded rejected-token recovery", async (t) => {
  const f = await fixture(t, (_request, response, attempt) => {
    respond(response, attempt === 1 ? {} : { data: [{ id: "recovered-model" }] }, attempt === 1 ? 401 : 200)
  })
  const result = await f.run()
  assert.equal(result.code, 0)
  assert.match(result.stdout, /recovered-model/)
  assert.deepEqual(f.requests.map((request) => request.authorization), [`Bearer ${oldToken}`, `Bearer ${newToken}`])
})

test("models fails safely when rejected-token recovery fails", async (t) => {
  const f = await fixture(t, (_request, response) => respond(response, {}, 401), { failRefresh: true })
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.output, /Could not fetch upstream model catalog/)
  assert.equal(f.requests.length, 1)
})

test("models fails safely during initial authentication", async (t) => {
  const f = await fixture(t, () => {}, { failRefresh: true, expiredToken: true })
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.output, /Could not authenticate with GitHub Copilot/)
  assert.equal(f.requests.length, 0)
})
