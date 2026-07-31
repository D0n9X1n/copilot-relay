import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"

import * as ts from "typescript"

// Why (#48): the integration suite runs the real server, which logs, and
// node --test frames its child-to-runner messages over that same stdout, so an
// application write can abort the run mid-file. consola latches its level when
// src/ first loads, so CONSOLA_LEVEL must be set first. A static import hoists
// above every statement, so src/ must be reached only by dynamic import.
const integrationSuiteUrl = new URL(
  "../integration/claude-routes.test.ts",
  import.meta.url,
)

const silenceAssignment = "process.env.CONSOLA_LEVEL = \"0\""
const srcSpecifierPrefix = "../../src/"

const source = await fs.readFile(integrationSuiteUrl, "utf8")

const parse = (code: string): ts.SourceFile =>
  ts.createSourceFile("claude-routes.test.ts", code, ts.ScriptTarget.Latest, true)

const findDynamicSrcImportOffsets = (code: string): Array<number> => {
  const parsed = parse(code)
  const offsets: Array<number> = []

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
    ) {
      const [specifier] = node.arguments
      if (
        (ts.isStringLiteral(specifier)
          || ts.isNoSubstitutionTemplateLiteral(specifier))
        && specifier.text.startsWith(srcSpecifierPrefix)
      ) {
        offsets.push(node.getStart(parsed))
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(parsed)
  return offsets.sort((left, right) => left - right)
}

const assertSilencedBeforeDynamicSrcImports = (code: string): void => {
  const silenceIndex = code.indexOf(silenceAssignment)
  const [firstSrcImportIndex] = findDynamicSrcImportOffsets(code)

  assert.notEqual(
    silenceIndex,
    -1,
    `claude-routes.test.ts must contain ${silenceAssignment}`,
  )
  assert.notEqual(
    firstSrcImportIndex,
    undefined,
    `claude-routes.test.ts must dynamically import ${srcSpecifierPrefix}`,
  )
  assert.ok(
    silenceIndex < firstSrcImportIndex,
    "CONSOLA_LEVEL must be set before the first ../../src/ dynamic import",
  )
}

// Static import/export declarations hoist above every statement.
const findHoistedSrcSpecifiers = (code: string): Array<string> => {
  const parsed = parse(code)

  return parsed.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) {
      return []
    }
    const specifier = statement.moduleSpecifier
    if (!specifier || !ts.isStringLiteral(specifier)) {
      return []
    }
    return specifier.text.startsWith(srcSpecifierPrefix) ? [specifier.text] : []
  })
}

test("finds dynamic src imports independent of quote style", () => {
  const fixtures = [
    'await import("../../src/double")',
    "await import('../../src/single')",
    "await import(`../../src/template`)",
  ]

  for (const fixture of fixtures) {
    assert.deepEqual(findDynamicSrcImportOffsets(fixture), [6])
  }
})

test("finds the earliest src import and ignores unrelated imports", () => {
  const fixture = [
    'await import("node:fs")',
    "await import('../../src/first')",
    'await import("../../src/second")',
  ].join("\n")

  const offsets = findDynamicSrcImportOffsets(fixture)
  assert.equal(offsets.length, 2)
  assert.equal(offsets[0], fixture.indexOf("import('../../src/first')"))
  assert.equal(offsets[1], fixture.indexOf('import("../../src/second")'))
})

test("rejects a dynamic src import before logger configuration", () => {
  const fixture = [
    "await import('../../src/lib/log')",
    silenceAssignment,
    'await import("../../src/server")',
  ].join("\n")

  assert.throws(
    () => assertSilencedBeforeDynamicSrcImports(fixture),
    /CONSOLA_LEVEL must be set before/,
  )
})

test("integration suite silences the logger before importing src", () => {
  assertSilencedBeforeDynamicSrcImports(source)
})

// Every form below reaches src/ before any statement runs, so each must be
// caught. type-only is erased today, but it is one keyword away from not being.
test("rejects every hoisted static import form targeting src", () => {
  const hoisted: Array<[string, string]> = [
    ["side-effect", "import \"../../src/lib/log\""],
    ["default", "import log from \"../../src/lib/log\""],
    ["named", "import { log } from \"../../src/lib/log\""],
    ["namespace", "import * as log from \"../../src/lib/log\""],
    ["type-only", "import type { ProxyConfig } from \"../../src/lib/log\""],
    ["re-export", "export { log } from \"../../src/lib/log\""],
  ]

  for (const [form, code] of hoisted) {
    assert.deepEqual(
      findHoistedSrcSpecifiers(code),
      ["../../src/lib/log"],
      `${form} import must be rejected`,
    )
  }
})

// The arrangement the suite actually uses must stay acceptable, so the guard
// fails on the hazard rather than on dynamic import or on node: builtins.
test("accepts the dynamic-import arrangement the suite uses", () => {
  const accepted = [
    "const { createServer } = await import(\"../../src/server\")",
    "type ProxyConfig = import(\"../../src/lib/config\").ProxyConfig",
    "import test from \"node:test\"",
    "import fs from \"node:fs/promises\"",
  ].join("\n")

  assert.deepEqual(findHoistedSrcSpecifiers(accepted), [])
})

// The guard applied to the real file: no static import may reach src/ at all,
// wherever it sits, because hoisting makes its position irrelevant.
test("integration suite reaches src only by dynamic import", () => {
  assert.deepEqual(
    findHoistedSrcSpecifiers(source),
    [],
    `claude-routes.test.ts must not statically import ${srcSpecifierPrefix}`,
  )
})
