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
const silenceValue = "0"
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

// process.env.CONSOLA_LEVEL, written as a property-access chain.
const isSilenceTarget = (node: ts.Expression): boolean =>
  ts.isPropertyAccessExpression(node)
  && node.name.text === "CONSOLA_LEVEL"
  && ts.isPropertyAccessExpression(node.expression)
  && node.expression.name.text === "env"
  && ts.isIdentifier(node.expression.expression)
  && node.expression.expression.text === "process"

// Text search cannot tell an assignment from a comment or a string that merely
// spells one, and only an assignment silences anything. Match the statement
// structurally instead: process.env.CONSOLA_LEVEL = "0", and nothing weaker.
const findSilenceAssignmentOffsets = (code: string): Array<number> => {
  const parsed = parse(code)
  const offsets: Array<number> = []

  const visit = (node: ts.Node): void => {
    // Type positions are erased before anything runs, so they silence nothing.
    if (ts.isTypeNode(node)) {
      return
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && isSilenceTarget(node.left)
      && ts.isStringLiteral(node.right)
      && node.right.text === silenceValue
    ) {
      offsets.push(node.getStart(parsed))
    }
    ts.forEachChild(node, visit)
  }

  visit(parsed)
  return offsets.sort((left, right) => left - right)
}

const assertSilencedBeforeDynamicSrcImports = (code: string): void => {
  const [firstSilenceOffset] = findSilenceAssignmentOffsets(code)
  const [firstSrcImportOffset] = findDynamicSrcImportOffsets(code)

  assert.ok(
    firstSilenceOffset !== undefined,
    `claude-routes.test.ts must contain ${silenceAssignment}`,
  )
  assert.ok(
    firstSrcImportOffset !== undefined,
    `claude-routes.test.ts must dynamically import ${srcSpecifierPrefix}`,
  )
  assert.ok(
    firstSilenceOffset < firstSrcImportOffset,
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

// The ordering assertion compares against the first import that actually runs.
// A type-position import() is erased before anything executes, so it must not
// be mistaken for the boundary the assignment has to precede.
test("ignores type-position import() when finding runtime src imports", () => {
  const fixture = [
    'type ProxyConfig = import("../../src/lib/config").ProxyConfig',
    'await import("../../src/server")',
  ].join("\n")

  assert.deepEqual(findDynamicSrcImportOffsets(fixture), [
    fixture.indexOf('import("../../src/server")'),
  ])
})

// Only a statement that runs can silence anything. The three decoys below all
// contain the assignment as text, and none of them executes.
test("finds only executable silence assignments, sorted", () => {
  const fixture = [
    `// ${silenceAssignment}`,
    `const doc = '${silenceAssignment}'`,
    `type Doc = \`${silenceAssignment}\``,
    silenceAssignment,
    `if (true) { ${silenceAssignment} }`,
  ].join("\n")

  const offsets = findSilenceAssignmentOffsets(fixture)

  assert.deepEqual(offsets, [
    fixture.indexOf(`\n${silenceAssignment}`) + 1,
    fixture.lastIndexOf(silenceAssignment),
  ])
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

// A comment is not an assignment. Text search cannot tell the two apart, so the
// commented form below silences nothing while reading as though it does.
test("rejects a commented-out logger configuration", () => {
  const fixture = [
    `// ${silenceAssignment}`,
    'await import("../../src/server")',
  ].join("\n")

  assert.throws(
    () => assertSilencedBeforeDynamicSrcImports(fixture),
    /must contain/,
  )
})

// Quoting the assignment describes it; it does not perform it.
test("rejects a logger configuration only spelled inside a string", () => {
  const fixture = [
    `const doc = '${silenceAssignment}'`,
    'await import("../../src/server")',
  ].join("\n")

  assert.throws(
    () => assertSilencedBeforeDynamicSrcImports(fixture),
    /must contain/,
  )
})

// The shape the suite actually uses must stay acceptable.
test("accepts an executable logger configuration before the import", () => {
  const fixture = [
    silenceAssignment,
    'await import("../../src/server")',
  ].join("\n")

  assert.doesNotThrow(() => assertSilencedBeforeDynamicSrcImports(fixture))
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
