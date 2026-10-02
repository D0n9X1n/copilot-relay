import assert from "node:assert/strict"
import test from "node:test"

import { requireCopilotEndpoint, selectCopilotEndpoint } from "../../src/copilot/endpoint"
import {
  loadCopilotModelCatalog,
  resolveModelReasoningEffort,
  type CopilotModel,
} from "../../src/copilot/models"
import type { ProxyConfig } from "../../src/lib/config"
import { HTTPError } from "../../src/lib/error"
import { normalizeCopilotModelId } from "../../src/lib/models"
import { withRecordedTransport } from "../../src/lib/request-trace"
import { runtimeState } from "../../src/lib/state"

const baseUrl = "https://endpoint-fixture.invalid"

const configFor = (
  id: string,
  capabilities?: CopilotModel,
  mode?: ProxyConfig["claudeUpstreamApi"],
): ProxyConfig => ({
  host: "localhost",
  port: 0,
  copilotBaseUrl: baseUrl,
  copilotToken: "fixture",
  vsCodeVersion: "test",
  upstreamTimeoutMs: 1000,
  claudeUpstreamApi: mode,
  ...(capabilities && {
    modelCatalog: {
      baseUrl,
      models: new Map([[normalizeCopilotModelId(id), capabilities]]),
    },
  }),
})

test.afterEach(() => {
  delete runtimeState.thinkEffort
})

const legacyResponsesModels = [
  "gpt-5.5",
  "gpt-5.5-2025-01-01",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "GPT-6-ASTRA",
]

const dualEndpointOrders = [
  ["/responses", "/chat/completions"],
  ["/chat/completions", "/responses"],
]

for (const id of legacyResponsesModels) {
  test(`${id} keeps legacy Responses preference when endpoints are unknown or dual`, () => {
    assert.equal(selectCopilotEndpoint(configFor(id), id).endpoint, "/responses")

    for (const supportedEndpoints of dualEndpointOrders) {
      assert.deepEqual(selectCopilotEndpoint(configFor(id, { supportedEndpoints }), id), {
        endpoint: "/responses",
        source: "catalog",
        responsesFallback: false,
      })
    }

    const chatOnly = configFor(id, { supportedEndpoints: ["/chat/completions"] })
    assert.equal(selectCopilotEndpoint(chatOnly, id).endpoint, "/chat/completions")
  })
}

for (const id of ["future-model", "grok-4.7", "mai-code-1.1-flash", "gpt-6-luna"]) {
  test(`${id} follows catalog support without a model-name rule`, () => {
    assert.deepEqual(selectCopilotEndpoint(configFor(id), id), {
      endpoint: "/chat/completions",
      source: "legacy",
      responsesFallback: true,
    })

    for (const supportedEndpoints of dualEndpointOrders) {
      assert.deepEqual(selectCopilotEndpoint(configFor(id, { supportedEndpoints }), id), {
        endpoint: "/chat/completions",
        source: "catalog",
        responsesFallback: true,
      })
    }

    const responsesOnly = configFor(id, { supportedEndpoints: ["/responses"] })
    assert.deepEqual(selectCopilotEndpoint(responsesOnly, id), {
      endpoint: "/responses",
      source: "catalog",
      responsesFallback: false,
    })
  })
}

// Each case pairs the endpoints a catalog advertises with the expected outcome:
// `pinned` under the default and chat-completions policies, `auto` under auto.
// A path is the selected endpoint; any other value is the reason none was.
const claudePolicyCases = [
  { endpoints: undefined, pinned: "/chat/completions", auto: "/chat/completions", autoFallback: true },
  { endpoints: [], pinned: "no-advertised-endpoint", auto: "no-advertised-endpoint" },
  { endpoints: ["/other"], pinned: "unsupported-relay-endpoint", auto: "unsupported-relay-endpoint" },
  { endpoints: ["/chat/completions"], pinned: "/chat/completions", auto: "/chat/completions" },
  { endpoints: ["/responses"], pinned: "protocol-policy-conflict", auto: "/responses" },
  { endpoints: ["/v1/messages"], pinned: "protocol-policy-conflict", auto: "/v1/messages" },
  {
    endpoints: ["/chat/completions", "/responses", "/v1/messages"],
    pinned: "/chat/completions",
    auto: "/v1/messages",
  },
]

const expectedClaudeOutcome = (
  mode: ProxyConfig["claudeUpstreamApi"],
  fixture: (typeof claudePolicyCases)[number],
) => {
  if (mode === "messages") {
    return "/v1/messages"
  }

  if (mode === "auto") {
    return fixture.auto
  }

  return fixture.pinned
}

for (const mode of [undefined, "chat-completions", "auto", "messages"] as const) {
  for (const fixture of claudePolicyCases) {
    test(`Claude policy ${mode ?? "default"} with ${JSON.stringify(fixture.endpoints)}`, () => {
      const id = "claude-new"
      const config = configFor(id, { supportedEndpoints: fixture.endpoints }, mode)
      const expected = expectedClaudeOutcome(mode, fixture)

      const selection = selectCopilotEndpoint(config, id)

      if (selection.endpoint) {
        assert.equal(selection.endpoint, expected)
        assert.equal(selection.responsesFallback, mode === "auto" && fixture.autoFallback === true)
      } else {
        assert.equal(selection.reason, expected)
      }
    })
  }

  test(`non-Claude native-only model remains unsupported in ${mode ?? "default"}`, () => {
    const id = "other-native"
    const config = configFor(id, { supportedEndpoints: ["/v1/messages"] }, mode)

    assert.deepEqual(selectCopilotEndpoint(config, id), {
      reason: "unsupported-relay-endpoint",
    })
  })
}

test("provider-mismatched metadata cannot choose a route or reject effort", () => {
  const id = "future-model"
  const config = configFor(id, {
    supportedEndpoints: ["/responses"],
    reasoningEfforts: [],
  })
  // The catalog's base URL no longer matches the configured one, so its
  // metadata describes another provider.
  config.modelCatalog!.baseUrl = "https://previous.invalid"

  assert.deepEqual(selectCopilotEndpoint(config, id), {
    endpoint: "/chat/completions",
    source: "legacy",
    responsesFallback: true,
  })
  assert.equal(resolveModelReasoningEffort(config, id, "high"), "high")
})

test("non-chat types and unavailable endpoints produce relay-owned errors", () => {
  const unavailableCapabilities = [
    { type: "embedding" },
    { supportedEndpoints: [] },
    { supportedEndpoints: ["https://secret.invalid/TOKEN"] },
  ]

  for (const capabilities of unavailableCapabilities) {
    assert.throws(() => requireCopilotEndpoint(configFor("model", capabilities), "model"), (error: unknown) => {
      assert(error instanceof HTTPError)
      assert.equal(error.response.status, 400)
      assert.doesNotMatch(error.message, /TOKEN|secret.invalid|unsupported_api_for_model/)

      return true
    })
  }
})

test("effort resolution distinguishes implicit default, explicit none, and unsupported controls", () => {
  const id = "model"
  const noEffortConfig = configFor(id, { reasoningEfforts: [] })
  runtimeState.thinkEffort = "high"

  assert.equal(resolveModelReasoningEffort(configFor(id), id), "high")
  assert.equal(resolveModelReasoningEffort(configFor(id, { reasoningEfforts: ["low"] }), id), "high")
  assert.equal(resolveModelReasoningEffort(configFor(id), id, "none"), "none")
  assert.equal(resolveModelReasoningEffort(noEffortConfig, id), undefined)

  for (const effort of ["none", "low", "high"] as const) {
    assert.throws(
      () => resolveModelReasoningEffort(noEffortConfig, id, effort),
      (error: unknown) => error instanceof HTTPError && error.response.status === 400,
    )
  }
})

// Copilot lists some models without effort support only by leaving reasoning_effort out of
// supports; each such chat model rejected effort with invalid_reasoning_effort (#137).
test("catalog parsing keeps missing and malformed metadata unknown; empty, false or an omitted key is unsupported", async () => {
  const rows = [
    { id: "absent" },
    { id: "empty", supported_endpoints: [], capabilities: { supports: { reasoning_effort: [] } } },
    { id: "false", capabilities: { supports: { reasoning_effort: false } } },
    { id: "omitted-key", capabilities: { supports: { streaming: true, tool_calls: true } } },
    { id: "null-effort", capabilities: { supports: { reasoning_effort: null } } },
    { id: "null-supports", capabilities: { supports: null } },
    { id: "true", supported_endpoints: true, capabilities: { supports: { reasoning_effort: true } } },
    { id: "null-item", supported_endpoints: [null], capabilities: { supports: { reasoning_effort: [null] } } },
    { id: "mixed", supported_endpoints: ["/responses", 1], capabilities: { supports: { reasoning_effort: ["low", 1] } } },
    { id: "future", supported_endpoints: ["/future", "/responses"], capabilities: { supports: { reasoning_effort: ["future-tier"] } } },
  ]

  await withRecordedTransport({
    fetch: async (request) => {
      assert.equal(request.path, "/models")
      return Response.json({ data: rows })
    },
    refresh: async () => {},
  }, async () => {
    const catalog = await loadCopilotModelCatalog(configFor("absent"))

    for (const id of ["absent", "true", "null-item", "mixed", "null-effort", "null-supports"]) {
      assert.deepEqual(catalog.models.get(id), {})
    }

    assert.deepEqual(catalog.models.get("empty"), {
      supportedEndpoints: [],
      reasoningEfforts: [],
    })
    assert.deepEqual(catalog.models.get("false"), { reasoningEfforts: [] })
    assert.deepEqual(catalog.models.get("omitted-key"), { reasoningEfforts: [] })
    assert.deepEqual(catalog.models.get("future"), {
      supportedEndpoints: ["/future", "/responses"],
      reasoningEfforts: ["future-tier"],
    })
  })
})
