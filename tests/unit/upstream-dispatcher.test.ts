import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { inspect } from "node:util"

import { Agent, EnvHttpProxyAgent, ProxyAgent } from "undici"

import {
  closedPort,
  redirectGitHubTo,
  refuseExternalConnections,
  replyJson,
  startEchoingProxy,
  startFakeGitHub,
  withProxyEnvironment,
} from "../fixtures/network"

// See log-rotation.test.ts: the home directory must be redirected before
// paths.ts loads, and Windows resolves it from USERPROFILE rather than HOME.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-dispatcher-test-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const {
  buildUpstreamDispatcher,
  configureUpstreamDispatcher,
  fetchUpstream,
  getUpstreamDispatcher,
} = await import("../../src/lib/upstream-dispatcher")
const { setupProxyAuth } = await import("../../src/lib/auth")
const { flushLogs, log } = await import("../../src/lib/log")
const { paths } = await import("../../src/lib/paths")
type ProxyConfig = import("../../src/lib/config").ProxyConfig

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

// Why: before #153 every upstream call connected directly. Until a command has read its config,
// that must stay so, whatever proxy variables are set.
test("upstream calls connect directly until a command configures the dispatcher", () => {
  assert.equal(getUpstreamDispatcher().constructor, Agent)
})

// Why: each form of the key must build the dispatcher it names: direct, the proxy variables, or
// one proxy URL.
test("each upstreamProxy value builds its dispatcher kind", async () => {
  const dispatchers = await withProxyEnvironment({}, () => [
    buildUpstreamDispatcher(undefined),
    buildUpstreamDispatcher("env"),
    buildUpstreamDispatcher("http://proxy.example:3128"),
    buildUpstreamDispatcher("https://proxy.example:3128"),
    buildUpstreamDispatcher("http://user:p%40ss@proxy.example:3128"),
  ])

  assert.deepEqual(
    dispatchers.map((dispatcher) => dispatcher.constructor),
    [Agent, EnvHttpProxyAgent, ProxyAgent, ProxyAgent, ProxyAgent],
  )

  await Promise.all(dispatchers.map((dispatcher) => dispatcher.close()))
})

// Why: with upstreamProxy: env the proxy URL comes from the environment and can carry a password.
// undici's own error repeats the value, and this error reaches the terminal and the log.
test("a malformed proxy variable is reported by rule, never by value", async () => {
  await withProxyEnvironment({ HTTPS_PROXY: "http://user:SECRET_SENTINEL@[bad" }, () => {
    assert.throws(
      () => buildUpstreamDispatcher("env"),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Invalid HTTPS_PROXY or HTTP_PROXY/)
        assert.doesNotMatch(inspect(error), /SECRET_SENTINEL/)
        return true
      },
    )
  })
})

// Why: upstreamProxy defaults to empty, so after an upgrade an install that relied on HTTPS_PROXY
// connects directly. Where only the proxy reaches the internet, that fails without a response and
// nothing says why; the hint names the fix. Once per process, and never for a configured proxy or
// a cancelled request, which are different failures.
test("a direct failure while a proxy variable is set logs the upstreamProxy hint once", async (t) => {
  const errors: string[] = []
  t.mock.method(log, "error", (...values: unknown[]) => {
    errors.push(values.join(" "))
  })
  const unreachable = `http://127.0.0.1:${await closedPort()}/models`

  await withProxyEnvironment({ HTTPS_PROXY: "http://proxy.example:3128" }, async () => {
    configureUpstreamDispatcher(`http://127.0.0.1:${await closedPort()}`)
    await assert.rejects(fetchUpstream(unreachable, {}))
    assert.deepEqual(errors, [], "a configured proxy failed, not an ignored one")

    configureUpstreamDispatcher(undefined)
    await assert.rejects(fetchUpstream(unreachable, { signal: AbortSignal.abort() }), { name: "AbortError" })
    assert.deepEqual(errors, [], "a cancelled request is not a connection failure")

    await assert.rejects(fetchUpstream(unreachable, {}))
    await assert.rejects(fetchUpstream(unreachable, {}))
  })

  assert.equal(errors.length, 1)
  assert.match(errors[0], /HTTPS_PROXY or HTTP_PROXY is set, but upstreamProxy is empty/)
  assert.ok(errors[0].includes(`set upstreamProxy: env in ${paths.configPath}`), errors[0])
})

// Why: before #153 sign-in used the global fetch, which ignores the relay's dispatcher, so a user
// behind a proxy could not sign in. Device login, the token poll, the Copilot token exchange and
// the user lookup must all go through the dispatcher every Copilot call uses.
test("GitHub sign-in uses the shared upstream dispatcher", async (t) => {
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("GitHub must not be called through the global fetch")
  })
  configureUpstreamDispatcher(undefined)

  const github = await startFakeGitHub((url, _request, response) => {
    if (url.href === "https://github.com/login/device/code") {
      replyJson(response, {
        device_code: "DEVICE_FIXTURE",
        expires_in: 600,
        interval: 0,
        user_code: "USER-FIXTURE",
        verification_uri: "https://github.com/login/device",
      })
    } else if (url.href === "https://github.com/login/oauth/access_token") {
      replyJson(response, { access_token: "github-token-fixture" })
    } else if (url.href === "https://api.github.com/copilot_internal/v2/token") {
      replyJson(response, { token: "copilot-token-fixture", refresh_in: 3600 })
    } else if (url.href === "https://api.github.com/user") {
      replyJson(response, { login: "fixture-user" })
    } else {
      replyJson(response, {}, 404)
    }
  })
  const redirect = redirectGitHubTo(github.origin)
  const restoreConnections = refuseExternalConnections()
  t.after(async () => {
    restoreConnections()
    redirect.restore()
    await github.close()
  })

  const config: ProxyConfig = {
    copilotBaseUrl: "http://127.0.0.1:1",
    copilotToken: undefined,
    host: "127.0.0.1",
    port: 0,
    upstreamTimeoutMs: 5000,
    vsCodeVersion: "1.99.3",
  }
  const session = await setupProxyAuth(config, { force: true, onDeviceCode: () => {} })

  assert.equal(session.githubLogin, "fixture-user")
  assert.equal(config.copilotToken, "copilot-token-fixture")

  const sent = redirect.calls.map((call) => `${call.method} ${call.url}`)
  assert.deepEqual(sent, [
    "POST https://github.com/login/device/code",
    "POST https://github.com/login/oauth/access_token",
    "GET https://api.github.com/copilot_internal/v2/token",
    "GET https://api.github.com/user",
  ])
  for (const call of redirect.calls) {
    assert.equal(call.dispatcher, getUpstreamDispatcher())
  }

  assert.deepEqual(github.requests, sent)
})

// What `promise` rejects with. A promise that resolves fails the test.
const rejectionOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise
  } catch (error) {
    return error
  }

  throw new Error("Expected a rejection")
}

// Why (#168): a proxy that answers CONNECT with a reply undici cannot parse leaves the unparsed rest
// in the error, and a reply that echoes Proxy-Authorization would carry the password, raw and in
// Basic form, into every log line that prints the error. Both proxy modes.
test("a malformed CONNECT reply that echoes the proxy password leaves none of it in the error", async (t) => {
  const proxy = await startEchoingProxy()
  const restoreConnections = refuseExternalConnections()
  t.after(async () => {
    configureUpstreamDispatcher(undefined)
    restoreConnections()
    await proxy.close()
  })
  const proxyUrl = proxy.url.replace("http://", "http://echo-user:echo-secret@")
  const basic = Buffer.from("echo-user:echo-secret").toString("base64")
  const modes: Array<{ label: string; upstreamProxy: string; variables: Record<string, string> }> = [
    { label: "URL", upstreamProxy: proxyUrl, variables: {} },
    { label: "env", upstreamProxy: "env", variables: { HTTPS_PROXY: proxyUrl } },
  ]

  for (const { label, upstreamProxy, variables } of modes) {
    const error = await withProxyEnvironment(variables, () => {
      configureUpstreamDispatcher(upstreamProxy)
      return rejectionOf(fetchUpstream("https://copilot.invalid/models", {}))
    })

    assert.ok(error instanceof TypeError, `${label}: ${String(error)}`)
    const cause = error.cause as Error
    assert.equal(cause.name, "HTTPParserError", label)
    assert.ok(!Object.hasOwn(cause, "data"), `${label}: the unparsed reply was kept`)
    const text = inspect(error, { depth: 8 })
    assert.ok(!text.includes("echo-secret"), `${label}: ${text}`)
    assert.ok(!text.includes(basic), `${label}: ${text}`)
  }

  assert.deepEqual(proxy.targets, ["copilot.invalid:443", "copilot.invalid:443"])
})

// Why (#168): the error is cleaned in place, so callers still read its type, code and cause; usage
// names a failure by its cause's message or code. Credentials are replaced in its messages even
// when they are too short to register with the log redaction: only this error changes.
test("a transport error keeps its type, code and cause but loses every form of the proxy credentials", async (t) => {
  const failure = Object.assign(new Error("proxy said ab:cd, Basic YWI6Y2Q=, user ab, password cd"), {
    code: "ECONNRESET",
    data: "raw reply ab:cd",
  })
  const redirect = redirectGitHubTo(`http://127.0.0.1:${await closedPort()}`, () => failure)
  t.after(() => {
    redirect.restore()
    configureUpstreamDispatcher(undefined)
  })
  configureUpstreamDispatcher(`http://ab:cd@127.0.0.1:${await closedPort()}`)

  const error = await rejectionOf(fetchUpstream("https://api.github.com/user", {}))

  assert.ok(error instanceof TypeError, String(error))
  assert.equal(error.message, "fetch failed")
  assert.equal(error.cause, failure)
  assert.equal(failure.code, "ECONNRESET")
  assert.ok(!Object.hasOwn(failure, "data"), "the raw reply was kept")
  assert.equal(failure.message, "proxy said [redacted], Basic [redacted], user [redacted], password [redacted]")
  assert.doesNotMatch(String(failure.stack).split("\n")[0], /ab|cd|YWI6Y2Q=/)
})
