import assert from "node:assert/strict"
import test from "node:test"

import {
  logLevels,
  normalizeLogLevel,
  normalizeUpstreamTimeoutSeconds,
} from "../../src/lib/app-config"

// Why: log level names are part of the user config contract. Unknown values
// should fail fast instead of silently changing production observability.
test("accepts only supported log levels", () => {
  assert.deepEqual([...logLevels], ["error", "info", "debug"])
  assert.equal(normalizeLogLevel("error"), "error")
  assert.equal(normalizeLogLevel("INFO"), "info")
  assert.equal(normalizeLogLevel("debug"), "debug")
})

// Why: old levels like warn/trace/silent used to exist, but the runtime should
// now stop on them so users fix stale config instead of getting surprising logs.
test("rejects removed log levels", () => {
  assert.throws(() => normalizeLogLevel("warn"), /Invalid logLevel/)
  assert.throws(() => normalizeLogLevel("warning"), /Invalid logLevel/)
  assert.throws(() => normalizeLogLevel("trace"), /Invalid logLevel/)
  assert.throws(() => normalizeLogLevel("silent"), /Invalid logLevel/)
})

// Why: a missing key should still use the default config, while a malformed
// configured value should fail startup.
test("distinguishes missing and invalid log levels", () => {
  assert.equal(normalizeLogLevel(undefined), undefined)
  assert.throws(() => normalizeLogLevel(3), /expected one of/)
})

// Why: upstream timeouts are part of the runtime config contract. Missing values
// use the default, while malformed values should stop startup instead of
// silently disabling request cancellation.
test("accepts only positive upstream timeout seconds", () => {
  assert.equal(normalizeUpstreamTimeoutSeconds(undefined), undefined)
  assert.equal(normalizeUpstreamTimeoutSeconds("180"), 180)
  assert.equal(normalizeUpstreamTimeoutSeconds(45), 45)
  assert.throws(() => normalizeUpstreamTimeoutSeconds("0"), /positive integer/)
  assert.throws(() => normalizeUpstreamTimeoutSeconds("abc"), /positive integer/)
})
