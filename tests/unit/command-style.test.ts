import assert from "node:assert/strict"
import test from "node:test"
import { stripVTControlCharacters } from "node:util"

// paths.ts resolves the home directory when it is imported, and status and cache import it.
const { renderStatus, toStatusConfig } = await import("../../src/status")
const { renderSetupOutcomes } = await import("../../src/setup")
const { renderCacheReport } = await import("../../src/lib/cache-report")
const { renderCopilotUsage, parseCopilotUsage } = await import("../../src/lib/usage")
const { renderReplay } = await import("../../src/replay")
const { renderProbeHeader, renderProbeSummary } = await import("../../src/lib/model-probe-output")
const { renderModelRows } = await import("../../src/lib/model-listing")

const bold = (text: string): string => `\u001b[1m${text}\u001b[22m`
const gray = (text: string): string => `\u001b[90m${text}\u001b[0m`

const config = toStatusConfig({
  apiKey: "",
  claudeSetup: true,
  codexSetup: true,
  copilotBaseUrl: "https://api.githubcopilot.com",
  gptModel: "gpt-6.2-astra",
  host: "127.0.0.1",
  logLevel: "info",
  logRetentionDays: 3,
  opusModel: "claude-opus-5.5",
  port: 4142,
  thinkEffort: "max",
  upstreamTimeoutSeconds: 180,
  webSearchBackend: undefined,
})
const running = {
  baseUrl: "http://127.0.0.1:4142",
  config,
  configPath: "/home/u/.copilot-relay/config.yaml",
  daemonVersion: "0.8.1",
  deep: { ms: 890, ok: true },
  health: { ms: 2, ok: true },
  logLevel: "info",
  logPath: "/home/u/.copilot-relay/logs/copilot-relay.2026-11-21.log",
  models: ["gpt-6.2-astra[1m]"],
  pid: 4242,
  port: 4142,
  running: true,
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  thinkEffort: "max",
  version: "0.8.1",
}

test("status bolds its title, section labels and the command to run, and grays detail", () => {
  const lines = renderStatus(running, true, true)

  assert.equal(lines[0], `${bold("copilot-relay 0.8.1")} · http://127.0.0.1:4142`)
  assert.ok(lines.includes(bold("Files")))
  assert.ok(lines.includes(bold("Config")))
  // A latency in parentheses is gray, also when a description follows it.
  assert.ok(lines.some((line) => line.endsWith(` ${gray("(2ms)")}`)))
  assert.ok(lines.some((line) => line.includes(` ${gray("(890ms)")} — end-to-end Copilot round trip`)))
  assert.ok(lines.some((line) => line.includes(gray("on restart; the rest hot-reload."))))
  // An unset setting's note is gray; a set value is plain.
  assert.ok(lines.some((line) => line.includes(gray("(unset — clients need no key)"))))

  const stopped = renderStatus({ ...running, running: false }, true, true)
  assert.ok(stopped.includes(`Start it with: ${bold("copilot-relay start")}`))
})

test("setup, usage, cache and replay bold their title and column names", () => {
  const setup = renderSetupOutcomes([{ target: "codex-cli", path: "/x/config.toml", status: "updated" }], "http://127.0.0.1:4142", true, true)
  assert.equal(setup[0], `${bold("Client setup")} · http://127.0.0.1:4142`)
  assert.ok(setup[2].startsWith(`  ${bold("CLIENT")}`))

  const usage = renderCopilotUsage(parseCopilotUsage({ copilot_plan: "business", quota_reset_date: "2026-12-01", quota_snapshots: {} }), true, true)
  assert.equal(usage[0], `${bold("Copilot plan")} · business · resets 2026-12-01`)

  const cache = renderCacheReport([{
    bucket: null, model: "claude-opus-5.5", route: "/v1/messages", requests: 3, unknownCacheRequests: 0, zeroCacheReadRequests: 0,
    totalInputTokens: 100, cacheReadTokens: 96, uncachedInputTokens: 4, cacheWriteTokens: null, hitRate: 0.96, belowGoal: false,
  }], { view: "summary", goal: 95 }, true, true)
  assert.ok(cache[0].startsWith(`${bold("Prompt-cache hit rate")} · `), cache[0])
  assert.ok(cache[2].startsWith(`  ${bold("MODEL")}`))

  const replay = renderReplay({ verdict: "DIFF", exitCode: 2, differences: [{ path: "client.body", reason: "Value differs" }] }, true, true)
  assert.equal(replay[0], bold("Replay"))
  assert.ok(replay.includes(bold("Differences (1)")))
})

test("models --deep bolds its header row and Summary label", () => {
  assert.ok(renderProbeHeader(14, true).startsWith(`  ${bold("MODEL")}`))
  assert.ok(renderProbeSummary([], true).startsWith(bold("Summary:")))
  assert.equal(stripVTControlCharacters(renderProbeSummary([], true)), renderProbeSummary([]))
})

test("a search heading and the models --deep title are bold too", async () => {
  const { modelCheckTitle } = await import("../../src/lib/model-probe")
  assert.equal(modelCheckTitle(2, true), `${bold("Model check")} · 2 models · real Copilot usage`)
  assert.equal(modelCheckTitle(1, false), "Model check · 1 model · real Copilot usage")
})

test("models grays NAME", () => {
  const lines = renderModelRows([
    { id: "claude-opus-5.5", name: "Claude Opus 5.5", chat: true, price: { input: 4, output: 20 } },
    { id: "gpt-6-luna", name: "GPT-6 Luna", chat: true, price: { input: 0.1, output: 0.5 } },
  ], 8, true)

  assert.ok(lines[1].includes(gray("Claude Opus 5.5")))
})
