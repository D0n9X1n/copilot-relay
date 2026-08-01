import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Why: wiki/ is the only in-repo documentation tree and the source for the
// GitHub Wiki tab. This suite pins the structural contract that makes that
// true -- flatness, EN/ZH parity, resolvable links, and a publish transform
// that leaves no broken link behind. It reads the repository from disk and
// imports nothing from src/, so it needs no home-directory redirect.
const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")
const wikiDir = path.join(repoRoot, "wiki")

const listWikiEntries = (): fs.Dirent[] =>
  fs.readdirSync(wikiDir, { withFileTypes: true })

const wikiPages = (): string[] =>
  listWikiEntries()
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort()

const readPage = (name: string): string =>
  fs.readFileSync(path.join(wikiDir, name), "utf8")

// Matches the markdown inline links the publish workflow's sed rewrites:
// ](Some-Page.md). Anything with a path separator, an anchor, or a scheme is
// deliberately excluded here and asserted against separately.
const simplePageLinkPattern = /\]\(([A-Za-z0-9-]+)\.md\)/g

// Any relative markdown link, including ones the transform cannot rewrite.
const relativeMarkdownLinkPattern = /\]\((?!https?:\/\/|#)([^)\s]+\.md(?:#[^)\s]*)?)\)/g

// Strip fenced blocks first, then inline code spans. Markdown inside backticks
// is not a link -- the Development pages document the cross-page-anchor rule by
// showing `](EN-Internals.md#section)` verbatim, and scanning that as a real
// link would make the rule impossible to write down.
const stripCode = (markdown: string): string =>
  markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")

// Why: the docs/ tree is gone, so nothing tracked may point a reader at it.
// External URLs are stripped first so docs.anthropic.com and docs.github.com --
// including path segments like /en/docs/claude-code -- survive untouched.
const stripUrls = (line: string): string => line.replace(/https?:\/\/\S+/g, "")
const internalDocsReferencePattern = /(?<![\w.])docs\/[A-Za-z0-9._-]/

test("docs/ directory no longer exists", () => {
  assert.equal(
    fs.existsSync(path.join(repoRoot, "docs")),
    false,
    "docs/ must be deleted; wiki/ is the only in-repo documentation tree",
  )
})

test("wiki/ is flat", () => {
  const directories = listWikiEntries()
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  assert.deepEqual(
    directories,
    [],
    "wiki/ must stay flat: the publish workflow only copies top-level wiki/*.md",
  )
})

test("every EN page has a ZH counterpart and vice versa", () => {
  const pages = wikiPages()
  const english = pages
    .filter((name) => name.startsWith("EN-"))
    .map((name) => name.slice("EN-".length))
  const chinese = pages
    .filter((name) => name.startsWith("ZH-"))
    .map((name) => name.slice("ZH-".length))

  assert.deepEqual(
    english,
    chinese,
    "English and 中文 pages must stay synchronized as matching pairs",
  )
})

test("the consolidated documentation pages exist in both languages", () => {
  const pages = new Set(wikiPages())

  for (const required of [
    "EN-Architecture.md",
    "ZH-Architecture.md",
    "EN-Internals.md",
    "ZH-Internals.md",
    "EN-Development.md",
    "ZH-Development.md",
    "EN-Logging-Troubleshooting.md",
    "ZH-Logging-Troubleshooting.md",
    "EN-How-It-Works.md",
    "ZH-How-It-Works.md",
    "EN-Configuration.md",
    "ZH-Configuration.md",
    "README.md",
  ]) {
    assert.ok(pages.has(required), `wiki/${required} must exist`)
  }
})

test("every relative markdown link resolves to a file that exists", () => {
  const pages = wikiPages()

  for (const page of pages) {
    const body = stripCode(readPage(page))

    for (const match of body.matchAll(relativeMarkdownLinkPattern)) {
      const target = match[1] ?? ""
      const [file] = target.split("#")

      assert.ok(
        fs.existsSync(path.join(wikiDir, file ?? "")),
        `wiki/${page} links to ${target}, which does not exist`,
      )
    }
  }
})

// Why: the publish workflow's sed only rewrites ](Page.md). A link written as
// ](Page.md#anchor) keeps its .md on the wiki tab and 404s there, so the source
// must never contain one. Same-page #anchor links are untouched and fine.
test("no cross-page link carries an anchor the publish transform cannot strip", () => {
  for (const page of wikiPages()) {
    const body = stripCode(readPage(page))

    for (const match of body.matchAll(relativeMarkdownLinkPattern)) {
      const target = match[1] ?? ""

      assert.ok(
        !target.includes("#"),
        `wiki/${page} links to ${target}; publish-wiki.yml cannot strip .md from an anchored link`,
      )
    }
  }
})

test("relative markdown links stay flat and extensionless-ready", () => {
  for (const page of wikiPages()) {
    const body = stripCode(readPage(page))

    for (const match of body.matchAll(relativeMarkdownLinkPattern)) {
      const target = match[1] ?? ""

      assert.ok(
        !target.includes("/"),
        `wiki/${page} links to ${target}; wiki links must be flat page names`,
      )
    }
  }
})

// Why: reproduces .github/workflows/publish-wiki.yml in memory -- README.md
// becomes Home.md and ](Page.md) loses its extension -- then asserts the
// published tree has no internal .md link left and every target exists.
test("the publish transform leaves no broken link on the wiki tab", () => {
  const published = new Map<string, string>()

  for (const page of wikiPages()) {
    const publishedName = page === "README.md" ? "Home.md" : page
    published.set(publishedName, readPage(page).replace(simplePageLinkPattern, "]($1)"))
  }

  assert.ok(published.has("Home.md"), "wiki/README.md must publish as Home.md")

  for (const [name, body] of published) {
    const withoutCode = stripCode(body)

    for (const match of withoutCode.matchAll(relativeMarkdownLinkPattern)) {
      assert.fail(
        `published ${name} still contains an internal .md link: ${match[1]}`,
      )
    }

    // Every rewritten page link must name a page that was actually published.
    for (const match of withoutCode.matchAll(/\]\((?!https?:\/\/|#)([A-Za-z0-9-]+)\)/g)) {
      const target = `${match[1]}.md`
      const resolved = target === "README.md" ? "Home.md" : target

      assert.ok(
        published.has(resolved) || published.has(target),
        `published ${name} links to ${match[1]}, which is not a published page`,
      )
    }
  }
})

test("no tracked file points at the removed docs/ tree", () => {
  const skipDirectories = new Set([
    ".git",
    "node_modules",
    "dist",
    ".claude",
    "coverage",
  ])

  const offenders: string[] = []

  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)

      if (entry.isDirectory()) {
        if (!skipDirectories.has(entry.name)) walk(absolute)
        continue
      }

      if (!/\.(ts|js|md|yaml|yml|json)$/.test(entry.name)) continue

      const relative = path.relative(repoRoot, absolute)
      if (relative === path.join("tests", "unit", "wiki-docs.test.ts")) continue

      const lines = fs.readFileSync(absolute, "utf8").split("\n")

      lines.forEach((line, index) => {
        if (internalDocsReferencePattern.test(stripUrls(line))) {
          offenders.push(`${relative}:${index + 1}: ${line.trim()}`)
        }
      })
    }
  }

  walk(repoRoot)

  assert.deepEqual(
    offenders,
    [],
    `these tracked files still reference the removed docs/ tree:\n${offenders.join("\n")}`,
  )
})

// Why: CLAUDE.md tells agents not to add routes outside the surface it lists,
// so a route the server actually registers but the list omits reads as
// forbidden. src/server.ts registers GET|HEAD /api/hello -- Claude Code's
// reachability probe -- and an agent trusting an incomplete list could remove
// it. The list must name every current surface.
test("CLAUDE.md names every public API surface the server registers", () => {
  const claudeMd = fs.readFileSync(path.join(repoRoot, "CLAUDE.md"), "utf8")
  const publicApiSection = claudeMd.split("## Public API")[1] ?? ""

  assert.notEqual(publicApiSection, "", "CLAUDE.md must have a Public API section")

  for (const surface of [
    "POST /v1/messages",
    "POST /v1/messages/count_tokens",
    "GET /v1/models",
    "GET /healthz",
    "GET|HEAD /api/hello",
  ]) {
    assert.ok(
      publicApiSection.includes(surface),
      `CLAUDE.md Public API section must name ${surface}`,
    )
  }
})


// Why: /v1/models maps config and never contacts Copilot, so an expired token
// or a denied model passes it. Telling a user with an auth/model-access error
// to "re-check /v1/models" sends them to a probe that cannot detect the thing
// they are debugging. Only POST /v1/messages -- via `status --deep` or real
// traffic -- exercises token refresh and upstream model access.
test("auth troubleshooting sends users to a probe that reaches upstream", () => {
  // The 400/500 section is where an auth or model-access error surfaces.
  const sectionOf = (body: string, heading: string): string => {
    const after = body.split(heading)[1] ?? ""
    return after.split("\n## ")[0] ?? ""
  }

  const pages: [string, string][] = [
    ["EN-Logging-Troubleshooting.md", "## Request returns 400 or 500"],
    ["ZH-Logging-Troubleshooting.md", "## 请求返回 400 或 500"],
  ]

  for (const [page, heading] of pages) {
    const section = sectionOf(readPage(page), heading)

    assert.notEqual(section, "", `${page} must have the 400/500 section`)

    assert.ok(
      section.includes("status --deep"),
      `wiki/${page} 400/500 section must point at status --deep, the only check that reaches upstream`,
    )

    // Reject directing the reader back to the local listing to confirm auth.
    for (const misdirection of ["re-check `/v1/models`", "再检查一次 `/v1/models`"]) {
      assert.ok(
        !section.includes(misdirection),
        `wiki/${page} must not tell users to verify auth with /v1/models; it never contacts Copilot`,
      )
    }
  }
})

// Why: wiki/ is browsed in the repository as well as published. GitHub resolves
// ](EN-Internals.md) in the folder view but 404s on ](EN-Internals); the wiki
// tab is the reverse. The publish workflow's sed is the only thing allowed to
// drop the extension, so source must always carry it -- an extensionless page
// link is broken for every reader of the repo.
const publishedPageNames = (): Set<string> => {
  const names = new Set<string>()

  for (const page of wikiPages()) {
    names.add(page.slice(0, -".md".length))
  }

  // README.md publishes as Home.md, so an author may reach for either name.
  // Both name a page, and neither resolves in source without .md.
  names.add("Home")

  return names
}

// True when a target names a wiki page but omits the .md the repository view
// needs. Pure, so the rule can be fixture-tested without touching the repo.
const isExtensionlessPageLink = (
  target: string,
  pageNames: Set<string>,
): boolean => {
  if (target.startsWith("#")) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return false

  const file = target.split("#")[0] ?? ""

  if (file === "" || file.endsWith(".md")) return false

  return pageNames.has(file)
}

test("the extensionless-link rule accepts and rejects the right targets", () => {
  const pageNames = new Set(["EN-Internals", "README", "Home"])

  for (const rejected of ["EN-Internals", "README", "Home", "EN-Internals#top"]) {
    assert.ok(
      isExtensionlessPageLink(rejected, pageNames),
      `${rejected} names a wiki page without .md and must be rejected`,
    )
  }

  for (const accepted of [
    "EN-Internals.md",
    "EN-Internals.md#streaming",
    "https://github.com/D0n9X1n/copilot-relay",
    "https://example.com/EN-Internals",
    "mailto:someone@example.com",
    "#same-page-anchor",
    "LICENSE",
    "diagram.png",
  ]) {
    assert.ok(
      !isExtensionlessPageLink(accepted, pageNames),
      `${accepted} must be accepted by the extensionless-link rule`,
    )
  }
})

test("every wiki link to a page carries .md in source", () => {
  const pageNames = publishedPageNames()
  const offenders: string[] = []

  for (const page of wikiPages()) {
    const body = stripCode(readPage(page))

    for (const match of body.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1] ?? ""

      if (isExtensionlessPageLink(target, pageNames)) {
        offenders.push(`wiki/${page} -> ${target}`)
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these links omit .md and break when browsing wiki/ in the repository:\n${offenders.join("\n")}`,
  )
})

// Why: prompt_cache_key is SHA-256 derived and exposes nothing, but
// buildResponsesRequestPayload ALSO sets `user: sanitizeUserIdentifier(...)`,
// and sanitizeUserIdentifier only truncates to 64 chars -- it does not hash.
// Documenting the hashed key as though it were the whole story reads as an
// anonymization guarantee the relay does not make.
test("prompt-cache docs separate the hashed key from the forwarded user field", () => {
  const sectionOf = (body: string, heading: string): string => {
    const after = body.split(heading)[1] ?? ""
    return after.split("\n## ")[0] ?? ""
  }

  const pages: [string, string, string[]][] = [
    [
      "EN-Internals.md",
      "## Prompt caching",
      ["Keys are SHA-256 hashed, so the raw id is never forwarded upstream"],
    ],
    [
      "ZH-Internals.md",
      "## Prompt 缓存",
      ["因此原始 id 永远不会转发到上游"],
    ],
  ]

  for (const [page, heading, falseClaims] of pages) {
    const section = sectionOf(readPage(page), heading)

    assert.notEqual(section, "", `${page} must have a prompt caching section`)

    for (const claim of falseClaims) {
      assert.ok(
        !section.includes(claim),
        `wiki/${page} claims the identifier is never forwarded; responses.ts sends it in the user field`,
      )
    }

    assert.ok(
      section.includes("prompt_cache_key"),
      `wiki/${page} must name prompt_cache_key`,
    )

    assert.ok(
      /SHA-256/.test(section),
      `wiki/${page} must say the cache key is SHA-256 derived`,
    )

    // The separately forwarded identifier must be described, with its limit.
    assert.ok(
      /`user`/.test(section),
      `wiki/${page} must document the separate upstream user field`,
    )

    assert.ok(
      section.includes("64"),
      `wiki/${page} must state the identifier is truncated to 64 characters`,
    )
  }
})

// Why: src/lib/log.ts pipes every emitted value through scrubSensitiveUrls
// before either sink, so secret-bearing upstream URL tails are redacted at
// every level including debug. Saying diagnostics are logged "without
// redaction" is false. The real hazard is different and still real: debug
// payloads carry prompt text, tool definitions, and request bodies, which no
// URL scrubber touches.
test("Architecture logging sections describe redaction accurately", () => {
  const sectionOf = (body: string, heading: string): string => {
    const after = body.split(heading)[1] ?? ""
    return after.split("\n## ")[0] ?? ""
  }

  const pages: [string, string, string[]][] = [
    [
      "EN-Architecture.md",
      "\n## Logging",
      ["request diagnostics are logged without\nredaction"],
    ],
    [
      "ZH-Architecture.md",
      "\n## 日志",
      ["请求诊断会**不做脱敏**地记录"],
    ],
  ]

  for (const [page, heading, falseClaims] of pages) {
    const section = sectionOf(readPage(page), heading)

    assert.notEqual(section, "", `${page} must have a logging section`)

    for (const claim of falseClaims) {
      assert.ok(
        !section.includes(claim),
        `wiki/${page} claims debug logs are unredacted; log.ts scrubs URL tails at every level`,
      )
    }

    // The URL redaction that does happen must be stated.
    assert.ok(
      /scrubSensitiveUrls|redact|脱敏/.test(section),
      `wiki/${page} logging section must say upstream URL tails are redacted`,
    )

    // And the hazard a URL scrubber cannot address must survive.
    assert.ok(
      /prompt|tool|payload|提示词|工具|请求体/.test(section),
      `wiki/${page} must warn that debug payloads carry prompts and tool data`,
    )
  }
})
