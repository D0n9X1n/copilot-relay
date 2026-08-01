import assert from "node:assert/strict"
import test from "node:test"

import {
  logLevels,
  normalizeCopilotBaseUrl,
  normalizeLogLevel,
  normalizeThinkEffort,
  normalizeUpstreamTimeoutSeconds,
} from "../../src/lib/app-config"
import {
  registerSensitiveOrigin,
  scrubSensitiveUrls,
} from "../../src/lib/redact"

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


// Why: the WHATWG URL parser normalizes backslashes to forward slashes for
// http(s) schemes, so a base URL written with backslashes parses cleanly,
// carries no userinfo, and is accepted. It must come back byte-for-byte like
// any other accepted value - which is what makes the backslash redaction tests
// in redact.test.ts cover real supported config rather than an impossible
// input.
test("accepts a backslash-normalized copilot base url unchanged", () => {
  const backslashUrl = "https://gateway.example\\tenant\\TOKEN"
  assert.equal(normalizeCopilotBaseUrl(backslashUrl), backslashUrl)
  assert.equal(normalizeCopilotBaseUrl(`  ${backslashUrl}  `), backslashUrl)

  const mixedUrl = "https://gateway.example/tenant\\TOKEN"
  assert.equal(normalizeCopilotBaseUrl(mixedUrl), mixedUrl)

  // Pins the normalization that makes these dangerous: the tail lands in the
  // path, so it is sent upstream and comes back in error payloads.
  assert.equal(new URL(backslashUrl).pathname, "/tenant/TOKEN")
  assert.equal(new URL(backslashUrl).origin, "https://gateway.example")
})


// Why (#47): WHATWG accepts scheme-shorthand forms - `https:host/path`,
// `https:/host/path`, `https:\\host\path` - and normalizes every one of them to
// a real origin with the tail in the path, so each passes a protocol check and
// works upstream. None of them can be found again in arbitrary log text:
// practical URL detection anchors on a literal "://", and loosening it to chase
// a bare "https:" would match ordinary prose. Requiring the authority prefix is
// the one place this question has a definite answer.
test("rejects http(s) urls written without an explicit authority prefix", () => {
  for (const value of [
    "https:gateway.example/tenant/v1",
    "https:/gateway.example/tenant/v1",
    "https:\\\\gateway.example\\tenant\\v1",
    "http:gateway.example",
    "https:",
  ]) {
    assert.throws(() => normalizeCopilotBaseUrl(value), /Invalid copilotBaseUrl/)
  }
})

// Why: the scheme is case-insensitive to both the URL parser and the log
// scanner, so an uppercase conventional URL is an ordinary value. It must keep
// working and come back byte-for-byte, exactly like any other accepted form.
test("accepts an uppercase conventional scheme unchanged", () => {
  assert.equal(
    normalizeCopilotBaseUrl("HTTPS://gateway.example/tenant/v1"),
    "HTTPS://gateway.example/tenant/v1",
  )
  assert.equal(
    normalizeCopilotBaseUrl("Http://localhost:8080"),
    "Http://localhost:8080",
  )
})

// Why: this fix belongs at the validation boundary, and this test is the
// reason. The shorthand used to be accepted and stored verbatim, and no
// downstream redaction can rescue it - the scrubber anchors on "://", which the
// shorthand does not contain, so it silently no-ops. The value has to be
// refused before it can ever be registered as a policy or written to a log.
test("refuses shorthand at validation because redaction cannot catch it", () => {
  const shorthand = "https:gateway.example/tenant/SHORTHAND_SENTINEL"

  // 1. Rejected now, before anything could register a policy from it.
  assert.throws(
    () => normalizeCopilotBaseUrl(shorthand),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Invalid copilotBaseUrl/)
      assert.ok(
        !error.message.includes("SHORTHAND_SENTINEL"),
        `error leaked the sentinel: ${error.message}`,
      )
      assert.ok(
        !error.message.includes("gateway.example"),
        `error leaked the host: ${error.message}`,
      )
      return true
    },
  )

  // 2. And this is why it must be rejected: even with the origin registered,
  // the scrubber leaves the shorthand completely untouched. Sole scrubber user
  // in this file, so the process-wide policy set stays order-independent here.
  registerSensitiveOrigin("https://gateway.example/tenant/SHORTHAND_SENTINEL")
  assert.equal(
    scrubSensitiveUrls(`copilot base url: ${shorthand}`),
    `copilot base url: ${shorthand}`,
  )
})


// Why (#47): a raw apostrophe is the sharpest case. WHATWG accepts it and
// leaves it raw in the path, so the configured value keeps it - and every
// practical URL scanner treats a quote as a delimiter, because in rendered
// log text it usually is one. inspect() renders the value inside quotes, the
// match ends at the apostrophe, and the rest of the path prints in full. The
// other classes are the same problem: they are what tells a reader, and a
// scanner, where a URL ends. Percent-encoding keeps every one of them usable.
test("rejects raw delimiter characters in a copilot base url", () => {
  const cases: Array<[string, string]> = [
    ["https://gateway.example/tenant/APOS'D1_SENTINEL", "D1_SENTINEL"],
    ['https://gateway.example/tenant/QUOTE"D2_SENTINEL', "D2_SENTINEL"],
    ["https://gateway.example/tenant/TICK`D3_SENTINEL", "D3_SENTINEL"],
    ["https://gateway.example/tenant/LT<D4_SENTINEL", "D4_SENTINEL"],
    ["https://gateway.example/tenant/GT>D5_SENTINEL", "D5_SENTINEL"],
    ["https://gateway.example/tenant/SPACE D6_SENTINEL", "D6_SENTINEL"],
    ["https://gateway.example/tenant/TAB\tD7_SENTINEL", "D7_SENTINEL"],
    ["https://gateway.example/tenant/NL\nD8_SENTINEL", "D8_SENTINEL"],
    ["https://gateway.example/tenant/BEL\u0007D9_SENTINEL", "D9_SENTINEL"],
    ["https://gateway.example/tenant/DEL\u007FD10_SENTINEL", "D10_SENTINEL"],
  ]

  for (const [value, sentinel] of cases) {
    assert.throws(
      () => normalizeCopilotBaseUrl(value),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /Invalid copilotBaseUrl/)
        assert.match(error.message, /percent-encoded/)
        assert.ok(
          !error.message.includes(sentinel),
          `error leaked ${sentinel}: ${error.message}`,
        )
        assert.ok(
          !error.message.includes("gateway.example"),
          `error leaked the host: ${error.message}`,
        )
        return true
      },
    )
  }
})

// Why: rejecting the raw byte is only reasonable because the encoded form
// still works. Every delimiter class has a percent-encoded spelling that is
// unambiguous in log text, and each must be accepted and preserved exactly -
// re-encoding or normalizing here would change the request URL.
test("accepts percent-encoded delimiters unchanged", () => {
  for (const value of [
    "https://gateway.example/tenant/APOS%27ENC",
    "https://gateway.example/tenant/QUOTE%22ENC",
    "https://gateway.example/tenant/TICK%60ENC",
    "https://gateway.example/tenant/LT%3CENC",
    "https://gateway.example/tenant/GT%3EENC",
    "https://gateway.example/tenant/SPACE%20ENC",
    "https://gateway.example/tenant/TAB%09ENC",
    "https://gateway.example/tenant/DEL%7FENC",
  ]) {
    assert.equal(normalizeCopilotBaseUrl(value), value)
    assert.equal(normalizeCopilotBaseUrl(`  ${value}  `), value)
  }
})

// Why: surrounding whitespace is a typo, not an ambiguity - it is trimmed
// first, exactly as for every other config value. Only whitespace inside the
// value can hide where the URL ends.
test("still trims surrounding whitespace before the delimiter check", () => {
  assert.equal(
    normalizeCopilotBaseUrl("\t  https://gateway.example/tenant/v1  \n"),
    "https://gateway.example/tenant/v1",
  )
})

// Why: this is the decision in one test. The raw apostrophe form must never
// reach policy registration, because once it is in a log line no scrubber can
// recover the tail - the scan ends at the quote. The encoded form is accepted,
// registers normally, and is redacted end to end.
test("rejects the apostrophe form but protects its encoded equivalent", () => {
  const rawHost = "delimiter-raw.test.invalid"
  const encodedHost = "delimiter-encoded.test.invalid"

  // 1. Rejected before anything could register a policy from it.
  assert.throws(
    () =>
      normalizeCopilotBaseUrl(
        `https://${rawHost}/tenant/RAW'APOS_SENTINEL`,
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Invalid copilotBaseUrl/)
      assert.ok(!error.message.includes("APOS_SENTINEL"))
      assert.ok(!error.message.includes(rawHost))
      return true
    },
  )

  // 2. The encoded equivalent is accepted verbatim...
  const encoded = `https://${encodedHost}/tenant/ENC%27APOS_SENTINEL`
  assert.equal(normalizeCopilotBaseUrl(encoded), encoded)

  // ...registers as a policy, and is redacted whole in rendered log text.
  registerSensitiveOrigin(encoded)
  const scrubbed = scrubSensitiveUrls(`{ url: '${encoded}/models' }`)
  assert.ok(
    !scrubbed.includes("APOS_SENTINEL"),
    `encoded form leaked its tail: ${scrubbed}`,
  )
  assert.ok(scrubbed.includes(`https://${encodedHost}[redacted]`), scrubbed)
})
