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
  options: {
    timeout?: number;
    failRefresh?: boolean;
    expiredToken?: boolean;
    deep?: boolean;
    interrupt?: boolean;
    controlledProbeTimeout?: boolean;
    logLevel?: "info" | "debug";
    deviceAuth?: boolean
  } = {},
) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-models-"))

  // The fake Copilot upstream records every request. run() sets notifyFirstProbe for the
  // interrupt and deadline tests, so the first probe POST can signal the child process.
  const requests: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined }> = []
  let notifyFirstProbe: (() => void) | undefined
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization })
    if (request.method === "POST") {
      notifyFirstProbe?.()
      notifyFirstProbe = undefined
    }

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

  // An isolated install: config points the CLI at the fake upstream, and Claude settings
  // hold a sentinel that run() checks is left unchanged.
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
    `logLevel: ${options.logLevel ?? "debug"}`,
    `port: ${address.port}`,
    `upstreamTimeoutSeconds: ${options.timeout ?? 3}`,
    "",
  ].join("\n"))
  await fs.writeFile(path.join(appDir, "github_token"), options.deviceAuth ? "\n" : "github-private-token-sentinel\n")
  await fs.writeFile(path.join(appDir, "copilot_token.json"), JSON.stringify({
    token: oldToken, refreshedAt: options.expiredToken ? 0 : Date.now(), refreshIn: 86400,
  }))

  const run = async (args = ["models"], env: NodeJS.ProcessEnv = {}) => {
    // The child's fetch only answers GitHub auth URLs; anything else throws
    // UNEXPECTED_NETWORK_ACCESS, which the checks below must never see.
    const script = `
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url === "https://api.github.com/user") return Response.json({ login: "test" });
        ${options.deviceAuth ? `
          if (url === "https://github.com/login/device/code") return Response.json({ device_code: "DEVICE_PRIVATE", expires_in: 600, interval: 0, user_code: "FIXTURE-CODE", verification_uri: "https://github.com/login/device" });
          if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "github-private-token-sentinel" });
        ` : ''}
        if (url === "https://api.github.com/copilot_internal/v2/token") {
          ${options.failRefresh ? 'throw new Error("auth-private-error-sentinel");' : `return Response.json({ token: ${JSON.stringify(newToken)}, refresh_in: 86400 });`}
        }
        throw new Error("UNEXPECTED_NETWORK_ACCESS");
      };
      ${options.interrupt ? `
        process.stdin.once("data", () => {
          if (!process.emit("SIGINT")) throw new Error("PROBE_INTERRUPT_HANDLER_NOT_READY");
          console.log("PROBE_INTERRUPT_DELIVERED");
          process.stdin.pause();
        });
      ` : ''}
      ${options.controlledProbeTimeout ? `
        const timeout = AbortSignal.timeout;
        const probes = [];
        AbortSignal.timeout = (ms) => {
          if (ms !== 10000) return timeout(ms);
          const controller = new AbortController();
          probes.push(controller);
          return controller.signal;
        };
        process.stdin.once("data", () => {
          if (probes.length !== 1) throw new Error("PROBE_DEADLINE_NOT_READY");
          probes[0].abort(new DOMException("Controlled probe deadline", "TimeoutError"));
          console.log("PROBE_DEADLINE_DELIVERED");
          process.stdin.pause();
        });
      ` : ''}
      process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entry))}, ...${JSON.stringify(args)}];
      try {
        await import(${JSON.stringify(entry.href)});
        ${options.controlledProbeTimeout ? `
          if (probes.length !== 2 || !probes[0].signal.aborted || probes[1].signal.aborted) {
            throw new Error("PROBE_DEADLINES_NOT_INDEPENDENT");
          }
          console.log("PROBE_DEADLINES_INDEPENDENT");
        ` : ''}
      } finally {
        ${options.controlledProbeTimeout ? 'AbortSignal.timeout = timeout;' : ''}
      }
    `
    const result = await new Promise<{ code: number; rawStdout: string; stdout: string; output: string }>((resolve, reject) => {
      const child = execFile(process.execPath, [
        "--import", "tsx", "--input-type=module", "--eval", script,
      ], {
        cwd, timeout: 15_000,
        env: { ...process.env, NO_COLOR: "1", ...env, HOME: home, USERPROFILE: home },
      }, (error, stdout, stderr) => {
        const code = error ? error.code : 0
        if (error?.killed || typeof code !== "number") {
          reject(error ?? new Error("Missing CLI exit code"))
          return
        }

        resolve({ code, rawStdout: stdout, stdout: stripVTControlCharacters(stdout), output: stripVTControlCharacters(stdout + stderr) })
      })
      if (options.interrupt || options.controlledProbeTimeout) {
        notifyFirstProbe = () => child.stdin!.end("probe-started\n")
      } else {
        child.stdin?.end()
      }
    })

    // Every run: no secret in output or logs, no relay started or pid file left, Claude settings
    // and configured models unchanged, and upstream reached only at /models or the probe endpoints.
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

    return { ...result, logs }
  }

  return { run, requests, server, home }
}

const respond = (response: ServerResponse, payload: unknown, status = 200) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(payload))
}

test("models help is registered without upstream access in CI rendering", async (t) => {
  const harness = await fixture(t, (_request, response) => respond(response, { data: [] }))
  const env = { CI: "true", FORCE_COLOR: "0" }

  const help = await harness.run(["--help"], env)

  assert.equal(help.code, 0)
  assert.match(help.stdout, /^\s*`?models`?\s+List upstream models;.*$/mi)

  const commandHelp = await harness.run(["models", "--help"], env)

  assert.equal(commandHelp.code, 0)
  assert.match(commandHelp.stdout, /upstream/i)
  assert.match(commandHelp.stdout, /--deep/)
  assert.equal(harness.requests.length, 0)
})

test("models lists the fresh full catalog with sorted exact IDs, independent of configured models", async (t) => {
  let catalog: unknown = { data: [
    { id: "z-chat" }, { id: "a-embedding" }, { id: "gpt-example" },
    { id: "gpt-example" }, null, {}, { id: 7 }, { id: "" },
    { id: "b-no-limits", capabilities: { limits: "invalid" } },
  ] }
  const harness = await fixture(t, (_request, response) => respond(response, catalog))

  const result = await harness.run()

  assert.equal(result.code, 0)
  assert.match(result.stdout, /Upstream-advertised models \(4\):\na-embedding\nb-no-limits\ngpt-example\nz-chat\n/)
  assert.match(result.stdout, /not verified/i)
  assert.doesNotMatch(result.stdout, /\[1m\]|missing-gpt-model|missing-opus-model/)
  assert.deepEqual(harness.requests.map((request) => request.authorization), [`Bearer ${oldToken}`])

  // A second run must fetch the catalog again rather than reuse the first listing.
  catalog = { data: [{ id: "newly-advertised" }] }
  const fresh = await harness.run()

  assert.equal(fresh.code, 0)
  assert.match(fresh.stdout, /Upstream-advertised models \(1\):\nnewly-advertised\n/)
  assert.doesNotMatch(fresh.stdout, /a-embedding|z-chat/)
  assert.equal(harness.requests.length, 2)
})

test("models sanitizes terminal controls and redacts sensitive URLs in upstream IDs", async (t) => {
  const harness = await fixture(t, (request, response) => respond(response, { data: [
    { id: "a-\u001b[2K\u001b[1Aexample\r\nforged-row" },
    { id: `http://${request.headers.host}${secretPath}/model` },
  ] }))

  const result = await harness.run()

  assert.equal(result.code, 0)
  const listing = result.rawStdout.slice(result.rawStdout.indexOf("Upstream-advertised models"))
  assert.doesNotMatch(listing, /\u001b|\r/)
  assert.match(listing, /a-exampleforged-row\n/)
  assert.match(listing, /http:\/\/127\.0\.0\.1:\d+\[redacted\]/)
})

test("models reports an empty catalog successfully", async (t) => {
  const harness = await fixture(t, (_request, response) => respond(response, { data: [] }))

  const result = await harness.run()

  assert.equal(result.code, 0)
  assert.match(result.stdout, /No models advertised by upstream/)
})

for (const payload of [{ models: [] }, { data: null }, { data: "payload-private-sentinel" }]) {
  test(`models rejects a malformed catalog: ${JSON.stringify(payload)}`, async (t) => {
    const harness = await fixture(t, (_request, response) => respond(response, payload))

    const result = await harness.run()

    assert.equal(result.code, 1)
    assert.match(result.output, /Could not fetch upstream model catalog/)
    assert.doesNotMatch(result.stdout, /Upstream-advertised models|No models advertised/)
  })
}

test("models rejects invalid JSON without leaking the response body", async (t) => {
  const harness = await fixture(t, (_request, response) => response.end("payload-private-sentinel invalid JSON"))

  const result = await harness.run()

  assert.equal(result.code, 1)
  assert.match(result.output, /Could not fetch upstream model catalog/)
})

for (const status of [403, 503, 504]) {
  test(`models reports genuine HTTP ${status} without response-body disclosure`, async (t) => {
    const harness = await fixture(t, (_request, response) => respond(response, { error: "payload-private-sentinel" }, status))

    const result = await harness.run()

    assert.equal(result.code, 1)
    assert.match(result.output, new RegExp(`Could not fetch upstream model catalog: HTTP ${status}`))
    assert.doesNotMatch(result.output, /request timed out/)
    assert.equal(harness.requests.length, status >= 500 ? 2 : 1)
  })
}

test("models distinguishes a local deadline from an upstream HTTP 504", async (t) => {
  // The fake upstream never answers, so the CLI's own 1-second deadline fires.
  const harness = await fixture(t, () => {}, { timeout: 1 })

  const result = await harness.run()

  assert.equal(result.code, 1)
  assert.match(result.output, /Could not fetch upstream model catalog: request timed out/)
  assert.doesNotMatch(result.output, /HTTP 504/)
})

test("models returns a nonzero exit on connection failure", async (t) => {
  const harness = await fixture(t, () => {})
  await new Promise<void>((resolve) => harness.server.close(() => resolve()))

  const result = await harness.run()

  assert.equal(result.code, 1)
  assert.match(result.output, /Could not fetch upstream model catalog/)
})

test("models reuses bounded rejected-token recovery", async (t) => {
  // Reject the first catalog request; the retry carries the refreshed token.
  const harness = await fixture(t, (_request, response, attempt) => {
    respond(response, attempt === 1 ? {} : { data: [{ id: "recovered-model" }] }, attempt === 1 ? 401 : 200)
  })

  const result = await harness.run()

  assert.equal(result.code, 0)
  assert.match(result.stdout, /recovered-model/)
  assert.deepEqual(harness.requests.map((request) => request.authorization), [`Bearer ${oldToken}`, `Bearer ${newToken}`])
})

test("models fails safely when rejected-token recovery fails", async (t) => {
  const harness = await fixture(t, (_request, response) => respond(response, {}, 401), { failRefresh: true })

  const result = await harness.run()

  assert.equal(result.code, 1)
  assert.match(result.output, /Could not fetch upstream model catalog/)
  assert.equal(harness.requests.length, 1)
})

const deepCatalog = { data: [
  {
    id: "gpt-6-astra",
    supported_endpoints: ["/responses"],
    capabilities: {
      type: "chat",
      supports: { reasoning_effort: ["max", "low"] },
      limits: { max_context_window_tokens: 10000, max_prompt_tokens: 8000, max_output_tokens: 2000 }
    }
  },
  {
    id: "claude-opus-5.5",
    supported_endpoints: ["/chat/completions"],
    capabilities: { type: "chat", supports: { reasoning_effort: ["low", "max"] } }
  },
] }

async function requestBody(request: IncomingMessage): Promise<Record<string, any>> {
  let raw = ""
  for await (const chunk of request) {
    raw += chunk
  }

  return JSON.parse(raw)
}

// Answer in the request's protocol: Responses bodies carry `input`, Chat bodies carry `messages`.
const probeReply = (body: Record<string, any>, overrides: Record<string, unknown> = {}) => body.input !== undefined ? {
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
  const harness = await fixture(
    t,
    async (req, res) => {
      if (req.method === "GET") {
        return respond(res, deepCatalog)
      }

      const body = await requestBody(req)
      sent.push(body)
      respond(res, probeReply(body))
    },
    { deep: true }
  )

  const result = await harness.run(["models", "--deep"])

  assert.equal(result.code, 0)
  assert.match(result.stdout, /isolated relay pipeline/i)
  assert.match(result.stdout, /not running-daemon health/i)
  assert.match(result.stdout, /MODEL\s+STATUS\s+TIME\s+RESULT/)
  assert.match(result.stdout, /Summary: 2 passed/)
  assert.doesNotMatch(result.stdout, /0 failed|SENT\/REPORTED|Using cached|Next Copilot token refresh|send upstream|return from upstream/)
  assert.doesNotMatch(result.rawStdout, /\u001b/)
  for (const model of ["claude-opus-5.5", "gpt-6-astra"]) {
    assert.equal(result.stdout.split(model).length - 1, 1)
  }

  assert.doesNotMatch(result.output, /PRIVATE_PROBE_ANSWER/)
  assert.match(result.logs, /Using cached/)
  assert.match(result.logs, /GET \/models/)
  assert.deepEqual(sent.map((body) => body.model), ["claude-opus-5.5", "gpt-6-astra"])
  assert.equal(sent[0]?.reasoning_effort, "low")
  assert.equal(sent[1]?.reasoning.effort, "low")
  assert.equal(sent[1]?.max_output_tokens, 2000)
  assert(sent.every((body) => !body.tools))
})

// Synthetic single-endpoint catalogs for the reported route-skipped IDs plus an unseen one.
const routeSkippedModels = [
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
  "grok-4.5",
  "grok-4.6",
  "grok-4.7",
  "mai-code-1.1-flash",
  "future-chat-model",
]

for (const endpoint of ["/chat/completions", "/responses"]) {
  test(`deep CLI selects advertised ${endpoint} for skipped and future model IDs`, async (t) => {
    const sent: string[] = []
    const catalog = {
      data: routeSkippedModels.map((id) => ({
        id,
        supported_endpoints: [endpoint],
        capabilities: { type: "chat", supports: { reasoning_effort: ["low"] } },
      })),
    }

    const harness = await fixture(
      t,
      async (req, res) => {
        if (req.method === "GET") {
          return respond(res, catalog)
        }

        const body = await requestBody(req)
        sent.push(body.model)
        assert.equal(req.url, `${secretPath}${endpoint}`)
        respond(res, probeReply(body))
      },
      { deep: true, logLevel: "info" }
    )

    const result = await harness.run(["models", "--deep", "--details"])

    assert.equal(result.code, 0, result.output)
    assert.deepEqual(sent, [...routeSkippedModels].sort())
    assert.match(result.stdout, /Summary: 10 passed/)
    assert.match(result.stdout, /route_source=catalog/)
    assert.doesNotMatch(result.stdout, /SKIPPED|Unsupported route/)
    assert.equal(harness.requests.filter((request) => request.method === "POST").length, routeSkippedModels.length)
  })
}

for (const capability of [false, []]) {
  test(`deep CLI omits effort for explicit non-reasoning capability ${JSON.stringify(capability)}`, async (t) => {
    const catalog = {
      data: [{
        id: "plain-chat",
        supported_endpoints: ["/chat/completions"],
        capabilities: { type: "chat", supports: { reasoning_effort: capability } },
      }],
    }

    const harness = await fixture(
      t,
      async (req, res) => {
        if (req.method === "GET") {
          return respond(res, catalog)
        }

        const body = await requestBody(req)
        assert.equal(body.reasoning_effort, undefined)
        respond(res, probeReply(body))
      },
      { deep: true, logLevel: "info" }
    )

    const result = await harness.run(["models", "--deep", "--details"])

    assert.equal(result.code, 0, result.output)
    assert.match(result.stdout, /effort=omitted/)
    assert.match(result.stdout, /Summary: 1 passed/)

    // An explicit override is a user request the model cannot honor, so it is skipped unsent.
    const explicit = await harness.run(["models", "--deep", "--effort", "none"])

    assert.equal(explicit.code, 2)
    assert.match(explicit.stdout, /Unsupported effort/)
    assert.equal(harness.requests.filter((request) => request.method === "POST").length, 1)
  })
}

test("deep details distinguish unavailable endpoints without leaking catalog strings", async (t) => {
  const catalog = {
    data: [
      { id: "empty-routes", supported_endpoints: [] },
      // Unknown endpoint strings are untrusted; only their count may be printed.
      { id: "unknown-routes", supported_endpoints: [`https://hidden.invalid/${oldToken}`, "/internal-secret\u001b[31m"] },
      { id: "claude-native-only", supported_endpoints: ["/v1/messages"] },
    ],
  }

  const harness = await fixture(t, (_req, res) => respond(res, catalog), { deep: true, logLevel: "info" })

  const result = await harness.run(["models", "--deep", "--details"])

  assert.equal(result.code, 2)
  assert.match(result.stdout, /No advertised route/)
  assert.match(result.stdout, /Unsupported route/)
  assert.match(result.stdout, /Protocol policy conflict/)
  assert.match(result.stdout, /advertised_endpoints=none-compatible unknown_endpoints=2/)
  assert.match(result.stdout, /advertised_endpoints=\/v1\/messages unknown_endpoints=0/)
  assert.doesNotMatch(result.output + result.logs, /hidden.invalid|internal-secret/)
  assert.equal(harness.requests.filter((request) => request.method === "POST").length, 0)
})

test("quiet deep setup still presents device login instructions once", async (t) => {
  const harness = await fixture(
    t,
    async (req, res) => {
      if (req.method === "GET") {
        return respond(res, deepCatalog)
      }

      respond(res, probeReply(await requestBody(req)))
    },
    { deep: true, deviceAuth: true }
  )

  const result = await harness.run(["models", "--deep"])

  assert.equal(result.code, 0)
  assert.equal(result.output.split("FIXTURE-CODE").length - 1, 1)
  assert.match(result.output, /Sign in: open https:\/\/github.com\/login\/device/)
  assert.doesNotMatch(result.output, /DEVICE_PRIVATE|Using cached|token synced|Next Copilot token refresh/)
})

for (const logLevel of ["info", "debug"] as const) {
  test(`deep details report safe refusal evidence with capture ${logLevel}`, async (t) => {
    const harness = await fixture(
      t,
      async (req, res) => {
        if (req.method === "GET") {
          return respond(res, deepCatalog)
        }

        const body = await requestBody(req)
        res.setHeader("x-github-request-id", "provider-fixture-123")
        // x-request-id carries a secret sentinel that must never reach output or logs.
        res.setHeader("x-request-id", oldToken)
        respond(res, probeReply(body, {
          id: "msg_refusal_fixture",
          choices: [{ index: 0, message: { role: "assistant", content: "PRIVATE_REFUSAL" }, finish_reason: "content_filter" }]
        }))
      },
      { deep: true, logLevel }
    )

    const result = await harness.run(["models", "--deep", "--model", "claude-opus-5.5", "--details"])

    assert.equal(result.code, 2)
    assert.match(result.stdout, /Refused/)
    assert.match(result.stdout, /upstream_http=200/)
    assert.match(result.stdout, /outcome=content_filter/)
    assert.match(result.stdout, /provider_request_id=provider-fixture-123/)
    assert.match(result.stdout, /message_id=msg_refusal_fixture/)

    const id = result.stdout.match(/request_id=([a-f0-9-]{36})/)?.[1]
    assert(id)
    assert.match(result.logs, new RegExp(`request_id=${id} model_probe`))
    assert.doesNotMatch(result.output + result.logs, /PRIVATE_REFUSAL|old-private-token-sentinel/)

    // Only debug logging records a capture, so only it can offer an offline replay.
    if (logLevel === "debug") {
      assert.match(result.stdout, new RegExp(`Offline replay: copilot-relay replay ${id}`))
    } else {
      assert.match(result.stdout, /capture=off/)
      assert.doesNotMatch(result.stdout, /Offline replay:/)
      await assert.rejects(fs.access(path.join(harness.home, ".copilot-relay", "captures")), { code: "ENOENT" })
    }
  })
}

test("deep details retain upstream HTTP failures instead of relabeling them as local", async (t) => {
  const harness = await fixture(
    t,
    (req, res) => req.method === "GET" ? respond(res, deepCatalog) : respond(res, { error: { message: "PRIVATE_HTTP_BODY" } }, 500),
    { deep: true }
  )

  const result = await harness.run(["models", "--deep", "--model", "claude-opus-5.5", "--details"])

  assert.equal(result.code, 2)
  assert.match(result.stdout, /HTTP 500/)
  assert.match(result.stdout, /upstream_http=500/)
  assert.doesNotMatch(result.stdout, /Unknown API error|PRIVATE_HTTP_BODY/)
  assert.equal(harness.requests.filter((request) => request.method === "POST").length, 2)
})

test("a model ID matching a refreshed token is never printed", async (t) => {
  // The only model ID equals the token the CLI refreshes to after the first probe's 401.
  let attempts = 0
  const harness = await fixture(
    t,
    async (req, res) => {
      if (req.method === "GET") {
        return respond(res, { data: [{ id: newToken }] })
      }

      const body = await requestBody(req)
      if (++attempts === 1) {
        return respond(res, {}, 401)
      }

      respond(res, probeReply(body))
    },
    { deep: true }
  )

  const result = await harness.run(["models", "--deep", "--details"])

  assert.equal(result.code, 2)
  assert.match(result.stdout, /\[unsupported ID\]/)
  assert.doesNotMatch(result.output, /new-private-token-sentinel/)
})

test("deep details distinguish failed token refresh from generic internal errors", async (t) => {
  const harness = await fixture(
    t,
    (req, res) => req.method === "GET" ? respond(res, deepCatalog) : respond(res, {}, 401),
    { deep: true, failRefresh: true }
  )

  const result = await harness.run(["models", "--deep", "--model", "claude-opus-5.5", "--details"])

  assert.equal(result.code, 2)
  assert.match(result.stdout, /Token refresh failed/)
  assert.match(result.stdout, /refresh=failure/)
  assert.match(result.stdout, /upstream_http=401/)
  assert.equal(harness.requests.filter((request) => request.method === "POST").length, 1)
})

for (const [name, env, colored] of [
  ["forced", { FORCE_COLOR: "1", NO_COLOR: undefined }, true],
  ["disabled", { FORCE_COLOR: "0", NO_COLOR: undefined }, false],
  ["NO_COLOR wins", { FORCE_COLOR: "1", NO_COLOR: "1" }, false],
  ["pipe in CI", { FORCE_COLOR: undefined, NO_COLOR: undefined, CI: "true" }, false],
] as const) {
  test(`models deep color policy: ${name}`, async (t) => {
    const harness = await fixture(
      t,
      async (req, res) => {
        if (req.method === "GET") {
          return respond(res, deepCatalog)
        }

        respond(res, probeReply(await requestBody(req)))
      },
      { deep: true }
    )

    const result = await harness.run(["models", "--deep"], env)

    assert.equal(result.code, 0)
    assert.equal(/\u001b\[32mPASS\u001b\[0m/.test(result.rawStdout), colored)
    if (!colored) {
      assert.doesNotMatch(result.rawStdout, /\u001b/)
    }

    assert.match(result.stdout, /MODEL\s+STATUS\s+TIME\s+RESULT/)
    assert.equal(harness.requests.filter((request) => request.method === "POST").length, 2)
  })
}

test("models deep selection sends only the selected exact model", async (t) => {
  const sent: string[] = []
  const harness = await fixture(
    t,
    async (req, res) => {
      if (req.method === "GET") {
        return respond(res, deepCatalog)
      }

      const body = await requestBody(req)
      sent.push(body.model)
      respond(res, probeReply(body))
    },
    { deep: true }
  )

  const result = await harness.run(["models", "--deep", "--model", "gpt-6-astra", "--effort", "max", "--max-tokens", "64", "--details"])

  assert.equal(result.code, 0)
  assert.deepEqual(sent, ["gpt-6-astra"])
  assert.match(result.stdout, /effort=max/)
  assert.match(result.stdout, /max_tokens=64/)
  assert.match(result.stdout, /route=\/responses/)
  assert.match(result.stdout, /request_id=[a-f0-9-]{36}/)
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
    const harness = await fixture(
      t,
      async (req, res) => {
        if (req.method === "GET") {
          return respond(res, deepCatalog)
        }

        respond(res, probeReply(await requestBody(req), overrides))
      },
      { deep: true }
    )

    const result = await harness.run(["models", "--deep", "--model", "gpt-6-astra"])

    assert.equal(result.code, 2)
    assert.match(result.stdout, new RegExp(status))
    assert.match(result.stdout, status === "INCOMPLETE" ? /Summary: 1 incomplete/ : /Summary: 1 failed/)
    assert.doesNotMatch(result.stdout, /\bPASS\b/)
    assert.doesNotMatch(result.output, /PRIVATE_PROBE_ANSWER/)
  })
}

test("models deep skips explicit unsupported capabilities without inference", async (t) => {
  const harness = await fixture(
    t,
    (_req, res) => respond(res, { data: [
      { id: "embedding", capabilities: { type: "embeddings" } },
      { id: "native-only", supported_endpoints: ["/v1/messages"] },
      { id: "high-only", capabilities: { supports: { reasoning_effort: ["high"] } } },
    ] }),
    { deep: true }
  )

  const result = await harness.run(["models", "--deep", "--effort", "low"])

  assert.equal(result.code, 2)
  assert.match(result.stdout, /3 skipped/)
  assert.equal(harness.requests.length, 1)
})

for (const args of [
  ["--details"],
  ["--model", "gpt-6-astra"],
  ["--deep", "--timeout", "0"],
  ["--deep", "--max-tokens", "NaN"],
  ["--deep", "--effort", "invalid"],
  ["--deep", "--model", "missing"]
]) {
  test(`models rejects invalid selection/options ${args.join(" ")}`, async (t) => {
    const harness = await fixture(t, (_req, res) => respond(res, deepCatalog), { deep: true })

    const result = await harness.run(["models", ...args])

    assert.equal(result.code, 1)
    assert.equal(harness.requests.filter((request) => request.method === "POST").length, 0)
  })
}

test("models deep handles HTTP errors without leaking shared pipeline logs", async (t) => {
  const harness = await fixture(
    t,
    (req, res) => req.method === "GET"
      ? respond(res, deepCatalog)
      : respond(res, { error: { message: "payload-private-sentinel" } }, 429),
    { deep: true }
  )

  const result = await harness.run(["models", "--deep"])

  assert.equal(result.code, 2)
  assert.match(result.stdout, /Rate limited \(429\)/)
  assert.match(result.stdout, /2 failed/)
  assert.equal((result.stdout.match(/Rate limit: wait/g) ?? []).length, 1)
  assert.equal((result.stdout.match(/request_id=[a-f0-9-]{36}/g) ?? []).length, 2)
})

for (const interrupt of [false, true]) {
  test(`models deep stops remaining probes on ${interrupt ? "interruption" : "total deadline"}`, async (t) => {
    // The fake upstream never answers a probe, so only the interrupt or the total deadline ends the run.
    const harness = await fixture(
      t,
      (req, res) => {
        if (req.method === "GET") {
          respond(res, deepCatalog)
        }
      },
      { deep: true, interrupt }
    )

    const result = await harness.run(["models", "--deep", "--timeout", "5", "--total-timeout", interrupt ? "10" : "1"])

    assert.equal(result.code, interrupt ? 130 : 2)
    if (interrupt) {
      assert.match(result.stdout, /PROBE_INTERRUPT_DELIVERED/)
      assert.match(result.stdout, /Cancelled/)
      assert.doesNotMatch(result.output, /PROBE_INTERRUPT_HANDLER_NOT_READY/)
    }

    assert.match(result.stdout, /claude-opus-5\.5\s+NOT_TESTED/)
    assert.match(result.stdout, /Summary: 2 not tested/)
    assert.doesNotMatch(result.stdout, /\bFAIL\b|\bPASS\b/)
    assert.equal(harness.requests.filter((request) => request.method === "POST").length, 1)
  })
}

test("models deep continues after a per-model timeout", async (t) => {
  // Only gpt-6-astra's probe is answered; claude-opus-5.5's hangs until the controlled deadline aborts it.
  const harness = await fixture(
    t,
    async (req, res) => {
      if (req.method === "GET") {
        return respond(res, deepCatalog)
      }

      const body = await requestBody(req)
      if (body.model === "gpt-6-astra") {
        respond(res, probeReply(body))
      }
    },
    { deep: true, timeout: 0, controlledProbeTimeout: true }
  )

  const result = await harness.run(["models", "--deep", "--timeout", "10"])

  assert.equal(result.code, 2)
  assert.match(result.stdout, /PROBE_DEADLINE_DELIVERED/)
  assert.match(result.stdout, /PROBE_DEADLINES_INDEPENDENT/)
  assert.match(result.stdout, /claude-opus-5\.5\s+FAIL[^\n]+Timed out/)
  assert.match(result.stdout, /gpt-6-astra\s+PASS[^\n]+Ready/)
  assert.match(result.stdout, /Summary: 1 passed · 1 failed/)
  assert.equal(harness.requests.filter((request) => request.method === "POST").length, 2)
})

test("models deep recovers a rejected inference token without printing response bodies", async (t) => {
  const authorizations: string[] = []
  const harness = await fixture(
    t,
    async (req, res) => {
      if (req.method === "GET") {
        return respond(res, deepCatalog)
      }

      const body = await requestBody(req)
      authorizations.push(req.headers.authorization ?? "")
      if (authorizations.length === 1) {
        return respond(res, {}, 401)
      }

      respond(res, probeReply(body))
    },
    { deep: true }
  )

  const result = await harness.run(["models", "--deep", "--model", "gpt-6-astra"])

  assert.equal(result.code, 0)
  assert.deepEqual(authorizations, [`Bearer ${oldToken}`, `Bearer ${newToken}`])
  assert.doesNotMatch(result.output, /PRIVATE_PROBE_ANSWER/)
})

test("models deep empty catalog has no successful checks", async (t) => {
  const harness = await fixture(t, (_req, res) => respond(res, { data: [] }), { deep: true })

  const result = await harness.run(["models", "--deep"])

  assert.equal(result.code, 2)
  assert.match(result.stdout, /Summary: no models to test/)
  assert.equal(harness.requests.length, 1)
})

test("models deep rejects explicit chat refusals even alongside text", async (t) => {
  const harness = await fixture(
    t,
    async (req, res) => {
      if (req.method === "GET") {
        return respond(res, deepCatalog)
      }

      const body = await requestBody(req)
      respond(res, probeReply(body, {
        choices: [{
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant", content: "partial", refusal: "PRIVATE_REFUSAL",
          }
        }]
      }))
    },
    { deep: true }
  )

  const result = await harness.run(["models", "--deep", "--model", "claude-opus-5.5"])

  assert.equal(result.code, 2)
  assert.match(result.stdout, /Refused/)
  assert.doesNotMatch(result.output, /PRIVATE_REFUSAL/)
})

test("models deep missing metadata is explicitly unverified", async (t) => {
  const harness = await fixture(
    t,
    async (req, res) => {
      if (req.method === "GET") {
        return respond(res, { data: [{ id: "claude-opus-5.5" }] })
      }

      const body = await requestBody(req)
      assert.equal(body.reasoning_effort, "low")
      respond(res, probeReply(body))
    },
    { deep: true }
  )

  const result = await harness.run(["models", "--deep"])

  assert.equal(result.code, 0)
  assert.match(result.stdout, /Ready \*/)
  assert.match(result.stdout, /Effort or endpoint metadata is unverified/)
})

test("models fails safely during initial authentication", async (t) => {
  const harness = await fixture(t, () => {}, { failRefresh: true, expiredToken: true })

  const result = await harness.run()

  assert.equal(result.code, 1)
  assert.match(result.output, /Could not authenticate with GitHub Copilot/)
  assert.equal(harness.requests.length, 0)
})
