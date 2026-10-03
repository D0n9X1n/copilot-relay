import assert from "node:assert/strict"
import test from "node:test"

import { loadedTokenizers, preloadTokenizers } from "../../src/lib/tokenizer"

// A file of its own: no other test in this process loads a tokenizer first.

// Why: the first count_tokens request loaded its tokenizer and built the encoder while Claude Code
// waited (#141). Startup now loads every encoding count_tokens can select.
test("startup loads o200k_base and each supported reported tokenizer once", async () => {
  assert.deepEqual(loadedTokenizers(), [])

  await preloadTokenizers(["cl100k_base", undefined, "not-a-tokenizer", "o200k_base", "cl100k_base"])

  assert.deepEqual(loadedTokenizers(), ["o200k_base", "cl100k_base"])
})
