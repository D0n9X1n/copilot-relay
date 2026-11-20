import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import type { ProxyConfig } from "../../src/lib/config"

// src/lib/paths reads the home directory on import, so redirect HOME and USERPROFILE (Windows) first.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-catalog-billing-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { loadCopilotModelCatalog } = await import("../../src/copilot/models")
const { runtimeState } = await import("../../src/lib/state")
const { flushLogs } = await import("../../src/lib/log")

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

test.afterEach(() => {
  delete runtimeState.modelCatalog
  delete runtimeState.upstreamBaseUrl
})

// One entry as GET /models describes a model; billing is added per test.
const entry = (id: string, billing?: unknown, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  supported_endpoints: ["/responses", "ws:/responses"],
  capabilities: {
    type: "chat",
    tokenizer: "o200k_base",
    limits: { max_context_window_tokens: 1_050_000, max_prompt_tokens: 1_050_000, max_output_tokens: 128_000 },
    supports: { reasoning_effort: ["low", "medium", "high", "xhigh", "max"] },
  },
  ...(billing !== undefined && { billing }),
  ...extra,
})

const loadCatalog = async (data: Array<unknown>) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ data }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")
  const baseUrl = `http://127.0.0.1:${address.port}`
  const config: ProxyConfig = {
    copilotBaseUrl: baseUrl, copilotToken: "fixture-token", host: "127.0.0.1",
    port: 0, upstreamTimeoutMs: 10_000, vsCodeVersion: "1.99.3",
  }

  try {
    return (await loadCopilotModelCatalog(config)).models
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

// Copilot reports prices in hundredths of a USD per batch_size tokens.
const tokenPrices = (input: unknown, output: unknown, cache?: unknown) => ({
  restricted_to: [],
  token_prices: {
    batch_size: 1_000_000,
    default: { input_price: input, output_price: output, ...(cache !== undefined && { cache_price: cache }) },
  },
})

test("token prices become USD per million tokens", async () => {
  const models = await loadCatalog([
    entry("gpt-6.2-astra", tokenPrices(800, 4000, 40)),
    entry("claude-opus-5.5", tokenPrices(400, 2000)),
  ])

  assert.deepEqual(models.get("gpt-6.2-astra")?.price, { input: 8, output: 40, cache: 0.4 })
  assert.deepEqual(models.get("claude-opus-5.5")?.price, { input: 4, output: 20 })
  assert.equal(models.get("gpt-6.2-astra")?.multiplier, undefined)
})

test("a multiplier is kept as reported, a fraction and zero included", async () => {
  const models = await loadCatalog([
    entry("fraction", { is_premium: true, multiplier: 0.33 }),
    entry("included", { is_premium: false, multiplier: 0 }),
    entry("one", { is_premium: true, multiplier: 1 }),
  ])

  assert.equal(models.get("fraction")?.multiplier, 0.33)
  assert.equal(models.get("included")?.multiplier, 0)
  assert.equal(models.get("one")?.multiplier, 1)
  assert.equal(models.get("fraction")?.price, undefined)
})

test("missing or malformed billing leaves cost absent, never zero", async () => {
  const models = await loadCatalog([
    entry("none"),
    entry("not-an-object", "free"),
    entry("negative-multiplier", { multiplier: -1 }),
    entry("string-multiplier", { multiplier: "1" }),
    entry("bad-prices", tokenPrices("8", 40)),
    entry("missing-output", tokenPrices(800, undefined)),
    entry("bad-batch", { token_prices: { batch_size: 0, default: { input_price: 800, output_price: 4000 } } }),
  ])

  for (const id of ["none", "not-an-object", "negative-multiplier", "string-multiplier", "bad-prices", "missing-output", "bad-batch"]) {
    assert.equal(models.get(id)?.price, undefined, `${id} price`)
    assert.equal(models.get(id)?.multiplier, undefined, `${id} multiplier`)
  }
})

// Why: the catalog request asks for a newer API version to get prices; every other capability must
// parse exactly as it did from the older response.
test("a response with billing parses limits, endpoints, efforts and tokenizer unchanged", async () => {
  const [withBilling, without] = [
    await loadCatalog([entry("gpt-6.2-astra", tokenPrices(800, 4000, 40), { model_picker_price_category: "very_high" })]),
    await loadCatalog([entry("gpt-6.2-astra")]),
  ]
  const { price: _price, ...rest } = withBilling.get("gpt-6.2-astra") ?? {}

  assert.deepEqual(rest, without.get("gpt-6.2-astra"))
  assert.equal(Object.hasOwn(rest, "vendor"), false)
  assert.equal(Object.hasOwn(rest, "pickerEnabled"), false)
})
