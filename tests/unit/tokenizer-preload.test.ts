import assert from "node:assert/strict"
import fs from "node:fs/promises"
import test from "node:test"

import { loadedTokenizers, preloadTokenizers } from "../../src/lib/tokenizer"

// node --test runs this file in a process of its own, so nothing has loaded cl100k_base before the
// preload below.

// Why: the first count_tokens request loaded its tokenizer and built the encoder while Claude Code
// waited. Startup now loads every encoding count_tokens can select.
test("startup loads o200k_base and each supported reported tokenizer", async () => {
  await preloadTokenizers(["cl100k_base", undefined, "not-a-tokenizer", "o200k_base", "cl100k_base"])

  const loaded = loadedTokenizers()
  assert.ok(loaded.includes("o200k_base"))
  assert.ok(loaded.includes("cl100k_base"))
  assert.ok(!loaded.includes("not-a-tokenizer"))
})

// An extra exposed model's tokenizer loads at its first count, so startup preloads from the two
// slots only.
test("startup preloads the tokenizers of the two slots only", async () => {
  const source = await fs.readFile(new URL("../../src/start.ts", import.meta.url), "utf8")
  const preloads = source.match(/preloadTokenizers\(([^\n]*)\)/g) ?? []

  assert.deepEqual(preloads, ["preloadTokenizers(getUpstreamModelIds().map((id) => getCachedCopilotModel(config, id)?.tokenizer))"])
})
