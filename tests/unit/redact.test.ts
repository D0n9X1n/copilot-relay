import assert from "node:assert/strict"
import test from "node:test"
import { inspect } from "node:util"

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

/**
 * A unique port, for origins whose host cannot carry a counter.
 *
 * localhost and an IPv6 literal are fixed spellings - splicing a counter into
 * either produces something that is not a host at all (`[::1]-3` does not
 * parse). Varying the port keeps the literal intact and still gives every
 * case its own origin, which is what keeps these order-independent.
 */
const uniquePort = (): number => {
  originCounter += 1
  return 20_000 + originCounter
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


// Why: normalizeCopilotBaseUrl accepts `https://host\tenant\TOKEN` - WHATWG
// folds the backslashes into the path, so there is no userinfo and the scheme
// is https - and returns it byte-for-byte. The raw configured form therefore
// reaches the log, and a scanner that stops at a backslash matches only the
// origin, leaves the URL looking origin-only, and prints the whole tail.
test("redacts a raw backslash-normalized url", () => {
  const host = uniqueHost("backslash")
  registerSensitiveOrigin(`https://${host}\\tenant\\BACKSLASH_SECRET`)

  const scrubbed = scrubSensitiveUrls(
    `base https://${host}\\tenant\\BACKSLASH_SECRET`,
  )

  assert.ok(!scrubbed.includes("BACKSLASH_SECRET"), scrubbed)
  assert.equal(scrubbed, `base https://${host}[redacted]`)
})

// Why: the logger renders values through inspect(), which escapes each
// backslash - so the text that actually reaches both sinks carries doubled
// backslashes inside quotes. Built with inspect() rather than hand-written, so
// the fixture is the real logger shape.
test("redacts an inspect-escaped backslash url", () => {
  const host = uniqueHost("inspected-backslash")
  const configured = `https://${host}\\tenant\\INSPECT_SECRET`
  registerSensitiveOrigin(configured)

  const inspected = inspect({
    response: { status: 500, url: `${configured}/models` },
  })
  assert.ok(
    inspected.includes("\\\\"),
    `fixture should carry doubled backslashes: ${inspected}`,
  )

  const scrubbed = scrubSensitiveUrls(inspected)

  assert.ok(!scrubbed.includes("INSPECT_SECRET"), scrubbed)
  assert.ok(scrubbed.includes(`https://${host}[redacted]`), scrubbed)
  // Structure and diagnostics survive.
  assert.ok(scrubbed.includes("status: 500"), scrubbed)
})

// Why: a base URL can mix separators, and the client still appends its own
// endpoint with a forward slash. Matching must span the backslash to reach the
// end of the tail rather than stopping partway through it.
test("redacts a mixed slash and backslash url with an appended endpoint", () => {
  const host = uniqueHost("mixed-backslash")
  registerSensitiveOrigin(`https://${host}/tenant\\MIXED_SECRET`)

  const scrubbed = scrubSensitiveUrls(
    `GET https://${host}/tenant\\MIXED_SECRET/models -> 500`,
  )

  assert.ok(!scrubbed.includes("MIXED_SECRET"), scrubbed)
  assert.equal(scrubbed, `GET https://${host}[redacted] -> 500`)
})

// Why: consuming backslashes must not widen the blast radius. Scope is still
// decided by origin, so a different host and a bare path stay untouched.
test("leaves unrelated backslash urls and detached backslash paths alone", () => {
  const host = uniqueHost("bs-registered")
  const other = uniqueHost("bs-other")
  registerSensitiveOrigin(`https://${host}\\tenant\\SCOPED_SECRET`)

  const detached = "configured path is \\tenant\\SCOPED_SECRET here"
  assert.equal(scrubSensitiveUrls(detached), detached)

  const unrelated = `GET https://${other}\\tenant\\SCOPED_SECRET -> 200`
  assert.equal(scrubSensitiveUrls(unrelated), unrelated)
})

// Why: the marker is ordinary text, and nothing stops it appearing in a real
// path. `https://host/tenant/SECRET[redacted]` is a valid configured value -
// it parses, and brackets are not unsafe delimiters - so a scrubber that
// skipped anything *ending* in the marker handed that URL straight through
// with the secret intact. Redaction must be decided by structure, never by
// trusting text that a configured value can simply contain.
test("redacts a registered url whose path ends in the literal marker", () => {
  const host = uniqueHost("marker-collision")
  registerSensitiveOrigin(`https://${host}/tenant/COLLIDE_SECRET[redacted]`)

  const scrubbed = scrubSensitiveUrls(
    `base https://${host}/tenant/COLLIDE_SECRET[redacted]`,
  )

  assert.ok(!scrubbed.includes("COLLIDE_SECRET"), scrubbed)
  // Canonical origin plus one marker - not a doubled bracket.
  assert.equal(scrubbed, `base https://${host}[redacted]`)
})

// Why: the same collision reaches the log through inspect() output, where the
// URL is quoted and the marker sits just inside the closing quote.
test("redacts a marker-suffixed url inside inspected object text", () => {
  const host = uniqueHost("marker-nested")
  const configured = `https://${host}/tenant/NESTED_COLLIDE[redacted]`
  registerSensitiveOrigin(configured)

  // The base URL itself, with no endpoint appended, so the marker sits at the
  // very end of the match - which is precisely what the old text check keyed
  // on. An appended endpoint would hide the collision.
  const inspected = inspect({
    response: { status: 500, url: configured },
  })
  const scrubbed = scrubSensitiveUrls(inspected)

  assert.ok(!scrubbed.includes("NESTED_COLLIDE"), scrubbed)
  assert.ok(scrubbed.includes(`https://${host}[redacted]`), scrubbed)
  assert.ok(scrubbed.includes("status: 500"), scrubbed)
})

// Why: idempotence used to rest on a text check - skip anything ending in the
// marker - which is exactly the bypass that leaked. It has to hold
// structurally instead: `origin[redacted]` is not a parseable URL, because a
// bracket is illegal in a hostname unless it delimits an IPv6 literal, so a
// second pass simply finds nothing to rewrite. Checked across all three
// origin shapes, since each puts a different thing right before the marker:
// a bare name, a port, and an IPv6 literal that ends in a bracket already.
test("is idempotent structurally across origin shapes", () => {
  const cases = [
    `https://${uniqueHost("idem-host")}`,
    `http://localhost:${uniquePort()}`,
    `https://[::1]:${uniquePort()}`,
  ]

  for (const origin of cases) {
    registerSensitiveOrigin(`${origin}/tenant/IDEM_SECRET`)

    const first = scrubSensitiveUrls(
      `url=${origin}/tenant/IDEM_SECRET/models`,
    )
    const second = scrubSensitiveUrls(first)

    assert.ok(!first.includes("IDEM_SECRET"), first)
    assert.equal(first, `url=${origin}[redacted]`)
    // The whole point: a second pass must not rewrite its own output.
    assert.equal(second, first)
  }
})

// Why: the marker is a word that can legitimately appear in a log line. Only
// absolute URLs on a registered origin are rewritten, so prose that happens
// to contain it - including a bracketed URL list - must survive untouched.
test("leaves unrelated literal marker text alone", () => {
  const other = uniqueHost("marker-prose")
  const prose =
    `the operator wrote [redacted] in the ticket; see https://${other}/status`
  assert.equal(scrubSensitiveUrls(prose), prose)

  const bare = "value was [redacted] before upload"
  assert.equal(scrubSensitiveUrls(bare), bare)
})

// Why: trailing punctuation was trimmed off a match and restored after the
// marker, on the theory that it was prose following the URL. In a query
// string it is not prose - it is the value. `?token=!!!` is a valid
// configured URL whose secret is punctuation and nothing else, so trimming
// handed back the entire token. Arbitrary log text cannot tell a token made
// of punctuation from a sentence that ends in one, so the complete tail goes.
test("redacts a query secret made entirely of punctuation", () => {
  const host = uniqueHost("punct-only")
  registerSensitiveOrigin(`https://${host}/?token=!!!`)

  const scrubbed = scrubSensitiveUrls(`base https://${host}/?token=!!!`)

  assert.ok(!scrubbed.includes("!!!"), scrubbed)
  assert.equal(scrubbed, `base https://${host}[redacted]`)
})

// Why: every character the old heuristic trimmed could equally be the last
// byte of a path or query value. Each is a separate case because each was
// restored verbatim after the marker.
test("redacts tails ending in each trimmed punctuation character", () => {
  const tails = [".", ",", ";", ":", "!", "?", ")", "]", "}"]

  for (const [index, tail] of tails.entries()) {
    const host = uniqueHost(`punct-tail-${index}`)
    const configured = `https://${host}/?a=PUNCT_SECRET${tail}`
    registerSensitiveOrigin(configured)

    const scrubbed = scrubSensitiveUrls(`url=${configured}`)

    assert.ok(
      !scrubbed.includes("PUNCT_SECRET"),
      `tail ${JSON.stringify(tail)} leaked the secret: ${scrubbed}`,
    )
    assert.equal(
      scrubbed,
      `url=https://${host}[redacted]`,
      `tail ${JSON.stringify(tail)} survived after the marker`,
    )
  }
})

// Why: the same punctuation tail reaches the log through inspect() output,
// where the URL is quoted. The closing quote ends the match, so the tail sits
// at the very end of it - exactly where the trim used to fire.
test("redacts a punctuation tail inside inspected object text", () => {
  const host = uniqueHost("punct-nested")
  const configured = `https://${host}/?token=NESTED_PUNCT!!!`
  registerSensitiveOrigin(configured)

  const inspected = inspect({
    response: { status: 502, url: configured },
  })
  const scrubbed = scrubSensitiveUrls(inspected)

  assert.ok(!scrubbed.includes("NESTED_PUNCT"), scrubbed)
  assert.ok(!scrubbed.includes("!!!"), scrubbed)
  assert.ok(scrubbed.includes(`https://${host}[redacted]`), scrubbed)
  assert.ok(scrubbed.includes("status: 502"), scrubbed)
})

// Why: absorbing the tail is only acceptable because it is scoped to origins
// already known to carry a secret. A URL nobody registered is ordinary
// diagnostic data and must read back byte-for-byte, punctuation included -
// otherwise this fix would quietly damage every unrelated log line.
test("leaves an unregistered url with trailing punctuation unchanged", () => {
  const other = uniqueHost("punct-unregistered")

  for (const tail of [".", ")", "]", "}", "!!!"]) {
    const line = `see https://${other}/?a=KEEP${tail}`
    assert.equal(scrubSensitiveUrls(line), line)
  }
})
