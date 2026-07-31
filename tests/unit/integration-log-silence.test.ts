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
const firstSrcImportMarker = "import(\"../../src/"
const srcSpecifierPrefix = "../../src/"

const source = await fs.readFile(integrationSuiteUrl, "utf8")

// Static import/export declarations only: these hoist above every statement.
// Dynamic import() is an expression, evaluated in order, and so is allowed.
const findHoistedSrcSpecifiers = (code: string): Array<string> => {
  const parsed = ts.createSourceFile(
    "claude-routes.test.ts",
    code,
    ts.ScriptTarget.Latest,
    true,
  )

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

test("integration suite silences the logger before importing src", () => {
  const silenceIndex = source.indexOf(silenceAssignment)
  const firstSrcImportIndex = source.indexOf(firstSrcImportMarker)

  assert.notEqual(
    silenceIndex,
    -1,
    `claude-routes.test.ts must contain ${silenceAssignment}`,
  )
  assert.notEqual(
    firstSrcImportIndex,
    -1,
    `claude-routes.test.ts must contain ${firstSrcImportMarker}`,
  )
  assert.ok(
    silenceIndex < firstSrcImportIndex,
    "CONSOLA_LEVEL must be set before the first ../../src/ dynamic import",
  )
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
