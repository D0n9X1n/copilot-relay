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
