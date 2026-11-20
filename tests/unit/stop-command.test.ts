import assert from "node:assert/strict"
import test from "node:test"

const { describeStopped } = await import("../../src/stop")

test("stop names the one process it stopped", () => {
  assert.equal(describeStopped([65686]), "Stopped copilot-relay (pid 65686)")
})

test("stop names every process it stopped", () => {
  assert.equal(describeStopped([101, 202]), "Stopped copilot-relay (pids 101, 202)")
})

test("stop has no outcome line when nothing was stopped, because the search already said so", () => {
  assert.equal(describeStopped([]), undefined)
})
