import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// Redirected before src/ loads: paths.ts reads the home directory at import time.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-model-routing-cache-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CODEX_HOME = path.join(home, ".codex")
process.env.CLAUDE_CONFIG_DIR = path.join(home, ".claude")

const models = await import("../../src/lib/models")
const { runtimeState } = await import("../../src/lib/state")
type CopilotModel = import("../../src/copilot/models").CopilotModel
type CopilotModelCatalog = import("../../src/copilot/models").CopilotModelCatalog
type ModelRoutingConfig = import("../../src/lib/models").ModelRoutingConfig
type RuntimeState = import("../../src/lib/state").RuntimeState

test.after(() => fs.rm(home, { recursive: true, force: true }))

test.afterEach(() => {
  delete runtimeState.modelRouting
  delete runtimeState.modelCatalog
  delete runtimeState.upstreamBaseUrl
})

// The routing logic before the cache, kept as the reference the cached functions must match. It
// reads the state passed to it instead of the runtime state.
const reference = (state: RuntimeState) => {
  const currentCatalog = (): ReadonlyMap<string, CopilotModel> | undefined =>
    state.modelCatalog?.baseUrl === state.upstreamBaseUrl ? state.modelCatalog?.models : undefined

  const canonicalModelId = (id: string, catalog: ReadonlyMap<string, CopilotModel> | undefined): string => {
    const lower = id.replace(/\[1m\]/gi, "").toLowerCase()
    for (const key of catalog?.keys() ?? []) {
      if (key.toLowerCase() === lower) {
        return key
      }
    }

    return lower
  }

  const resolveExposedModels = (routing: ModelRoutingConfig, catalog: ReadonlyMap<string, CopilotModel> | undefined): Array<string> => {
    const selected = routing.models === "auto" ? models.selectNewestPerVendor(catalog ?? new Map()) : routing.models ?? []
    const present = selected.filter((id) => catalog === undefined || catalog.has(canonicalModelId(id, catalog)))
    const exposed: Array<string> = []
    for (const id of [routing.gptModel, routing.opusModel, ...present]) {
      const canonical = canonicalModelId(id, catalog)
      if (!exposed.some((known) => known.toLowerCase() === canonical.toLowerCase())) {
        exposed.push(canonical)
      }
    }

    return exposed
  }

  const normalizeCopilotModelId = (model: string): string => canonicalModelId(model, currentCatalog())

  const normalizeClaudeModelId = (model: string, contextWindowTokens?: number): string => {
    const catalog = currentCatalog()
    const canonical = canonicalModelId(model, catalog)
    const contextWindow = contextWindowTokens ?? catalog?.get(canonical)?.limits?.max_context_window_tokens
    if (contextWindow === undefined) {
      return model
    }

    return contextWindow >= 1_000_000 ? `${canonical}[1m]` : canonical
  }

  const getConfiguredModelRouting = (): ModelRoutingConfig => state.modelRouting ?? models.defaultModelRouting

  const getModelRouting = (): ModelRoutingConfig => {
    const routing = getConfiguredModelRouting()
    return {
      ...routing,
      gptModel: normalizeCopilotModelId(routing.gptModel),
      opusModel: normalizeCopilotModelId(routing.opusModel),
    }
  }

  const getExposedUpstreamModelIds = (): Array<string> =>
    resolveExposedModels(getConfiguredModelRouting(), currentCatalog())

  const getExposedModelIds = (): Array<string> => {
    const routing = getConfiguredModelRouting()
    const slots = [routing.gptModel, routing.opusModel]
    return getExposedUpstreamModelIds().map((id) => {
      const slot = slots.find((configured) => normalizeCopilotModelId(configured).toLowerCase() === id.toLowerCase())
      return normalizeClaudeModelId(slot ?? id)
    })
  }

  const routeModelId = (model: string): string => {
    const requested = normalizeCopilotModelId(model.trim()).toLowerCase()
    const exposed = getExposedUpstreamModelIds().find((id) => id.toLowerCase() === requested)
    if (exposed !== undefined) {
      return exposed
    }

    const routing = getModelRouting()
    return requested.includes("opus") ? routing.opusModel : routing.gptModel
  }

  return { getExposedModelIds, getExposedUpstreamModelIds, normalizeClaudeModelId, normalizeCopilotModelId, routeModelId }
}

const baseUrl = "https://fixture.invalid"
const window = (tokens: number) => ({ limits: { max_context_window_tokens: tokens, max_prompt_tokens: 1000, max_output_tokens: 1000 } })
const pick = (vendor: string, extra: CopilotModel = {}): CopilotModel => ({ type: "chat", vendor, pickerEnabled: true, pickerCategory: "versatile", ...extra })

const catalogs: Array<[string, CopilotModelCatalog | undefined]> = [
  ["no catalog", undefined],
  ["current catalog", {
    baseUrl,
    models: new Map<string, CopilotModel>([
      ["gpt-6-astra", pick("OpenAI", window(1_050_000))],
      ["GPT-10-Nova", pick("OpenAI", window(400_000))],
      ["claude-opus-5.5", pick("Anthropic", window(1_000_000))],
      ["claude-haiku-4.5", pick("Anthropic", window(200_000))],
      ["grok-4.7", pick("xAI")],
      ["mai-code-2", {}],
    ]),
  }],
  ["keys differing only in case", {
    baseUrl,
    models: new Map<string, CopilotModel>([
      ["Grok-4.7", pick("xAI", window(2_000_000))],
      ["grok-4.7", pick("xAI", window(100_000))],
      ["claude-opus-5.5", pick("Anthropic", window(1_000_000))],
    ]),
  }],
  ["catalog of another upstream", {
    baseUrl: "https://previous.invalid",
    models: new Map<string, CopilotModel>([["gpt-6-astra", pick("OpenAI", window(1_050_000))]]),
  }],
]

const routings: Array<[string, ModelRoutingConfig | undefined]> = [
  ["default routing", undefined],
  ["auto", { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5", models: "auto" }],
  ["empty selection", { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5", models: [] }],
  ["explicit list", { gptModel: "GPT-6-Astra[1m]", opusModel: "claude-opus-5.5", models: ["MAI-code-2", "grok-4.7", "missing-1", "gpt-10-nova"] }],
  ["slot equal to a selected ID", { gptModel: "gpt-10-nova", opusModel: "claude-opus-5.5[1M]", models: "auto" }],
  ["gptModel equal to opusModel", { gptModel: "grok-4.7", opusModel: "GROK-4.7", models: ["grok-4.7"] }],
]

const inputs = [
  "sonnet", "haiku", "opus", "default", "claude-opus-5.5[1M]", "CLAUDE-OPUS-5.5", "GPT-10-NOVA[1m]", " gpt-10-nova ",
  "grok-4.7", "GROK-4.7[1m][1M]", "mai-code-2", "unknown-model", "Unknown-Opus-X[1m]", "claude-haiku-4.5",
]

test("the cached routing gives the same results as the uncached logic", () => {
  for (const [catalogName, catalog] of catalogs) {
    for (const [routingName, routing] of routings) {
      const state: RuntimeState = { upstreamBaseUrl: baseUrl, modelCatalog: catalog, modelRouting: routing }
      runtimeState.upstreamBaseUrl = state.upstreamBaseUrl
      runtimeState.modelCatalog = state.modelCatalog
      runtimeState.modelRouting = state.modelRouting
      const expected = reference(state)
      const label = `${catalogName}, ${routingName}`

      // Read twice: the second read is served from the cache.
      for (let read = 0; read < 2; read++) {
        assert.deepEqual(models.getExposedUpstreamModelIds(), expected.getExposedUpstreamModelIds(), label)
        assert.deepEqual(models.getExposedModelIds(), expected.getExposedModelIds(), label)
        for (const input of inputs) {
          assert.equal(models.routeModelId(input), expected.routeModelId(input), `${label}: route ${input}`)
          assert.equal(models.normalizeCopilotModelId(input), expected.normalizeCopilotModelId(input), `${label}: copilot ${input}`)
          assert.equal(models.normalizeClaudeModelId(input), expected.normalizeClaudeModelId(input), `${label}: claude ${input}`)
          assert.equal(models.normalizeClaudeModelId(input, 1_000_000), expected.normalizeClaudeModelId(input, 1_000_000), `${label}: claude 1M ${input}`)
          assert.equal(models.normalizeClaudeModelId(input, 200_000), expected.normalizeClaudeModelId(input, 200_000), `${label}: claude 200K ${input}`)
        }
      }
    }
  }
})

test("when two catalog keys differ only in case, the first in catalog order is the canonical ID", () => {
  const catalog = new Map<string, CopilotModel>([["Grok-4.7", {}], ["grok-4.7", {}]])

  assert.equal(models.canonicalModelId("GROK-4.7[1m]", catalog), "Grok-4.7")
  assert.equal(models.canonicalModelId("grok-4.7", catalog), "Grok-4.7")
  assert.equal(models.canonicalModelId("Unknown-1[1M]", catalog), "unknown-1")
})

// Counts every walk over the catalog, so a test can tell a cached read from a recomputed one.
class CountingMap extends Map<string, CopilotModel> {
  walks = 0

  override keys() {
    this.walks++
    return super.keys()
  }

  override entries() {
    this.walks++
    return super.entries()
  }

  override values() {
    this.walks++
    return super.values()
  }

  override [Symbol.iterator]() {
    this.walks++
    return super[Symbol.iterator]()
  }

  override forEach(...args: Parameters<Map<string, CopilotModel>["forEach"]>) {
    this.walks++
    super.forEach(...args)
  }
}

test("routing walks a catalog only on its first use with a routing", () => {
  const catalog = new CountingMap([
    ["gpt-6-astra", pick("OpenAI", window(1_050_000))],
    ["claude-opus-5.5", pick("Anthropic", window(1_000_000))],
    ["grok-4.7", pick("xAI")],
  ])
  runtimeState.upstreamBaseUrl = baseUrl
  runtimeState.modelCatalog = { baseUrl, models: catalog }
  runtimeState.modelRouting = { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5", models: "auto" }

  const route = () => {
    models.getExposedModelIds()
    models.getExposedUpstreamModelIds()
    for (const input of ["opus", "sonnet", "GROK-4.7[1m]", "unknown-model"]) {
      models.routeModelId(input)
    }
  }

  route()
  const firstUse = catalog.walks
  route()
  route()

  assert.equal(catalog.walks, firstUse)
})

// Each request runs under its own snapshot of the runtime state, so the routing object, and a
// `models` list inside it, is a fresh copy every time. Equal values must still reuse the cache.
test("requests with fresh copies of equal routing reuse the cached lists", async () => {
  const { snapshotRuntimeState, withRuntimeState } = await import("../../src/lib/state")
  const catalog = new CountingMap([
    ["gpt-6-astra", pick("OpenAI", window(1_050_000))],
    ["claude-opus-5.5", pick("Anthropic", window(1_000_000))],
    ["grok-4.7", pick("xAI")],
  ])
  runtimeState.upstreamBaseUrl = baseUrl
  runtimeState.modelCatalog = { baseUrl, models: catalog }

  for (const selection of ["auto", ["grok-4.7"]] as const) {
    const configured = (): ModelRoutingConfig => ({
      gptModel: "gpt-6-astra",
      opusModel: "claude-opus-5.5",
      models: selection === "auto" ? "auto" : [...selection],
    })
    const request = () => {
      runtimeState.modelRouting = configured()
      withRuntimeState(snapshotRuntimeState(), () => {
        models.getExposedModelIds()
        models.routeModelId("grok-4.7")
      })
    }

    request()
    const firstUse = catalog.walks
    request()
    request()

    assert.equal(catalog.walks, firstUse, `models: ${JSON.stringify(selection)}`)
  }
})

const useRouting = (catalog: Map<string, CopilotModel>, routing: ModelRoutingConfig) => {
  runtimeState.upstreamBaseUrl = baseUrl
  runtimeState.modelCatalog = { baseUrl, models: catalog }
  runtimeState.modelRouting = routing
}

const routingCatalog = new Map<string, CopilotModel>([
  ["gpt-6-astra", pick("OpenAI", window(1_050_000))],
  ["claude-opus-5.5", pick("Anthropic", window(1_000_000))],
  ["grok-4.7", pick("xAI")],
  ["mai-code-2", {}],
])

test("a changed models selection with the same catalog gives the new list", () => {
  useRouting(routingCatalog, { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5", models: [] })
  assert.deepEqual(models.getExposedModelIds(), ["gpt-6-astra[1m]", "claude-opus-5.5[1m]"])
  assert.equal(models.routeModelId("grok-4.7"), "gpt-6-astra")

  runtimeState.modelRouting = { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5", models: ["grok-4.7"] }
  assert.deepEqual(models.getExposedModelIds(), ["gpt-6-astra[1m]", "claude-opus-5.5[1m]", "grok-4.7"])
  assert.equal(models.routeModelId("grok-4.7"), "grok-4.7")

  // The same routing object, changed in place, is read by its values rather than its identity.
  runtimeState.modelRouting.models = ["mai-code-2"]
  assert.deepEqual(models.getExposedUpstreamModelIds(), ["gpt-6-astra", "claude-opus-5.5", "mai-code-2"])
  assert.equal(models.routeModelId("grok-4.7"), "gpt-6-astra")
})

test("a replaced catalog gives the new catalog's list", () => {
  useRouting(routingCatalog, { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5", models: "auto" })
  assert.deepEqual(models.getExposedUpstreamModelIds(), ["gpt-6-astra", "claude-opus-5.5", "grok-4.7"])

  runtimeState.modelCatalog = {
    baseUrl,
    models: new Map<string, CopilotModel>([
      ["gpt-6-astra", pick("OpenAI", window(400_000))],
      ["claude-opus-5.5", pick("Anthropic", window(1_000_000))],
      ["grok-5", pick("xAI")],
    ]),
  }
  assert.deepEqual(models.getExposedUpstreamModelIds(), ["gpt-6-astra", "claude-opus-5.5", "grok-5"])
  assert.deepEqual(models.getExposedModelIds(), ["gpt-6-astra", "claude-opus-5.5[1m]", "grok-5"])
  assert.equal(models.routeModelId("grok-4.7"), "gpt-6-astra")
  assert.equal(models.routeModelId("GROK-5"), "grok-5")
})

test("a catalog of another upstream is ignored, and counts again once the upstream matches", () => {
  useRouting(routingCatalog, { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5", models: "auto" })
  assert.deepEqual(models.getExposedModelIds(), ["gpt-6-astra[1m]", "claude-opus-5.5[1m]", "grok-4.7"])

  runtimeState.upstreamBaseUrl = "https://next.invalid"
  assert.deepEqual(models.getExposedModelIds(), ["gpt-6-astra", "claude-opus-5.5"])
  assert.equal(models.routeModelId("grok-4.7"), "gpt-6-astra")

  runtimeState.upstreamBaseUrl = baseUrl
  assert.deepEqual(models.getExposedModelIds(), ["gpt-6-astra[1m]", "claude-opus-5.5[1m]", "grok-4.7"])
})

test("a probe's temporary routing is undone when the saved routing is restored", () => {
  useRouting(routingCatalog, { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5", models: "auto" })
  const original = { upstream: models.getExposedUpstreamModelIds(), claude: models.getExposedModelIds(), route: models.routeModelId("opus") }

  const saved = runtimeState.modelRouting
  runtimeState.modelRouting = { gptModel: "mai-code-2", opusModel: "mai-code-2" }
  assert.deepEqual(models.getExposedUpstreamModelIds(), ["mai-code-2"])
  assert.equal(models.routeModelId("opus"), "mai-code-2")

  runtimeState.modelRouting = saved
  assert.deepEqual({ upstream: models.getExposedUpstreamModelIds(), claude: models.getExposedModelIds(), route: models.routeModelId("opus") }, original)
})

test("changing a returned list does not change the next one", () => {
  useRouting(routingCatalog, { gptModel: "gpt-6-astra", opusModel: "claude-opus-5.5", models: ["grok-4.7"] })

  models.getExposedUpstreamModelIds().push("injected")
  models.getExposedModelIds().splice(0)

  assert.deepEqual(models.getExposedUpstreamModelIds(), ["gpt-6-astra", "claude-opus-5.5", "grok-4.7"])
  assert.deepEqual(models.getExposedModelIds(), ["gpt-6-astra[1m]", "claude-opus-5.5[1m]", "grok-4.7"])
  assert.equal(models.routeModelId("injected"), "gpt-6-astra")
})

// The routing cache knows a catalog by its Map identity, so a published catalog is replaced rather
// than changed in place; the type makes a change in place fail to compile.
test("a published catalog's models cannot be changed in place", () => {
  const catalog: CopilotModelCatalog = { baseUrl, models: new Map() }
  const changeInPlace = () => {
    // @ts-expect-error A published catalog's models are read-only.
    catalog.models.set("gpt-6-astra", {})
  }

  assert.equal(typeof changeInPlace, "function")
  assert.equal(catalog.models.size, 0)
})
