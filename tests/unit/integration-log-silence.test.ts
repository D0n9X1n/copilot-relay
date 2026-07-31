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
//
// Only a top-level statement counts. Nested anywhere -- an if, a loop, a bare
// block, a function body -- whether the assignment runs at all, and whether it
// runs before src/ loads, depends on control flow this guard cannot evaluate:
// an "if (false)" wrapper reads exactly like configuration and silences
// nothing. Unconditional at module scope is the one shape guaranteed to have
// run by the time the dynamic imports below it execute, so it is the only
// shape accepted.
const findTopLevelSilenceOffset = (code: string): number | undefined => {
  const parsed = parse(code)

  for (const statement of parsed.statements) {
    if (!ts.isExpressionStatement(statement)) {
      continue
    }
    const { expression } = statement
    if (
      ts.isBinaryExpression(expression)
      && expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && isSilenceTarget(expression.left)
      && ts.isStringLiteral(expression.right)
      && expression.right.text === silenceValue
    ) {
      return statement.getStart(parsed)
    }
  }

  return undefined
}

const assertSilencedBeforeDynamicSrcImports = (code: string): void => {
  const silenceOffset = findTopLevelSilenceOffset(code)
  const [firstSrcImportOffset] = findDynamicSrcImportOffsets(code)

  assert.ok(
    silenceOffset !== undefined,
    `claude-routes.test.ts must contain a top-level ${silenceAssignment}`,
  )
  assert.ok(
    firstSrcImportOffset !== undefined,
    `claude-routes.test.ts must dynamically import ${srcSpecifierPrefix}`,
  )
  assert.ok(
    silenceOffset < firstSrcImportOffset,
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

// Only an unconditional top-level statement silences anything. The comment, the
// string and the type merely spell the assignment. The conditional and the
// function body do contain the real thing, but reaching either is control flow
// this guard cannot evaluate -- so of the five decoys below, none counts.
test("finds only a top-level silence assignment", () => {
  const fixture = [
    `// ${silenceAssignment}`,
    `const doc = '${silenceAssignment}'`,
    `type Doc = \`${silenceAssignment}\``,
    `if (true) { ${silenceAssignment} }`,
    `function configure() { ${silenceAssignment} }`,
    silenceAssignment,
  ].join("\n")

  assert.equal(
    findTopLevelSilenceOffset(fixture),
    fixture.lastIndexOf(silenceAssignment),
  )
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

// An "if (false)" wrapper reads exactly like configuration and silences
// nothing. Deciding otherwise means evaluating the condition, which a syntactic
// guard cannot do, so a conditional form is rejected rather than guessed at.
test("rejects a logger configuration guarded by a conditional", () => {
  const fixture = [
    `if (false) { ${silenceAssignment} }`,
    'await import("../../src/server")',
  ].join("\n")

  assert.throws(
    () => assertSilencedBeforeDynamicSrcImports(fixture),
    /must contain a top-level/,
  )
})

// A function body runs where it is called, not where it is written, and nothing
// calls this one. Its position above the import therefore proves no ordering.
test("rejects a logger configuration inside a function body", () => {
  const fixture = [
    `function configure() { ${silenceAssignment} }`,
    'await import("../../src/server")',
  ].join("\n")

  assert.throws(
    () => assertSilencedBeforeDynamicSrcImports(fixture),
    /must contain a top-level/,
  )
})

// The shape the suite actually uses must stay acceptable.
test("accepts a top-level logger configuration before the import", () => {
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
