import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"

// paths.ts resolves the home directory when it is imported, so it is redirected first. Node reads
// USERPROFILE on Windows and HOME elsewhere, so both are set.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-usage-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { CopilotUsageError, loadCopilotUsage, parseCopilotUsage, renderCopilotUsage } = await import("../../src/lib/usage")
const { setupProxyAuth } = await import("../../src/lib/auth")
const { vscodeVersion } = await import("../../src/lib/config")
const { flushLogs } = await import("../../src/lib/log")
const { paths } = await import("../../src/lib/paths")
type ProxyConfig = import("../../src/lib/config").ProxyConfig

// The token file the tests write must be the temporary one.
assert.ok(paths.githubTokenPath.startsWith(home), paths.githubTokenPath)

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

// Never a real token. Every error path checks that it is not printed.
const token = "gho_fixture-private-token-sentinel"

const usageUrl = "https://api.github.com/copilot_internal/user"

// The shape of a copilot_internal/user answer, with made-up values. The account fields stand for
// what the command must never print.
const account = {
  login: "private-login-sentinel",
  analytics_tracking_id: "private-tracking-sentinel",
  organization_login_list: ["private-org-sentinel"],
  copilot_plan: "fixture-plan",
  access_type_sku: "fixture-sku",
  quota_reset_date: "2026-11-01",
  quota_snapshots: {
    chat: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100, overage_permitted: false, overage_count: 0, quota_id: "chat" },
    completions: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100, overage_permitted: false, overage_count: 0, quota_id: "completions" },
    premium_interactions: { unlimited: false, entitlement: 300, remaining: 150, percent_remaining: 50, overage_permitted: true, overage_count: 0, quota_id: "premium_interactions" },
  },
}

// The report for an answer, as plain text.
const report = (body: unknown): string => renderCopilotUsage(parseCopilotUsage(body)).join("\n")

// An answer whose quota_snapshots holds only premium_interactions, with these fields.
const premiumOnly = (snapshot: Record<string, unknown>) => ({
  ...account,
  quota_snapshots: { premium_interactions: snapshot },
})

test("the report lists the plan, the SKU and the reset date, then one line per quota", () => {
  const lines = renderCopilotUsage(parseCopilotUsage(account))

  assert.deepEqual(lines, [
    "Plan         fixture-plan",
    "SKU          fixture-sku",
    "Quota reset  2026-11-01",
    "",
    "chat                  unlimited; overage not permitted, overage count 0",
    "completions           unlimited; overage not permitted, overage count 0",
    "premium_interactions  150 of 300 remaining (50%); overage permitted, overage count 0",
  ])
})

test("an unlimited quota prints unlimited and its overage state", () => {
  const text = report(premiumOnly({ unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100, overage_permitted: false, overage_count: 0 }))

  assert.match(text, /^premium_interactions {2}unlimited; overage not permitted, overage count 0$/m)
})

test("a limited quota prints remaining of entitlement, GitHub's percent and the overage state", () => {
  const text = report(premiumOnly({ unlimited: false, entitlement: 300, remaining: 0, percent_remaining: 0, overage_permitted: true, overage_count: 25 }))

  assert.match(text, /^premium_interactions {2}0 of 300 remaining \(0%\); overage permitted, overage count 25$/m)
})

test("a token-billed quota adds credits_used", () => {
  const text = report(premiumOnly({
    unlimited: false,
    entitlement: 300,
    remaining: 150,
    percent_remaining: 50,
    overage_permitted: false,
    overage_count: 0,
    token_based_billing: true,
    credits_used: 12.5,
  }))

  assert.match(text, /^premium_interactions {2}150 of 300 remaining \(50%\); overage not permitted, overage count 0; credits used 12\.5$/m)
})

test("numbers print exactly as GitHub sent them, with nothing rounded or derived", () => {
  // percent_remaining deliberately disagrees with remaining and entitlement: the report shows
  // GitHub's percent, not one it worked out.
  const text = report(premiumOnly({ unlimited: false, entitlement: 100, remaining: 10, percent_remaining: 12.345, overage_permitted: false, overage_count: 0 }))

  assert.match(text, /^premium_interactions {2}10 of 100 remaining \(12\.345%\); /m)
})

test("an answer without quota_snapshots reports every known quota as not reported", () => {
  const text = report({ copilot_plan: "fixture-plan", access_type_sku: "fixture-sku", quota_reset_date: "2026-11-01" })

  assert.match(text, /^chat {18}not reported$/m)
  assert.match(text, /^completions {11}not reported$/m)
  assert.match(text, /^premium_interactions {2}not reported$/m)
})

test("a missing snapshot, field or heading is marked rather than guessed", () => {
  const text = report({ quota_snapshots: { chat: {} } })

  assert.match(text, /^Plan {9}not reported$/m)
  assert.match(text, /^SKU {10}not reported$/m)
  assert.match(text, /^Quota reset {2}not reported$/m)
  assert.match(text, /^chat {18}\? of \? remaining \(\?%\); overage \?, overage count \?$/m)
  assert.match(text, /^completions {11}not reported$/m)
})

test("a quota id the command does not know is shown after the known ones", () => {
  const usage = parseCopilotUsage({
    ...account,
    quota_snapshots: {
      future_quota: { unlimited: false, entitlement: 20, remaining: 5, percent_remaining: 25, overage_permitted: false, overage_count: 0 },
      ...account.quota_snapshots,
    },
  })

  assert.deepEqual(Object.keys(usage.quota_snapshots), ["chat", "completions", "premium_interactions", "future_quota"])
  assert.equal(renderCopilotUsage(usage).at(-1), "future_quota          5 of 20 remaining (25%); overage not permitted, overage count 0")
})

test("every string from the answer is made terminal-safe", () => {
  const usage = parseCopilotUsage({
    copilot_plan: "\u001b[31mfixture-plan\u001b[0m\u202e",
    access_type_sku: "fixture\u0007-sku",
    quota_reset_date: "2026-11-01\r\nForged: line",
    quota_snapshots: {
      "odd\u001b[2K_quota": { unlimited: true },
      "\u001b[0m": { unlimited: true },
      "ch\u200bat": { unlimited: true },
    },
  })

  const text = renderCopilotUsage(usage).join("\n")

  assert.equal(usage.copilot_plan, "fixture-plan")
  assert.equal(usage.access_type_sku, "fixture-sku")
  assert.equal(usage.quota_reset_date, "2026-11-01Forged: line")

  // An id that is blank once made safe is dropped, and one that then reads as a known id cannot
  // stand in for it.
  assert.deepEqual(Object.keys(usage.quota_snapshots), ["chat", "completions", "premium_interactions", "odd_quota"])
  assert.equal(usage.quota_snapshots.chat, null)
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b\u202e]/)
})

test("a field of an unexpected type counts as not reported", () => {
  const usage = parseCopilotUsage({
    copilot_plan: 42,
    quota_snapshots: {
      chat: "unlimited",
      premium_interactions: {
        unlimited: "false",
        entitlement: "300",
        remaining: null,
        percent_remaining: [50],
        overage_permitted: 1,
        overage_count: -2,
        credits_used: "12.5",
      },
    },
  })

  assert.equal(usage.copilot_plan, null)
  assert.equal(usage.quota_snapshots.chat, null)
  assert.deepEqual(usage.quota_snapshots.premium_interactions, {
    unlimited: null,
    entitlement: null,
    remaining: null,
    percent_remaining: null,
    overage_permitted: null,
    overage_count: -2,
    token_based_billing: null,
    credits_used: null,
  })
})

test("only a value that was not reported is colored", () => {
  const usage = parseCopilotUsage({ ...account, copilot_plan: undefined })

  const colored = renderCopilotUsage(usage, true).join("\n")

  assert.match(colored, /^Plan {9}\u001b\[90mnot reported\u001b\[0m$/m)
  assert.equal(colored.match(/\u001b\[/g)?.length, 2)
  assert.doesNotMatch(renderCopilotUsage(usage).join("\n"), /\u001b\[/)
})

test("the JSON form holds the plan and quota fields and nothing that identifies the account", () => {
  const json = JSON.stringify(parseCopilotUsage(account))

  assert.doesNotMatch(json, /private-|login|organization|tracking|quota_id/)
  assert.deepEqual(JSON.parse(json), {
    copilot_plan: "fixture-plan",
    access_type_sku: "fixture-sku",
    quota_reset_date: "2026-11-01",
    quota_snapshots: {
      chat: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100, overage_permitted: false, overage_count: 0, token_based_billing: null, credits_used: null },
      completions: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100, overage_permitted: false, overage_count: 0, token_based_billing: null, credits_used: null },
      premium_interactions: { unlimited: false, entitlement: 300, remaining: 150, percent_remaining: 50, overage_permitted: true, overage_count: 0, token_based_billing: null, credits_used: null },
    },
  })
})

test("an answer that is not a JSON object is refused", () => {
  for (const body of [null, [], "plan", 42]) {
    assert.throws(() => parseCopilotUsage(body), CopilotUsageError)
  }
})

// Writes the token file the way copilot-relay auth does, replacing whatever is at that path.
const storeToken = async (value: string): Promise<void> => {
  await fs.mkdir(paths.appDir, { recursive: true })
  await fs.rm(paths.githubTokenPath, { recursive: true, force: true })
  await fs.writeFile(paths.githubTokenPath, `${value}\n`)
}

// Stands in for GitHub for one test: records each request and answers it with `answer`. Nothing
// reaches the network.
const mockFetch = (t: TestContext, answer: (request: Request) => Response | Promise<Response>): Array<Request> => {
  const requests: Array<Request> = []

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init)
    requests.push(request)

    return answer(request)
  })

  return requests
}

test("the usage request is a GET of copilot_internal/user that carries the stored token", async (t) => {
  await storeToken(token)
  const requests = mockFetch(t, () => Response.json(account))

  await loadCopilotUsage()

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, usageUrl)
  assert.equal(requests[0].method, "GET")
  assert.equal(requests[0].headers.get("authorization"), `token ${token}`)
})

test("the usage request sends the headers the Copilot token exchange sends", async (t) => {
  await storeToken(token)
  const requests = mockFetch(t, (request) => {
    if (request.url === "https://api.github.com/copilot_internal/v2/token") {
      return Response.json({ token: "copilot-private-token-sentinel", refresh_in: 86_400 })
    }

    if (request.url === "https://api.github.com/user") {
      return Response.json({ login: "fixture" })
    }

    assert.equal(request.url, usageUrl, "No device authorization or other network call")

    return Response.json(account)
  })

  // The config the commands build with readProxyConfig, whose editor version is this constant.
  const config: ProxyConfig = {
    copilotBaseUrl: "https://fixture.invalid",
    copilotToken: undefined,
    host: "127.0.0.1",
    port: 0,
    upstreamTimeoutMs: 3000,
    vsCodeVersion: vscodeVersion,
  }

  await setupProxyAuth(config)
  await loadCopilotUsage()

  const headersOf = (url: string) => [...(requests.find((request) => request.url === url)?.headers ?? [])]
  const exchange = headersOf("https://api.github.com/copilot_internal/v2/token")

  assert.ok(exchange.length > 0)
  assert.deepEqual(headersOf(usageUrl), exchange)
})

// Runs the request and returns the line the command would print, which must be a single line
// without the token.
const failure = async (): Promise<string> => {
  try {
    await loadCopilotUsage()
  } catch (error) {
    assert.ok(error instanceof CopilotUsageError, String(error))
    assert.doesNotMatch(error.message, /[\r\n]/)
    assert.ok(!error.message.includes(token), "the token must never be printed")

    return error.message
  }

  throw new Error("The usage request was expected to fail.")
}

// For the failures that must come before any request.
const noNetwork = () => {
  throw new Error("UNEXPECTED_NETWORK_ACCESS")
}

test("without a stored token the command suggests copilot-relay auth and sends nothing", async (t) => {
  await fs.rm(paths.githubTokenPath, { recursive: true, force: true })
  const requests = mockFetch(t, noNetwork)

  const message = await failure()

  assert.match(message, /^No GitHub token is stored at .+github_token\. Sign in with copilot-relay auth\.$/)
  assert.equal(requests.length, 0)
  await assert.rejects(fs.access(paths.githubTokenPath), { code: "ENOENT" })
})

test("an empty token file counts as no token", async (t) => {
  await storeToken("")
  mockFetch(t, noNetwork)

  assert.match(await failure(), /^No GitHub token is stored at .+ Sign in with copilot-relay auth\.$/)
})

for (const status of [401, 403]) {
  test(`HTTP ${status} says GitHub rejected the token and suggests copilot-relay auth`, async (t) => {
    await storeToken(token)
    mockFetch(t, () => new Response("Bad credentials", { status }))

    assert.equal(
      await failure(),
      `GitHub rejected the stored token (HTTP ${status}). Sign in again with copilot-relay auth.`,
    )
  })
}

test("any other HTTP status is named", async (t) => {
  await storeToken(token)
  mockFetch(t, () => new Response("unavailable", { status: 500 }))

  assert.equal(await failure(), "GitHub answered the usage request with HTTP 500.")
})

test("a network error names its cause", async (t) => {
  await storeToken(token)
  mockFetch(t, () => {
    throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") })
  })

  assert.equal(await failure(), "Could not reach GitHub: getaddrinfo ENOTFOUND api.github.com")
})

test("a refused connection whose cause has no message is named by its code", async (t) => {
  await storeToken(token)
  mockFetch(t, () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new AggregateError([]), { code: "ECONNREFUSED" }) })
  })

  assert.equal(await failure(), "Could not reach GitHub: ECONNREFUSED")
})

test("an error that quotes the token is printed without it", async (t) => {
  await storeToken(token)

  // fetch quotes an invalid header value in its error, and the authorization header is one.
  mockFetch(t, () => {
    throw new TypeError(`Headers.append: "token ${token}" is an invalid header value.`)
  })

  assert.equal(await failure(), 'Could not reach GitHub: Headers.append: "token [redacted]" is an invalid header value.')
})

test("an error that quotes the token around a hidden character is printed without it", async (t) => {
  await storeToken(token)

  // terminalText drops the zero-width space and joins the token back up, so the line is redacted
  // after terminalText has run.
  mockFetch(t, () => {
    throw new TypeError("fetch failed", { cause: new Error(`upstream echoed ${token.slice(0, 4)}\u200b${token.slice(4)}`) })
  })

  assert.equal(await failure(), "Could not reach GitHub: upstream echoed [redacted]")
})

test("a request that gets no answer in time says how long it waited", async (t) => {
  await storeToken(token)
  mockFetch(t, () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
  })

  assert.equal(await failure(), "GitHub did not answer within 30 seconds.")
})

for (const body of ["<html>", "[]"]) {
  test(`an answer of ${body} is reported as not a JSON object`, async (t) => {
    await storeToken(token)
    mockFetch(t, () => new Response(body, { headers: { "content-type": "application/json" } }))

    assert.equal(await failure(), "GitHub's answer to the usage request was not a JSON object.")
  })
}

// Success answers that echo the token where the report or --json would print it.
const echoes: Array<[string, Record<string, unknown>]> = [
  ["copilot_plan", { ...account, copilot_plan: `plan ${token}` }],
  ["access_type_sku", { ...account, access_type_sku: token }],
  ["quota_reset_date", { ...account, quota_reset_date: token }],
  ["a quota id", { ...account, quota_snapshots: { ...account.quota_snapshots, [`quota-${token}`]: { unlimited: true } } }],
  ["copilot_plan behind a hidden character", { ...account, copilot_plan: `${token.slice(0, 4)}\u200b${token.slice(4)}` }],
]

for (const [where, body] of echoes) {
  test(`an answer that echoes the token in ${where} is refused, with none of it printed`, async (t) => {
    await storeToken(token)
    mockFetch(t, () => Response.json(body))

    assert.equal(await failure(), "GitHub's answer to the usage request contains the stored token, so none of it is printed.")
  })
}

test("a token with no visible character does not refuse every answer", async (t) => {
  // U+0085 is valid in a header value and terminalText removes it, so no printed text can show this
  // token, while every text contains its empty visible form.
  await storeToken("\u0085\u0085")
  mockFetch(t, () => Response.json(account))

  const usage = await loadCopilotUsage()

  assert.equal(usage.copilot_plan, "fixture-plan")
})

test("a token file that cannot be read is reported by its error code", async (t) => {
  await fs.rm(paths.githubTokenPath, { recursive: true, force: true })
  await fs.mkdir(paths.githubTokenPath, { recursive: true })
  mockFetch(t, noNetwork)

  assert.match(await failure(), /^Could not read the GitHub token at .+github_token: E[A-Z]+\.$/)
})
