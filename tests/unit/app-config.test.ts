import assert from "node:assert/strict"
import test from "node:test"

import {
  logLevels,
  normalizeCopilotBaseUrl,
  normalizeLogLevel,
  normalizeThinkEffort,
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

// Why: thinkEffort is the user's reasoning-effort knob. Every documented tier
// (including the newest "max") must normalize to itself, case-insensitively, so
// a valid config value is never silently downgraded to the default.
test("normalizes every supported think effort tier", () => {
  for (const effort of ["none", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(normalizeThinkEffort(effort), effort)
    assert.equal(normalizeThinkEffort(effort.toUpperCase()), effort)
  }
})

// Why: "minimal" is a legacy alias some clients still send; it must map to "low"
// rather than being rejected, to stay backward compatible.
test("maps legacy 'minimal' think effort to low", () => {
  assert.equal(normalizeThinkEffort("minimal"), "low")
  assert.equal(normalizeThinkEffort("MINIMAL"), "low")
})

// Why: an unknown or non-string think effort should return undefined so the
// caller falls back to the default instead of forwarding a value Copilot would
// reject upstream.
test("returns undefined for invalid think effort values", () => {
  assert.equal(normalizeThinkEffort("ultra"), undefined)
  assert.equal(normalizeThinkEffort("maximum"), undefined)
  assert.equal(normalizeThinkEffort(""), undefined)
  assert.equal(normalizeThinkEffort(5), undefined)
  assert.equal(normalizeThinkEffort(undefined), undefined)
})

// Why: copilotBaseUrl is used as `${base}${path}` for every upstream call, so a
// value that is not an absolute HTTP(S) URL produces a confusing request-time
// failure rather than a clear startup one. Missing/blank keeps the existing
// normalizeString fallback behavior so the shipped default still applies.
test("accepts a missing or blank copilot base url", () => {
  assert.equal(normalizeCopilotBaseUrl(undefined), undefined)
  assert.equal(normalizeCopilotBaseUrl(""), undefined)
  assert.equal(normalizeCopilotBaseUrl("   "), undefined)
  assert.equal(normalizeCopilotBaseUrl(42), undefined)
})

// Why: the accepted value is what gets concatenated with request paths. Any
// URL-normalization here (adding a trailing slash, lowercasing the host,
// re-encoding) would silently change the request URL, so the trimmed original
// must come back byte-for-byte.
test("returns the accepted copilot base url exactly as written", () => {
  for (const value of [
    "https://api.githubcopilot.com",
    "https://gateway.example/tenant/v1",
    "https://Gateway.Example.COM/Tenant",
    "https://gateway.example:8443/base",
    "https://gateway.example/a%2Fb",
    "https://gateway.example/tenant?region=eu",
  ]) {
    assert.equal(normalizeCopilotBaseUrl(value), value)
    assert.equal(normalizeCopilotBaseUrl(`  ${value}  `), value)
  }
})

// Why: a local gateway over plain HTTP is a legitimate development setup and
// must not be swept up by the scheme check.
test("accepts http localhost copilot base urls", () => {
  assert.equal(
    normalizeCopilotBaseUrl("http://localhost:8080"),
    "http://localhost:8080",
  )
  assert.equal(
    normalizeCopilotBaseUrl("http://127.0.0.1:8080/base"),
    "http://127.0.0.1:8080/base",
  )
})

// Why: Undici accepts only absolute HTTP(S) URLs. Failing at config load names
// the bad key; failing at request time surfaces as an unrelated fetch error.
test("rejects malformed, relative and non-http copilot base urls", () => {
  for (const value of [
    "not a url",
    "/tenant/v1",
    "api.githubcopilot.com",
    "ftp://gateway.example",
    "file:///etc/passwd",
    "ws://gateway.example",
  ]) {
    assert.throws(() => normalizeCopilotBaseUrl(value), /Invalid copilotBaseUrl/)
  }
})

// Why: URL userinfo is a credential. Undici rejects it at request time anyway,
// so accepting it only buys a confusing failure plus a disclosure. See #47.
test("rejects copilot base urls carrying userinfo credentials", () => {
  for (const value of [
    "https://user:pass@gateway.example",
    "https://user@gateway.example",
    "https://:pass@gateway.example/tenant",
  ]) {
    assert.throws(() => normalizeCopilotBaseUrl(value), /Invalid copilotBaseUrl/)
  }
})

// Why: the error message is itself a disclosure surface — it reaches the
// terminal and, through the startup failure path, the log file. It must name
// the key and the rule without ever echoing the offending value. See #47.
test("never echoes the rejected copilot base url in the error", () => {
  const cases = [
    ["https://s3cr3t-user:s3cr3t-pass@gateway.example/tenant", "s3cr3t"],
    ["ftp://gateway.example/tenant-T0KEN-abc?q=T0KEN", "T0KEN"],
    ["not a url but LEAKY-VALUE", "LEAKY"],
  ] as const

  for (const [value, sentinel] of cases) {
    assert.throws(
      () => normalizeCopilotBaseUrl(value),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Invalid copilotBaseUrl/)
        assert.ok(
          !error.message.includes(sentinel),
          `error message leaked ${sentinel}: ${error.message}`,
        )
        assert.ok(
          !error.message.includes("gateway.example"),
          `error message leaked the host: ${error.message}`,
        )
        return true
      },
    )
  }
})
