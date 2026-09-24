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
  options: { timeout?: number; failRefresh?: boolean; expiredToken?: boolean; deep?: boolean; interrupt?: boolean } = {},
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
      ${options.interrupt ? 'setTimeout(() => process.emit("SIGINT"), 1000);' : ''}
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
      if (request.method === "GET" || !options.deep) {
        assert.equal(request.method, "GET")
        assert.equal(request.url, `${secretPath}/models`)
      } else {
        assert.equal(request.method, "POST")
        assert.ok([`${secretPath}/responses`, `${secretPath}/chat/completions`].includes(request.url!))
      }
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

const deepCatalog = { data: [
  { id: "gpt-6-astra", supported_endpoints: ["/responses"], capabilities: { type: "chat", supports: { reasoning_effort: ["max", "low"] }, limits: { max_context_window_tokens: 10000, max_prompt_tokens: 8000, max_output_tokens: 2000 } } },
  { id: "claude-opus-5.5", supported_endpoints: ["/chat/completions"], capabilities: { type: "chat", supports: { reasoning_effort: ["low", "max"] } } },
] }

async function requestBody(request: IncomingMessage): Promise<Record<string, any>> {
  let raw = ""
  for await (const chunk of request) raw += chunk
  return JSON.parse(raw)
}
const probeReply = (body: Record<string, any>, overrides: Record<string, unknown> = {}) => body.model === "gpt-6-astra" ? {
  id: "resp_probe", created_at: 1, model: body.model, status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text: "PRIVATE_PROBE_ANSWER" }] }],
  usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }, ...overrides,
} : {
  id: "chat_probe", created: 1, model: body.model,
  choices: [{ index: 0, message: { role: "assistant", content: "PRIVATE_PROBE_ANSWER" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }, ...overrides,
}

test("models deep tests exact IDs through the isolated pipeline and prints a structured summary", async (t) => {
  const sent: Array<Record<string, any>> = []
  const f = await fixture(t, async (req, res) => {
    if (req.method === "GET") return respond(res, deepCatalog)
    const body = await requestBody(req); sent.push(body); respond(res, probeReply(body))
  }, { deep: true })
  const result = await f.run(["models", "--deep"])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /isolated relay pipeline/i)
  assert.match(result.stdout, /not running-daemon health/i)
  assert.match(result.stdout, /MODEL\s+STATUS\s+SENT\/REPORTED\s+LATENCY/)
  assert.match(result.stdout, /Summary: 2 passed, 0 failed, 0 incomplete, 0 skipped, 0 not tested/)
  assert.doesNotMatch(result.output, /PRIVATE_PROBE_ANSWER/)
  assert.deepEqual(sent.map((body) => body.model), ["claude-opus-5.5", "gpt-6-astra"])
  assert.equal(sent[0]?.reasoning_effort, "low")
  assert.equal(sent[1]?.reasoning.effort, "low")
  assert.equal(sent[1]?.max_output_tokens, 2000)
  assert(sent.every((body) => !body.tools))
})

test("models deep selection sends only the selected exact model", async (t) => {
  const sent: string[] = []
  const f = await fixture(t, async (req, res) => {
    if (req.method === "GET") return respond(res, deepCatalog)
    const body = await requestBody(req); sent.push(body.model); respond(res, probeReply(body))
  }, { deep: true })
  const result = await f.run(["models", "--deep", "--model", "gpt-6-astra", "--effort", "max", "--max-tokens", "64"])
  assert.equal(result.code, 0)
  assert.deepEqual(sent, ["gpt-6-astra"])
  assert.match(result.stdout, /tokens=64 effort=max/)
})

for (const [name, overrides, status] of [
  ["incomplete", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }, "INCOMPLETE"],
  ["failed", { status: "failed" }, "FAIL"],
  ["cancelled", { status: "cancelled" }, "FAIL"],
  ["filtered", { status: "incomplete", incomplete_details: { reason: "content_filter" } }, "FAIL"],
  ["empty", { output: [] }, "FAIL"],
  ["refusal", { output: [{ type: "message", content: [{ type: "output_text", text: "partial" }, { type: "refusal", refusal: "PRIVATE_REFUSAL" }] }] }, "FAIL"],
  ["wrong model", { model: "other-model" }, "FAIL"],
] as const) {
  test(`models deep never passes ${name} responses`, async (t) => {
    const f = await fixture(t, async (req, res) => {
      if (req.method === "GET") return respond(res, deepCatalog)
      respond(res, probeReply(await requestBody(req), overrides))
    }, { deep: true })
    const result = await f.run(["models", "--deep", "--model", "gpt-6-astra"])
    assert.equal(result.code, 2)
    assert.match(result.stdout, new RegExp(status))
    assert.match(result.stdout, /Summary: 0 passed/)
    assert.doesNotMatch(result.output, /PRIVATE_PROBE_ANSWER/)
  })
}

test("models deep skips explicit unsupported capabilities without inference", async (t) => {
  const f = await fixture(t, (_req, res) => respond(res, { data: [
    { id: "embedding", capabilities: { type: "embeddings" } },
    { id: "native-only", supported_endpoints: ["/v1/messages"] },
    { id: "high-only", capabilities: { supports: { reasoning_effort: ["high"] } } },
  ] }), { deep: true })
  const result = await f.run(["models", "--deep", "--effort", "low"])
  assert.equal(result.code, 2)
  assert.match(result.stdout, /3 skipped/)
  assert.equal(f.requests.length, 1)
})

for (const args of [["--model", "gpt-6-astra"], ["--deep", "--timeout", "0"], ["--deep", "--max-tokens", "NaN"], ["--deep", "--effort", "invalid"], ["--deep", "--model", "missing"]]) {
  test(`models rejects invalid selection/options ${args.join(" ")}`, async (t) => {
    const f = await fixture(t, (_req, res) => respond(res, deepCatalog), { deep: true })
    const result = await f.run(["models", ...args])
    assert.equal(result.code, 1)
    assert.equal(f.requests.filter((request) => request.method === "POST").length, 0)
  })
}

test("models deep handles HTTP errors without leaking shared pipeline logs", async (t) => {
  const f = await fixture(t, (req, res) => req.method === "GET" ? respond(res, deepCatalog)
    : respond(res, { error: { message: "payload-private-sentinel" } }, 429), { deep: true })
  const result = await f.run(["models", "--deep"])
  assert.equal(result.code, 2)
  assert.match(result.stdout, /rate-limited/)
  assert.match(result.stdout, /2 failed/)
})

for (const interrupt of [false, true]) {
  test(`models deep stops remaining probes on ${interrupt ? "interruption" : "total deadline"}`, async (t) => {
    const f = await fixture(t, (req, res) => { if (req.method === "GET") respond(res, deepCatalog) }, { deep: true, interrupt })
    const result = await f.run(["models", "--deep", "--timeout", "5", "--total-timeout", interrupt ? "10" : "1"])
    assert.equal(result.code, interrupt ? 130 : 2)
    assert.match(result.stdout, /claude-opus-5\.5\s+NOT_TESTED/)
    assert.match(result.stdout, /Summary: 0 passed, 0 failed, 0 incomplete, 0 skipped, 2 not tested/)
    assert.equal(f.requests.filter((request) => request.method === "POST").length, 1)
  })
}

test("models deep continues after a per-model timeout", async (t) => {
  const f = await fixture(t, async (req, res) => {
    if (req.method === "GET") return respond(res, deepCatalog)
    const body = await requestBody(req)
    if (body.model === "gpt-6-astra") respond(res, probeReply(body))
  }, { deep: true })
  const result = await f.run(["models", "--deep", "--timeout", "1"])
  assert.equal(result.code, 2)
  assert.match(result.stdout, /probe-timeout/)
  assert.match(result.stdout, /Summary: 1 passed, 1 failed/)
})

test("models deep recovers a rejected inference token without printing response bodies", async (t) => {
  const headers: string[] = []
  const f = await fixture(t, async (req, res) => {
    if (req.method === "GET") return respond(res, deepCatalog)
    const body = await requestBody(req)
    headers.push(req.headers.authorization ?? "")
    if (headers.length === 1) return respond(res, {}, 401)
    respond(res, probeReply(body))
  }, { deep: true })
  const result = await f.run(["models", "--deep", "--model", "gpt-6-astra"])
  assert.equal(result.code, 0)
  assert.deepEqual(headers, [`Bearer ${oldToken}`, `Bearer ${newToken}`])
  assert.doesNotMatch(result.output, /PRIVATE_PROBE_ANSWER/)
})

test("models deep empty catalog has no successful checks", async (t) => {
  const f = await fixture(t, (_req, res) => respond(res, { data: [] }), { deep: true })
  const result = await f.run(["models", "--deep"])
  assert.equal(result.code, 2)
  assert.match(result.stdout, /Summary: 0 passed/)
  assert.equal(f.requests.length, 1)
})

test("models deep rejects explicit chat refusals even alongside text", async (t) => {
  const f = await fixture(t, async (req, res) => {
    if (req.method === "GET") return respond(res, deepCatalog)
    const body = await requestBody(req)
    respond(res, probeReply(body, { choices: [{ index: 0, finish_reason: "stop", message: {
      role: "assistant", content: "partial", refusal: "PRIVATE_REFUSAL",
    } }] }))
  }, { deep: true })
  const result = await f.run(["models", "--deep", "--model", "claude-opus-5.5"])
  assert.equal(result.code, 2)
  assert.match(result.stdout, /refusal-or-unexpected-completion/)
  assert.doesNotMatch(result.output, /PRIVATE_REFUSAL/)
})

test("models deep missing metadata is explicitly unverified", async (t) => {
  const f = await fixture(t, async (req, res) => {
    if (req.method === "GET") return respond(res, { data: [{ id: "claude-opus-5.5" }] })
    const body = await requestBody(req)
    assert.equal(body.reasoning_effort, "low")
    respond(res, probeReply(body))
  }, { deep: true })
  const result = await f.run(["models", "--deep"])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /effort=low\(unverified\) endpoints=unverified/)
})

test("models fails safely during initial authentication", async (t) => {
  const f = await fixture(t, () => {}, { failRefresh: true, expiredToken: true })
  const result = await f.run()
  assert.equal(result.code, 1)
  assert.match(result.output, /Could not authenticate with GitHub Copilot/)
  assert.equal(f.requests.length, 0)
})
