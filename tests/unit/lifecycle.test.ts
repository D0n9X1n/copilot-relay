import assert from "node:assert/strict"
import test from "node:test"

import { isRelayStartProcess } from "../../src/lib/lifecycle"

test("recognizes installed copilot-relay start processes", () => {
  assert.equal(
    isRelayStartProcess(
      "node /usr/local/lib/node_modules/copilot-relay/dist/main.js start",
    ),
    true,
  )
  assert.equal(isRelayStartProcess("copilot-relay start"), true)
})

test("recognizes local dist start only from relay working directories", () => {
  assert.equal(
    isRelayStartProcess(
      "node dist/main.js start",
      "/private/tmp/copilot-relay-check",
    ),
    true,
  )
  assert.equal(
    isRelayStartProcess("node dist/main.js start", "/tmp/other-project"),
    false,
  )
})

test("does not treat non-start commands as relay instances", () => {
  assert.equal(isRelayStartProcess("copilot-relay restart"), false)
  assert.equal(
    isRelayStartProcess(
      "node /usr/local/lib/node_modules/copilot-relay/dist/main.js auth",
    ),
    false,
  )
})
