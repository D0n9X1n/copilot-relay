import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Why: wiki/ is the only in-repo documentation tree and the source for the
// GitHub Wiki tab. This suite pins the structural contract that makes that
// true -- flatness, EN/ZH parity, resolvable links, and a publish transform
// that leaves no broken link behind. It imports nothing from src/; Python
// subprocesses use temporary folders with both HOME and USERPROFILE isolated.
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

const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3")

// Execute production publishing code, never a second copy of its transform.
const runWikiScript = (script: string, args: string[], home: string): void => {
  const result = spawnSync(python, [path.join(repoRoot, "scripts", script), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

test("wiki publishing preserves code examples and verifies real navigation fixtures", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wiki-fixtures-"))
  try {
    runWikiScript("publish-wiki_tests.py", [], home)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

// Build validates source .md links, flat targets and no cross-page anchors;
// verify checks the extensionless published targets using that same code parser.
test("the actual publish script validates source and published navigation", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wiki-publish-"))
  const destination = path.join(home, "wiki")
  fs.mkdirSync(destination)
  try {
    runWikiScript("publish-wiki.py", ["build", wikiDir, destination], home)
    assert.ok(fs.existsSync(path.join(destination, "Home.md")))
    assert.equal(fs.existsSync(path.join(destination, "README.md")), false)
    runWikiScript("publish-wiki.py", ["verify", destination], home)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("wiki workflow and verification guides use the shared publishing script", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github/workflows/publish-wiki.yml"), "utf8")
  assert.match(workflow, /"scripts\/publish-wiki\.py"/)
  assert.match(workflow, /"scripts\/publish-wiki_tests\.py"/)
  assert.match(workflow, /actions\/setup-python@/)
  assert.match(workflow, /python3 scripts\/publish-wiki\.py build wiki wiki-repo/)
  assert.match(workflow, /python3 scripts\/publish-wiki\.py verify wiki-repo/)
  assert.doesNotMatch(workflow, /sed -i|find wiki-repo|cp wiki\/\*\.md/)
  for (const name of ["CLAUDE.md", "wiki/EN-Development.md", "wiki/ZH-Development.md"]) {
    const body = fs.readFileSync(path.join(repoRoot, name), "utf8")
    assert.ok(body.includes("python3 scripts/publish-wiki.py verify /tmp/relay-wiki"), name)
    assert.doesNotMatch(body, /grep -rn/, name)
  }
})

test("paired architecture guides use Mermaid for overview, request, and lifecycle flows", () => {
  for (const language of ["EN", "ZH"]) {
    const architecture = readPage(`${language}-Architecture.md`)
    const overview = readPage(`${language}-How-It-Works.md`)
    for (const body of [architecture, overview].flatMap(text => [
      text.replace(/\r\n/g, "\n"), text.replace(/\r?\n/g, "\r\n"),
    ])) {
      assert.match(body, /```mermaid\r?\nflowchart/)
      assert.match(body, /```mermaid\r?\nsequenceDiagram/)
      assert.doesNotMatch(body, /```text\r?\nClaude Code/)
      assert.ok(body.includes("`src/start.ts`"))
      assert.ok(body.includes("`startRelay`"))
      assert.ok(body.includes("`src/routes/claude.ts`"))
      assert.ok(body.includes("`claudeRoutes`"))
      assert.ok(body.includes("SIGTERM"))
      assert.ok(body.includes("closeIdleConnections"))
    }
    assert.ok(architecture.includes("`findRelayOnPort`"))
    assert.ok(architecture.includes("`findRelayProcessIds`"))
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

// Why: Copilot availability and effort tiers are account-specific. The local
// relay endpoint only echoes config, so both language guides must preserve the
// live picker workflow and a direct, token-safe way to update all model knobs.
test("README stays a concise feature overview and quick start with valid Wiki links", () => {
  const body = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8")
  assert(body.split("\n").length <= 80)
  assert.doesNotMatch(body, /\bv\d+\.\d+\.\d+\b/, "README describes current features, not release-version requirements")
  for (const required of ["## Features", "## Quick start", "copilot-relay auth", "copilot-relay start", "models --deep", "Wiki"]) assert(body.includes(required))
  for (const match of body.matchAll(/\]\((wiki\/[^)#]+)\)/g)) assert(fs.existsSync(path.join(repoRoot, match[1]!)))
})

test("Configuration documents live model discovery and simple updates", () => {
  for (const page of ["EN-Configuration.md", "ZH-Configuration.md"]) {
    const body = readPage(page)

    assert.match(body, /^opusModel: claude-opus-5\.5$/m)
    assert.match(body, /tool_choice/)
    assert.match(body, /^\| `claude-opus-5\.5`[^\n|]*\| 1,000,000 \| 1,000,000 \| 128,000 \|$/m)
    for (const required of [
      "/model",
      "GET /v1/models",
      "gpt-6-astra",
      "claude-opus-5.5",
      "thinkEffort",
      "yq -i",
      "copilot-relay restart",
      "models --deep",
      "--total-timeout",
      "SENT/REPORTED",
      "NOT_TESTED",
      "130",
      "[1m]",
    ]) {
      assert.ok(
        body.includes(required),
        `wiki/${page} must document ${required}`,
      )
    }
  }
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
