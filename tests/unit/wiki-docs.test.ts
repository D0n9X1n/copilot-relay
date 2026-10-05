import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

// Why: wiki/ is the only in-repo documentation tree and the source for the
// GitHub Wiki tab. This suite pins the structural contract that makes that
// true -- flatness, EN/ZH parity, resolvable links, a publish transform that
// leaves no broken link behind, and Commands pages that cover every command. It
// imports nothing from src/: command definitions are parsed with the TypeScript
// compiler API. Python subprocesses use temporary folders with both HOME and
// USERPROFILE isolated.
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
    "EN-Commands.md",
    "ZH-Commands.md",
    "EN-Prompt-Caching.md",
    "ZH-Prompt-Caching.md",
    "README.md",
  ]) {
    assert.ok(pages.has(required), `wiki/${required} must exist`)
  }
})

// The Commands pages are the reference for every command and option.
const sourceFile = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)

// The key of an object literal property, or undefined for a spread or a computed key.
const propertyKey = (property: ts.ObjectLiteralElementLike): string | undefined => {
  if (ts.isSpreadAssignment(property)) {
    return undefined
  }

  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
    return property.name.text
  }

  return undefined
}

// A spread or a computed key could supply the property under a name this cannot read, so the
// lookup fails rather than report the property missing.
const findProperty = (
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.ObjectLiteralElementLike | undefined => {
  if (object.properties.some((property) => propertyKey(property) === undefined)) {
    throw new Error(`${object.getSourceFile().fileName}: an object literal has a spread or a computed key`)
  }

  return object.properties.find((property) => propertyKey(property) === name)
}

// The object literal passed to citty's defineCommand; each command file makes exactly one call.
const commandDefinition = (file: string): ts.ObjectLiteralExpression => {
  const found: ts.ObjectLiteralExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineCommand") {
      const argument = node.arguments[0]
      if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
        throw new Error(`${file}: defineCommand takes an object literal`)
      }

      found.push(argument)
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile(file))
  if (found.length !== 1) {
    throw new Error(`${file}: expected one defineCommand call, found ${found.length}`)
  }

  return found[0]
}

// Each named import from a relative module, by local name, resolved to its .ts file.
const relativeImports = (file: string): Map<string, string> => {
  const imports = new Map<string, string>()
  for (const statement of sourceFile(file).statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue
    }

    const specifier = statement.moduleSpecifier.text
    const bindings = statement.importClause?.namedBindings
    if (!specifier.startsWith("./") || bindings === undefined || !ts.isNamedImports(bindings)) {
      continue
    }

    for (const element of bindings.elements) {
      imports.set(element.name.text, path.join(path.dirname(file), `${specifier}.ts`))
    }
  }

  return imports
}

const isBooleanLiteral = (node: ts.Expression): boolean =>
  node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword

// How citty's --help names each option and positional argument of a command: an option as
// --name; a positional as <NAME>, or [NAME] when it is optional (required: false or a default).
const argumentLabels = (file: string): string[] => {
  const args = findProperty(commandDefinition(file), "args")
  if (args === undefined) {
    return []
  }

  if (!ts.isPropertyAssignment(args) || !ts.isObjectLiteralExpression(args.initializer)) {
    throw new Error(`${file}: args must be an object literal`)
  }

  return args.initializer.properties.map((property) => {
    const name = propertyKey(property)
    if (name === undefined || !ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) {
      throw new Error(`${file}: each argument must be a named object literal`)
    }

    const argumentType = findProperty(property.initializer, "type")
    if (argumentType === undefined || !ts.isPropertyAssignment(argumentType) || !ts.isStringLiteral(argumentType.initializer)) {
      throw new Error(`${file}: argument ${name} needs a literal type`)
    }

    if (argumentType.initializer.text !== "positional") {
      return `--${name}`
    }

    const required = findProperty(property.initializer, "required")
    if (required !== undefined && (!ts.isPropertyAssignment(required) || !isBooleanLiteral(required.initializer))) {
      throw new Error(`${file}: argument ${name} needs a literal required`)
    }

    const hasDefault = findProperty(property.initializer, "default") !== undefined
    const markedOptional = required !== undefined
      && ts.isPropertyAssignment(required)
      && required.initializer.kind === ts.SyntaxKind.FalseKeyword

    return hasDefault || markedOptional ? `[${name.toUpperCase()}]` : `<${name.toUpperCase()}>`
  })
}

// The commands src/main.ts registers, by name, each with its argument labels.
const registeredCommands = (): Map<string, string[]> => {
  const mainFile = path.join(repoRoot, "src", "main.ts")
  const imports = relativeImports(mainFile)
  const subCommands = findProperty(commandDefinition(mainFile), "subCommands")
  if (subCommands === undefined || !ts.isPropertyAssignment(subCommands) || !ts.isObjectLiteralExpression(subCommands.initializer)) {
    throw new Error("src/main.ts: subCommands must be an object literal")
  }

  const commands = new Map<string, string[]>()
  for (const property of subCommands.initializer.properties) {
    if (!ts.isShorthandPropertyAssignment(property)) {
      throw new Error("src/main.ts: each command must be registered as a shorthand property")
    }

    const name = property.name.text
    const file = imports.get(name)
    if (file === undefined) {
      throw new Error(`src/main.ts: ${name} is not imported from a relative module`)
    }

    commands.set(name, argumentLabels(file))
  }

  return commands
}

// Each "## `name`" section of a Commands page, by command name.
const commandSections = (body: string): Map<string, string> => {
  const sections = new Map<string, string>()
  for (const section of body.split(/^## /m).slice(1)) {
    const heading = section.split("\n", 1)[0]
    const match = /^`([a-z]+)`\s*$/.exec(heading)
    if (match?.[1] === undefined) {
      continue
    }

    assert.equal(sections.has(match[1]), false, `the ${match[1]} section appears twice`)
    sections.set(match[1], section)
  }

  return sections
}

test("each Commands page documents every registered command and its options", () => {
  const commands = registeredCommands()

  assert.ok(commands.size > 0, "src/main.ts must register commands")
  for (const page of ["EN-Commands.md", "ZH-Commands.md"]) {
    const sections = commandSections(readPage(page))

    assert.deepEqual(
      [...sections.keys()].sort(),
      [...commands.keys()].sort(),
      `wiki/${page} must have one section for each command src/main.ts registers`,
    )

    for (const [name, labels] of commands) {
      for (const label of labels) {
        assert.ok(
          sections.get(name)?.includes(`\`${label}\``),
          `wiki/${page} must name ${label} in the ${name} section`,
        )
      }
    }
  }
})

test("the Commands coverage check reads literal definitions and rejects shapes it cannot read", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-commands-"))
  const write = (name: string, definition: string): string => {
    const file = path.join(directory, name)
    fs.writeFileSync(file, `import { defineCommand } from "citty"\nexport const command = defineCommand(${definition})\n`)
    return file
  }

  try {
    assert.deepEqual(
      argumentLabels(write("literal.ts", `{ args: { extra: { type: "boolean" }, target: { type: "positional", required: true }, search: { type: "positional", required: false }, since: { type: "positional", default: "1d" } } }`)),
      ["--extra", "<TARGET>", "[SEARCH]", "[SINCE]"],
    )

    assert.throws(() => argumentLabels(write("outer-spread.ts", `{ ...{ args: { extra: { type: "boolean" } } } }`)), /spread or a computed key/)
    assert.throws(() => argumentLabels(write("computed-key.ts", `{ ["args"]: { extra: { type: "boolean" } } }`)), /spread or a computed key/)
    assert.throws(() => argumentLabels(write("args-spread.ts", `{ args: { ...{ extra: { type: "boolean" } } } }`)), /named object literal/)
    assert.throws(() => argumentLabels(write("option-spread.ts", `{ args: { extra: { ...{ type: "boolean" } } } }`)), /spread or a computed key/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
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

// The style rules live in prose and in a test; every guide must name the enforcing test.
test("contributor guides point at the test that enforces the code style", () => {
  for (const name of ["CLAUDE.md", "wiki/EN-Development.md", "wiki/ZH-Development.md"]) {
    const body = fs.readFileSync(path.join(repoRoot, name), "utf8")
    assert.ok(body.includes("tests/unit/code-style.test.ts"), `${name} does not name the enforcing test`)
  }
})

test("paired architecture guides use Mermaid for overview, request, and lifecycle flows", () => {
  for (const language of ["EN", "ZH"]) {
    const architecture = readPage(`${language}-Architecture.md`)
    const overview = readPage(`${language}-How-It-Works.md`)

    // A checkout may carry either line ending, so each page is checked as LF and as CRLF.
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
        if (!skipDirectories.has(entry.name)) {
          walk(absolute)
        }

        continue
      }

      if (!/\.(ts|js|md|yaml|yml|json)$/.test(entry.name)) {
        continue
      }

      const relative = path.relative(repoRoot, absolute)
      if (relative === path.join("tests", "unit", "wiki-docs.test.ts")) {
        continue
      }

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
test("Claude Code picker examples expose the same Opus and Astra choices in both languages", () => {
  const examples = ["EN-Configuration.md", "ZH-Configuration.md"].map((name) => {
    const page = readPage(name)
    const snippets = [...page.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)]
      .map((match) => JSON.parse(match[1]) as Record<string, any>)
    const settings = snippets.find((value) => value.modelPicker)

    assert(settings, `${name} needs a complete model-picker settings example`)
    assert.equal(settings.model, "gpt-6-astra[1m]")
    assert.deepEqual(settings.availableModels, ["opus", "gpt-6-astra[1m]"])
    assert.equal(settings.modelPicker.replaceBuiltInOptions, true)
    assert.deepEqual(settings.modelPicker.options, [
      { model: "opus", label: "Opus" },
      { model: "gpt-6-astra[1m]", label: "GPT-6 Astra" },
    ])
    assert.equal(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-opus-5.5")
    assert.match(page, /2\.1\.242/)
    assert.match(page, /https:\/\/code\.claude\.com\/docs\/en\/settings-reference#modelpicker/)
    return settings
  })

  assert.deepEqual(examples[0], examples[1])
})

test("both guides recommend a bounded auto-compact window with explicit limits", () => {
  for (const name of ["EN-Configuration.md", "ZH-Configuration.md"]) {
    const page = readPage(name)
    for (const text of ["/autocompact 800k", "--autocompact 800k", '"autoCompactWindow": 800000', "CLAUDE_CODE_AUTO_COMPACT_WINDOW=800000", "/autocompact auto", "872", "128", "https://code.claude.com/docs/en/model-config"]) {
      assert(page.includes(text), `${name} must explain ${text}`)
    }
  }
})

test("both troubleshooting guides distinguish probe evidence from private replay", () => {
  for (const name of ["EN-Logging-Troubleshooting.md", "ZH-Logging-Troubleshooting.md"]) {
    const page = readPage(name)
    for (const text of ["models --deep --model claude-opus-5.5 --details", "request_id", "capture=off", "capture=incomplete", "MATCH", "NO_COLOR", "800K"]) {
      assert(page.includes(text), `${name} must explain ${text}`)
    }
  }
})

test("routing documentation covers catalog selection and explicit no-effort capabilities in both languages", () => {
  const requiredTerms = ["supported_endpoints", "/responses", "/chat/completions", "reasoning_effort", "route_source"]

  for (const prefix of ["EN", "ZH"]) {
    for (const suffix of ["Configuration", "Internals", "Logging-Troubleshooting"]) {
      const name = `${prefix}-${suffix}.md`
      const page = readPage(name)

      for (const term of requiredTerms) {
        assert(page.includes(term), `${name} must explain ${term}`)
      }
    }

    assert(readPage(`${prefix}-Architecture.md`).includes("src/copilot/endpoint.ts"))
  }
})

test("README stays a concise feature overview and quick start with valid Wiki links", () => {
  const body = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8")

  assert(body.split("\n").length <= 80)
  assert.doesNotMatch(body, /\bv\d+\.\d+\.\d+\b/, "README describes current features, not release-version requirements")
  for (const required of ["## Features", "## Quick start", "copilot-relay auth", "copilot-relay start", "models --deep", "Wiki"]) {
    assert(body.includes(required))
  }

  for (const match of body.matchAll(/\]\((wiki\/[^)#]+)\)/g)) {
    assert(fs.existsSync(path.join(repoRoot, match[1]!)))
  }
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
      "--details",
      "MODEL",
      "RESULT",
      "NO_COLOR",
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
