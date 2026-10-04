import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import type { ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { fileURLToPath } from "node:url"

import {
  refuseExternalConnections,
  replyJson,
  startFakeGitHub,
  startRecordingProxy,
  withoutProxyVariables,
} from "../fixtures/network"

// The CLI runs in a child process against this temporary home, with a local server standing in for
// GitHub. paths.ts resolves the home directory when it is imported, so it is redirected first. Node
// reads USERPROFILE on Windows and HOME elsewhere, so both are set.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-usage-command-"))
process.env.HOME = home
process.env.USERPROFILE = home

const { paths } = await import("../../src/lib/paths")

assert.ok(paths.githubTokenPath.startsWith(home), paths.githubTokenPath)
assert.ok(paths.configPath.startsWith(home), paths.configPath)

const entry = new URL("../../src/main.ts", import.meta.url)
const networkFixture = new URL("../fixtures/network.ts", import.meta.url)
const cwd = fileURLToPath(new URL("../../", import.meta.url))

// Never a real token. Every run checks that it is not printed.
const token = "gho_fixture-private-token-sentinel"

const usageUrl = "https://api.github.com/copilot_internal/user"

// The ASCII letters and digits of a text, so a check also finds the token with separators inside.
const lettersAndDigits = (text: string): string => text.replace(/[^A-Za-z0-9]/g, "")

// A copilot_internal/user answer with made-up values. The account fields must never be printed.
const account = {
  login: "private-login-sentinel",
  analytics_tracking_id: "private-tracking-sentinel",
  organization_login_list: ["private-org-sentinel"],
  copilot_plan: "fixture-plan",
  access_type_sku: "fixture-sku",
  quota_reset_date: "2026-11-01",
  quota_snapshots: {
    chat: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100, overage_permitted: false, overage_count: 0 },
    completions: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100, overage_permitted: false, overage_count: 0 },
    premium_interactions: { unlimited: false, entitlement: 300, remaining: 150, percent_remaining: 50, overage_permitted: true, overage_count: 0, token_based_billing: true, credits_used: 12.5 },
  },
}

// How the stand-in answers the usage request in each scenario. Every scenario answers only a
// request that carries the stored token. The echoed and spread answers put the token, whole or in
// two pieces, where the report and --json would print it. offline is never answered: the child
// fails the request before it is sent.
const scenarios = {
  quota: (response: ServerResponse) => replyJson(response, account),
  echoedInPlan: (response: ServerResponse) => replyJson(response, { ...account, copilot_plan: token }),
  echoedInQuotaId: (response: ServerResponse) =>
    replyJson(response, { ...account, quota_snapshots: { ...account.quota_snapshots, [token]: { unlimited: true } } }),
  spreadOverPlanAndSku: (response: ServerResponse) =>
    replyJson(response, { ...account, copilot_plan: token.slice(0, 20), access_type_sku: token.slice(20) }),
  rejected: (response: ServerResponse) => {
    response.writeHead(401, { "content-type": "text/plain" })
    response.end("Bad credentials")
  },
  offline: (_response: ServerResponse) => {
    throw new Error("The offline scenario sends no request")
  },
}

type Scenario = keyof typeof scenarios

// The stand-in for GitHub. A request for anything but the usage URL, or one without the stored
// token, is recorded and its connection dropped. It is started before the first test(): node:test
// runs the after() hooks once every test registered so far has finished, which can happen during a
// later top-level await, and an after() hook registered after that never runs.
let currentScenario: Scenario = "quota"
const unexpectedGitHub: Array<string> = []

const github = await startFakeGitHub((url, request, response) => {
  if (url.href !== usageUrl) {
    unexpectedGitHub.push(url.href)
    throw new Error("Unexpected GitHub request")
  }

  if (request.headers.authorization !== `token ${token}`) {
    unexpectedGitHub.push(`${url.href} without the stored token`)
    throw new Error("Unexpected authorization")
  }

  scenarios[currentScenario](response)
})

// A safety net: a connection off this machine fails the test instead of reaching GitHub.
const restoreConnections = refuseExternalConnections()

test.after(async () => {
  restoreConnections()
  await github.close()
  await fs.rm(home, { recursive: true, force: true })
})

// Every directory and file under a directory, with each file's content.
const snapshot = async (directory: string): Promise<Array<string>> => {
  const listed: Array<string> = []

  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const itemPath = path.join(directory, item.name)

    if (item.isDirectory()) {
      listed.push(`${itemPath}${path.sep}`, ...(await snapshot(itemPath)))
    } else {
      listed.push(`${itemPath}: ${await fs.readFile(itemPath, "utf8")}`)
    }
  }

  return listed.sort()
}

interface CliResult {
  code: number
  stdout: string
  stderr: string
  /** The requests the stand-in received during the run, as "METHOD https://host/path". */
  requests: Array<string>
}

// Runs `copilot-relay <args>` with the temporary home. In the child, GitHub calls reach the
// stand-in, a connection off this machine throws, and so does the global fetch, which the command
// must not use. offline fails the usage request before it is sent, as a failed DNS lookup would.
const run = async (args: Array<string>, scenario: Scenario): Promise<CliResult> => {
  const before = await snapshot(home)
  currentScenario = scenario
  github.requests.splice(0)

  const fail = scenario === "offline" ? `() => new Error("getaddrinfo ENOTFOUND api.github.com")` : "undefined"
  const script = `
    const network = await import(${JSON.stringify(networkFixture.href)});
    network.redirectGitHubTo(${JSON.stringify(github.origin)}, ${fail});
    network.refuseExternalConnections();
    globalThis.fetch = async () => {
      throw new Error("UNEXPECTED_NETWORK_ACCESS");
    };
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entry))}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(entry.href)});
  `
  const result = await new Promise<Omit<CliResult, "requests">>((resolve, reject) => {
    const child = execFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd,
      timeout: 60_000,
      env: { ...withoutProxyVariables(process.env), NO_COLOR: "1", HOME: home, USERPROFILE: home },
    }, (error, stdout, stderr) => {
      const code = error ? error.code : 0

      if (error?.killed || typeof code !== "number") {
        reject(error ?? new Error("Missing CLI exit code"))
        return
      }

      resolve({ code, stdout, stderr })
    })

    child.stdin?.end()
  })

  // The command writes nothing: no file under the home appears, changes or goes away, the log and
  // the config included.
  assert.deepEqual(await snapshot(home), before)
  assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_/)
  assert.ok(!lettersAndDigits(result.stdout + result.stderr).includes(lettersAndDigits(token)), "the token must never be printed")
  // No token exchange, no /user call, and no request without the stored token.
  assert.deepEqual(unexpectedGitHub.splice(0), [])

  return { ...result, requests: github.requests.splice(0) }
}

// Writes the token file the way copilot-relay auth does.
const storeToken = async (): Promise<void> => {
  await fs.mkdir(paths.appDir, { recursive: true })
  await fs.writeFile(paths.githubTokenPath, `${token}\n`)
}

test("usage prints the plan, the SKU, the reset date and one line per quota", async () => {
  await storeToken()

  const result = await run(["usage"], "quota")

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, [
    "Plan         fixture-plan",
    "SKU          fixture-sku",
    "Quota reset  2026-11-01",
    "",
    "chat                  unlimited; overage not permitted, overage count 0",
    "completions           unlimited; overage not permitted, overage count 0",
    "premium_interactions  150 of 300 remaining (50%); overage permitted, overage count 0; credits used 12.5",
    "",
  ].join("\n"))
  // One request, the usage request: no Copilot token exchange and no /user lookup.
  assert.deepEqual(result.requests, [`GET ${usageUrl}`])
})

test("usage --json prints the plan and quota fields and nothing that identifies the account", async () => {
  await storeToken()

  const result = await run(["usage", "--json"], "quota")

  assert.equal(result.code, 0, result.stderr)
  assert.doesNotMatch(result.stdout, /private-|login|organization|tracking/)
  assert.deepEqual(JSON.parse(result.stdout), {
    copilot_plan: "fixture-plan",
    access_type_sku: "fixture-sku",
    quota_reset_date: "2026-11-01",
    quota_snapshots: {
      chat: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100, overage_permitted: false, overage_count: 0, token_based_billing: null, credits_used: null },
      completions: { unlimited: true, entitlement: 0, remaining: 0, percent_remaining: 100, overage_permitted: false, overage_count: 0, token_based_billing: null, credits_used: null },
      premium_interactions: { unlimited: false, entitlement: 300, remaining: 150, percent_remaining: 50, overage_permitted: true, overage_count: 0, token_based_billing: true, credits_used: 12.5 },
    },
  })
})

test("usage without a stored token suggests copilot-relay auth and creates nothing", async () => {
  // An empty home: run() then proves that not even the app directory is created.
  await fs.rm(paths.appDir, { recursive: true, force: true })

  const result = await run(["usage"], "quota")

  assert.equal(result.code, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /^No GitHub token is stored at .+github_token\. Sign in with copilot-relay auth\.$/m)
  assert.deepEqual(result.requests, [])
})

test("usage explains a rejected token and exits 1", async () => {
  await storeToken()

  const result = await run(["usage"], "rejected")

  assert.equal(result.code, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /^GitHub rejected the stored token \(HTTP 401\)\. Sign in again with copilot-relay auth\.$/m)
})

test("usage explains a network error and exits 1", async () => {
  await storeToken()

  const result = await run(["usage"], "offline")

  assert.equal(result.code, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /^Could not reach GitHub: getaddrinfo ENOTFOUND api\.github\.com$/m)
  assert.deepEqual(result.requests, [])
})

test("usage refuses an answer that echoes the token in the plan, and prints none of it", async () => {
  await storeToken()

  const result = await run(["usage"], "echoedInPlan")

  assert.equal(result.code, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /^GitHub's answer to the usage request contains the stored token, so none of it is printed\.$/m)
})

test("usage --json refuses an answer that echoes the token in a quota id, and prints none of it", async () => {
  await storeToken()

  const result = await run(["usage", "--json"], "echoedInQuotaId")

  assert.equal(result.code, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /^GitHub's answer to the usage request contains the stored token, so none of it is printed\.$/m)
})

for (const args of [["usage"], ["usage", "--json"]]) {
  test(`${args.join(" ")} refuses an answer that spreads the token over the plan and the SKU, and prints none of it`, async () => {
    await storeToken()

    const result = await run(args, "spreadOverPlanAndSku")

    assert.equal(result.code, 1)
    assert.equal(result.stdout, "")
    assert.match(result.stderr, /^GitHub's answer to the usage request contains the stored token, so none of it is printed\.$/m)
  })
}

// Writes config.yaml for one test and removes it after.
const writeConfig = async (t: TestContext, lines: Array<string>): Promise<void> => {
  await fs.mkdir(paths.appDir, { recursive: true })
  await fs.writeFile(paths.configPath, `${lines.join("\n")}\n`)
  t.after(() => fs.rm(paths.configPath, { force: true }))
}

// Why: behind a proxy the usage request must go through upstreamProxy, like every other
// GitHub call. run() checks that nothing under the home directory changed: reading the config
// neither completes nor rewrites it, and no log file appears.
test("usage sends its request through upstreamProxy and still writes no file", async (t) => {
  await storeToken()
  const proxy = await startRecordingProxy()
  t.after(() => proxy.close())
  await writeConfig(t, [`upstreamProxy: ${proxy.url.replace("http://", "http://usage-user:usage-pass@")}`])

  const result = await run(["usage"], "quota")

  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stdout, /^Plan +fixture-plan$/m)
  assert.deepEqual(result.requests, [`GET ${usageUrl}`])
  // One tunnel, with the proxy's credentials. It leads to the stand-in, which redirectGitHubTo
  // puts in GitHub's place.
  assert.deepEqual(proxy.records, [{
    authorization: `Basic ${Buffer.from("usage-user:usage-pass").toString("base64")}`,
    method: "CONNECT",
    target: new URL(github.origin).host,
  }])
})

// Why: usage reads config.yaml without writing it, so an invalid file stops it with a line
// that names the file and repeats nothing from it: the file can hold a proxy password.
test("usage with an invalid config.yaml exits 1 before any request and prints nothing from the file", async (t) => {
  await storeToken()
  await writeConfig(t, ["upstreamProxy: socks5://usage-user:usage-config-secret@proxy.example:1080"])

  const result = await run(["usage"], "quota")

  assert.equal(result.code, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /^Could not read the config at .+config\.yaml; fix it, then run copilot-relay usage again\.$/m)
  assert.doesNotMatch(result.stderr, /usage-config-secret|socks5/)
  assert.deepEqual(result.requests, [])
})
