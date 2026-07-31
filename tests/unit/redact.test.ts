import assert from "node:assert/strict"
import test from "node:test"

import {
  formatUrlForDisplay,
  registerSensitiveOrigin,
  sanitizeTerminalString,
  scrubSensitiveUrls,
} from "../../src/lib/redact"

// registerSensitiveOrigin writes into a process-lifetime Set that is never
// pruned, so tests must not share origins or they would depend on which file
// ran first. Every case below mints its own host.
let originCounter = 0
const uniqueHost = (label: string): string => {
  originCounter += 1
  return `${label}-${originCounter}.test.invalid`
}

// Why: an origin-only base URL carries nothing secret, so rewriting it would
// only make the log harder to read. The common case must stay verbatim.
test("displays an origin-only url unchanged", () => {
  assert.equal(
    formatUrlForDisplay("https://api.githubcopilot.com"),
    "https://api.githubcopilot.com",
  )
  assert.equal(
    formatUrlForDisplay("http://127.0.0.1:8080"),
    "http://127.0.0.1:8080",
  )
})

// Why: the path is where a gateway credential lives (#47). Display must keep
// the origin — which is the operationally useful half — and say plainly that
// something was withheld rather than silently truncating.
test("hides path, query and fragment behind an explicit marker", () => {
  const rendered = formatUrlForDisplay(
    "https://gateway.example/tenant/token-ABC?key=SECRET#frag-SECRET",
  )
  assert.equal(
    rendered,
    "https://gateway.example (path/query/fragment hidden)",
  )
  assert.ok(!rendered.includes("token-ABC"))
  assert.ok(!rendered.includes("SECRET"))
  // The fragment's content, not the word "fragment" — that appears in the
  // marker by design, which is the point of an explicit marker.
  assert.ok(!rendered.includes("frag-SECRET"))
})

// Why: a trailing slash is not a secret and is the shape most base URLs take.
// Treating "/" as hidden content would put the marker on nearly every install.
test("treats a bare trailing slash as origin-only", () => {
  assert.equal(
    formatUrlForDisplay("https://api.githubcopilot.com/"),
    "https://api.githubcopilot.com/",
  )
})

// Why: display runs on values that failed validation too, so it must never
// throw. An unparseable string is not a URL and has no origin to keep.
test("does not throw on a value that is not a url", () => {
  assert.equal(typeof formatUrlForDisplay("not a url"), "string")
  assert.ok(!formatUrlForDisplay("not a url").includes("undefined"))
})

// Why: status writes config values straight to the terminal. A config string
// carrying raw ANSI or C0 bytes could repaint the screen and fake status rows
// the relay never emitted. #47's companion hardening item.
test("strips ansi escapes and control bytes from terminal output", () => {
  const injected = "\u001B[2K\rhealth     ok\u0007"
  const cleaned = sanitizeTerminalString(injected)
  assert.ok(!cleaned.includes("\u001B"))
  assert.ok(!cleaned.includes("\r"))
  assert.ok(!cleaned.includes("\u0007"))
  assert.equal(cleaned, "health     ok")

  assert.equal(sanitizeTerminalString("plain value"), "plain value")
  assert.ok(!sanitizeTerminalString("a\u007Fb").includes("\u007F"))
  assert.ok(!sanitizeTerminalString("a\u0000b").includes("\u0000"))
})

// Why: with no policy registered, scrubbing must be a no-op. Redacting URLs
// nobody marked sensitive would destroy ordinary diagnostics.
test("leaves urls from unregistered origins untouched", () => {
  const text = "GET https://api.githubcopilot.com/models -> 500"
  assert.equal(scrubSensitiveUrls(text), text)
})

// Why: registering an origin-only URL means there is no secret tail to hide.
// Adding its origin to the policy would redact every future URL on that host
// for no benefit.
test("registering an origin-only url adds no policy", () => {
  const host = uniqueHost("origin-only")
  registerSensitiveOrigin(`https://${host}`)

  const text = `GET https://${host}/models -> 500`
  assert.equal(scrubSensitiveUrls(text), text)
})

// Why: the core of #47. Once an origin is known to carry a secret in its path,
// every URL on that origin must keep only the origin, whatever tail the
// upstream client appended.
test("redacts everything after the origin for a registered origin", () => {
  const host = uniqueHost("secretpath")
  registerSensitiveOrigin(`https://${host}/tenant/token-ABC`)

  assert.equal(
    scrubSensitiveUrls(`base https://${host}/tenant/token-ABC`),
    `base https://${host}[redacted]`,
  )
  // The appended endpoint case: chat.ts fetches `${base}/chat/completions`.
  assert.equal(
    scrubSensitiveUrls(`GET https://${host}/tenant/token-ABC/models -> 500`),
    `GET https://${host}[redacted] -> 500`,
  )
})

// Why: fetch canonicalizes the URL it reports back — host case folded, a
// default port dropped. Anchoring on the parsed origin rather than the
// registered text is what makes those variants match.
test("matches canonicalized host and default-port variants", () => {
  const host = uniqueHost("canon")
  registerSensitiveOrigin(`https://${host.toUpperCase()}:443/tenant/SECRET`)

  const scrubbed = scrubSensitiveUrls(
    `url: https://${host}/tenant/SECRET/chat/completions`,
  )
  assert.ok(!scrubbed.includes("SECRET"))
  assert.ok(scrubbed.includes("[redacted]"))
})

// Why: fetch drops the fragment before sending, so response.url comes back
// without it. Origin anchoring covers that without needing the exact string.
test("redacts a url whose fragment fetch already dropped", () => {
  const host = uniqueHost("frag")
  registerSensitiveOrigin(`https://${host}/base#FRAGSECRET`)

  const scrubbed = scrubSensitiveUrls(`url: https://${host}/base/models`)
  assert.ok(!scrubbed.includes("FRAGSECRET"))
  assert.equal(scrubbed, `url: https://${host}[redacted]`)
})

// Why: policies accumulate across hot reloads and are never removed, so a
// request still in flight against the previous base URL stays protected after
// the config changes. Re-registering the same origin must not double-add.
test("keeps old policies after registering a new one, idempotently", () => {
  const oldHost = uniqueHost("old")
  const newHost = uniqueHost("new")
  registerSensitiveOrigin(`https://${oldHost}/tenant/OLD_SECRET`)
  registerSensitiveOrigin(`https://${newHost}/tenant/NEW_SECRET`)
  registerSensitiveOrigin(`https://${oldHost}/tenant/OLD_SECRET`)

  const scrubbed = scrubSensitiveUrls(
    `old=https://${oldHost}/tenant/OLD_SECRET new=https://${newHost}/tenant/NEW_SECRET`,
  )
  assert.ok(!scrubbed.includes("OLD_SECRET"))
  assert.ok(!scrubbed.includes("NEW_SECRET"))
  assert.equal(
    scrubbed,
    `old=https://${oldHost}[redacted] new=https://${newHost}[redacted]`,
  )
})

// Why: substituting the secret path wherever it appeared would also rewrite
// unrelated prose. Only absolute URLs on a registered origin are rewritten;
// a bare path that happens to match is left alone.
test("does not substitute detached paths or unrelated origins", () => {
  const host = uniqueHost("detached")
  const other = uniqueHost("other")
  registerSensitiveOrigin(`https://${host}/tenant/DETACHED`)

  // A detached path with no origin in front of it is not a URL match.
  const detached = "configured path is /tenant/DETACHED here"
  assert.equal(scrubSensitiveUrls(detached), detached)

  // A different origin is a different policy.
  const unrelated = `GET https://${other}/tenant/DETACHED -> 200`
  assert.equal(scrubSensitiveUrls(unrelated), unrelated)
})

// Why: the logger hands scrubSensitiveUrls whatever inspect() produced, so the
// URL arrives wrapped in quotes and object punctuation. Matching must survive
// that without eating the surrounding structure.
test("redacts a url nested inside inspected object text", () => {
  const host = uniqueHost("nested")
  registerSensitiveOrigin(`https://${host}/tenant/NESTED_SECRET`)

  const inspected = `{ response: { status: 500, url: 'https://${host}/tenant/NESTED_SECRET/models', body: 'upstream boom' } }`
  const scrubbed = scrubSensitiveUrls(inspected)

  assert.ok(!scrubbed.includes("NESTED_SECRET"))
  // Structure and useful diagnostics survive.
  assert.ok(scrubbed.includes("status: 500"))
  assert.ok(scrubbed.includes("body: 'upstream boom'"))
  assert.ok(scrubbed.endsWith("} }"))
  assert.ok(scrubbed.includes(`'https://${host}[redacted]'`))
})

// Why: these run on live log arguments and on status output. Mutating a caller's
// string or leaking state between calls would corrupt what is being reported.
test("is pure: repeated calls agree and inputs are unchanged", () => {
  const host = uniqueHost("pure")
  registerSensitiveOrigin(`https://${host}/tenant/PURE_SECRET`)

  const input = `url=https://${host}/tenant/PURE_SECRET/models`
  const first = scrubSensitiveUrls(input)
  const second = scrubSensitiveUrls(input)

  assert.equal(first, second)
  assert.equal(input, `url=https://${host}/tenant/PURE_SECRET/models`)
  // Already-scrubbed text is stable under a second pass.
  assert.equal(scrubSensitiveUrls(first), first)
})
