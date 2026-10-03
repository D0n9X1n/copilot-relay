import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

// The CLI runs in a child process against this temporary home, with fetch standing in for GitHub.
// paths.ts resolves the home directory when it is imported, so it is redirected first. Node reads
// USERPROFILE on Windows and HOME elsewhere, so both are set.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-usage-command-"))
process.env.HOME = home
process.env.USERPROFILE = home

const { paths } = await import("../../src/lib/paths")

assert.ok(paths.githubTokenPath.startsWith(home), paths.githubTokenPath)

test.after(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

const entry = new URL("../../src/main.ts", import.meta.url)
const cwd = fileURLToPath(new URL("../../", import.meta.url))

// Never a real token. Every run checks that it is not printed.
const token = "gho_fixture-private-token-sentinel"

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

// How the child's fetch answers the usage URL in each scenario. The quota answer is given only to
// a request that carries the stored token.
const scenarios = {
  quota: `
    if (new Headers(init?.headers).get("authorization") !== ${JSON.stringify(`token ${token}`)}) {
      throw new Error("UNEXPECTED_AUTHORIZATION");
    }
    return Response.json(${JSON.stringify(account)});
  `,
  rejected: `return new Response("Bad credentials", { status: 401 });`,
  offline: `throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.github.com") });`,
}

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
}

// Runs `copilot-relay <args>` with the temporary home. The child's fetch answers only the usage URL,
// as the scenario says; any other request throws instead of reaching out.
const run = async (args: Array<string>, scenario: keyof typeof scenarios): Promise<CliResult> => {
  const before = await snapshot(home)
  const script = `
    globalThis.fetch = async (input, init) => {
      if (String(input) !== "https://api.github.com/copilot_internal/user") {
        throw new Error("UNEXPECTED_NETWORK_ACCESS");
      }
      ${scenarios[scenario]}
    };
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entry))}, ...${JSON.stringify(args)}];
    await import(${JSON.stringify(entry.href)});
  `
  const result = await new Promise<CliResult>((resolve, reject) => {
    const child = execFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
      cwd,
      timeout: 60_000,
      env: { ...process.env, NO_COLOR: "1", HOME: home, USERPROFILE: home },
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
  assert.ok(!(result.stdout + result.stderr).includes(token), "the token must never be printed")

  return result
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
})
