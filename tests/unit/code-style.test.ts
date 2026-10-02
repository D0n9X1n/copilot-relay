// Mechanical rules of the repository code style (#127), enforced here so they cannot drift.
// Readability that needs judgment (grouping steps with blank lines, naming, why-comments)
// is reviewed instead. "Code style" in wiki/EN-Development.md lists every rule and its precedent.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import ts from "typescript"

type Rule =
  | "bracedBodies"
  | "multilineBlocks"
  | "oneStatementPerLine"
  | "blankLineAfterBlock"
  | "continuationOnClosingLine"
  | "strictEquality"
  | "declarations"

interface Violation {
  rule: Rule
  file: string
  line: number
}

const repoRoot = path.resolve(import.meta.dirname, "../..")
const maintainedRoots = ["src", "tests", "scripts"]
const scriptPattern = /\.(?:[cm]?ts|[cm]?js)$/
const skippedDirectories = new Set(["node_modules", "dist"])
const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3")

const displayPath = (file: string) => path.relative(repoRoot, file).split(path.sep).join("/")

// Walk the maintained trees rather than asking git, so a checkout without .git is still covered.
const listFiles = (directory: string, pattern: RegExp): string[] => {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)

    if (entry.isDirectory()) {
      const isSkipped = skippedDirectories.has(entry.name) || entry.name.startsWith(".")
      return isSkipped ? [] : listFiles(fullPath, pattern)
    }

    return pattern.test(entry.name) ? [fullPath] : []
  })
}

const rootScripts = fs.readdirSync(repoRoot, { withFileTypes: true })
  .filter((entry) => entry.isFile() && scriptPattern.test(entry.name))
  .map((entry) => path.join(repoRoot, entry.name))

const scriptFiles = [
  ...rootScripts,
  ...maintainedRoots.flatMap((root) => listFiles(path.join(repoRoot, root), scriptPattern)),
]
const pythonFiles = maintainedRoots.flatMap((root) => listFiles(path.join(repoRoot, root), /\.py$/))

const collectViolations = (file: string, text: string): Violation[] => {
  const scriptKind = /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind)
  const violations: Violation[] = []

  const startOf = (node: ts.Node) => node.getStart(sourceFile)
  const lineOf = (position: number) => sourceFile.getLineAndCharacterOfPosition(position).line

  const record = (rule: Rule, position: number) => {
    violations.push({ rule, file, line: lineOf(position) + 1 })
  }

  const childOfKind = (node: ts.Node, kind: ts.SyntaxKind) => {
    return node.getChildren(sourceFile).find((child) => child.kind === kind)
  }

  // `else if` is the one unbraced shape allowed; the inner if is checked on its own.
  const requireBlock = (body: ts.Statement | undefined, allowsElseIf = false) => {
    if (body === undefined || ts.isBlock(body) || (allowsElseIf && ts.isIfStatement(body))) {
      return
    }

    record("bracedBodies", startOf(body))
  }

  // 1TBS: else, catch and finally continue the line that closes the previous block.
  const requireSameLine = (closedAt: number, continuation: ts.Node | undefined) => {
    if (continuation !== undefined && lineOf(startOf(continuation)) !== lineOf(closedAt)) {
      record("continuationOnClosingLine", startOf(continuation))
    }
  }

  // ESLint's "block-like": the statement's last token closes a block (if, loops, try, switch,
  // function bodies), or it is a braced do-while. Object-literal and class braces do not count.
  const endsWithBlock = (statement: ts.Statement) => {
    if (ts.isDoStatement(statement)) {
      return ts.isBlock(statement.statement)
    }

    const end = text[statement.getEnd() - 1] === ";" ? statement.getEnd() - 1 : statement.getEnd()
    let node: ts.Node | undefined = statement

    while (node !== undefined) {
      if (ts.isBlock(node) || ts.isCaseBlock(node)) {
        return node.getEnd() === end
      }

      node = node.getChildren(sourceFile).findLast((child) => child.getEnd() === end)
    }

    return false
  }

  // The contents between a construct's own braces: statements, switch clauses, or class,
  // interface and enum members. Object and type literals are values and types rather than
  // bodies, so they may stay on one line.
  const bracedContents = (node: ts.Node): readonly ts.Node[] | undefined => {
    if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      return node.statements
    }

    if (ts.isCaseBlock(node)) {
      return node.clauses
    }

    if (ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) {
      return node.members
    }

    return undefined
  }

  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      requireBlock(node.thenStatement)
      requireBlock(node.elseStatement, true)

      if (node.elseStatement && ts.isBlock(node.thenStatement)) {
        requireSameLine(node.thenStatement.getEnd(), childOfKind(node, ts.SyntaxKind.ElseKeyword))
      }
    }

    if (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
      || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      requireBlock(node.statement)
    }

    if (ts.isTryStatement(node)) {
      if (node.catchClause) {
        requireSameLine(node.tryBlock.getEnd(), node.catchClause)
      }

      if (node.finallyBlock) {
        const previousBlock = node.catchClause ?? node.tryBlock
        requireSameLine(previousBlock.getEnd(), childOfKind(node, ts.SyntaxKind.FinallyKeyword))
      }
    }

    // A non-empty block or body keeps `{` and `}` off its content lines; an empty `{}` may stay compact.
    const contents = bracedContents(node)

    if (contents !== undefined && contents.length > 0) {
      const openBrace = childOfKind(node, ts.SyntaxKind.OpenBraceToken) ?? node
      const opensBesideFirst = lineOf(startOf(openBrace)) === lineOf(startOf(contents[0]))
      const closesBesideLast = lineOf(node.getEnd()) === lineOf(contents[contents.length - 1].getEnd())

      if (opensBesideFirst || closesBesideLast) {
        record("multilineBlocks", startOf(openBrace))
      }
    }

    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)
      || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      for (let index = 1; index < node.statements.length; index++) {
        const previous = node.statements[index - 1]
        const current = node.statements[index]
        const sharesLine = lineOf(startOf(current)) === lineOf(previous.getEnd())
        const spansLines = lineOf(startOf(previous)) !== lineOf(previous.getEnd())
        const hasBlankLine = /\n[ \t]*\r?\n/.test(text.slice(previous.getEnd(), startOf(current)))

        // A multi-line block statement ends a paragraph: the next statement follows a blank line.
        if (sharesLine) {
          record("oneStatementPerLine", startOf(current))
        } else if (spansLines && endsWithBlock(previous) && !hasBlankLine) {
          record("blankLineAfterBlock", startOf(current))
        }
      }
    }

    // Statements are compared within one clause above, so `case 1: a(); case 2: b()` is caught here.
    if (ts.isCaseBlock(node)) {
      for (let index = 1; index < node.clauses.length; index++) {
        const clause = node.clauses[index]

        if (lineOf(startOf(clause)) === lineOf(node.clauses[index - 1].getEnd())) {
          record("oneStatementPerLine", startOf(clause))
        }
      }
    }

    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind
      const isLoose = operator === ts.SyntaxKind.EqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken

      // `value == null` intentionally matches both null and undefined.
      const comparesNull = node.left.kind === ts.SyntaxKind.NullKeyword || node.right.kind === ts.SyntaxKind.NullKeyword

      if (isLoose && !comparesNull) {
        record("strictEquality", startOf(node))
      }
    }

    if (ts.isVariableDeclarationList(node)) {
      const usesVar = (node.flags & ts.NodeFlags.BlockScoped) === 0
      const isLoopHeader = ts.isForStatement(node.parent) || ts.isForInStatement(node.parent) || ts.isForOfStatement(node.parent)

      if (usesVar || (node.declarations.length > 1 && !isLoopHeader)) {
        record("declarations", startOf(node))
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return violations
}

const repoViolations = scriptFiles.flatMap((file) => {
  return collectViolations(displayPath(file), fs.readFileSync(file, "utf8"))
})

// PEP 8 discourages compound statements and semicolon-separated statements. Tokens, unlike a
// line grep, tell a block-opening colon from a lambda's colon or one inside brackets, slices
// or annotations.
const pythonChecker = `
import io
import sys
import tokenize

HEADER_KEYWORDS = {"if", "elif", "else", "for", "while", "with", "try", "except", "finally", "def", "class", "async"}
IGNORED_TOKENS = {tokenize.NL, tokenize.COMMENT, tokenize.ENCODING, tokenize.ENDMARKER}

for path in sys.argv[1:]:
    with open(path, encoding="utf-8") as handle:
        source = handle.read()

    depth = 0
    lambda_depths = []
    first_word = None
    last_value = None
    is_header = False
    header_colon_row = None
    reported = False

    # match and case are soft keywords, so a case line is a header only directly inside a match
    # body. Each open indented block records whether a "match ...:" line opened it.
    match_bodies = []
    opens_match_body = False

    # A logical line ends only at NEWLINE, so a backslash continuation cannot hide a one-liner.
    for kind, value, (row, _), _, _ in tokenize.generate_tokens(io.StringIO(source).readline):
        if kind == tokenize.INDENT:
            match_bodies.append(opens_match_body)
            continue

        if kind == tokenize.DEDENT:
            match_bodies.pop()
            continue

        if kind == tokenize.NEWLINE:
            opens_match_body = first_word == "match" and last_value == ":"
            lambda_depths = []
            first_word = None
            last_value = None
            is_header = False
            header_colon_row = None
            reported = False
            continue

        if kind in IGNORED_TOKENS:
            continue

        if first_word is None:
            first_word = value
            in_match_body = bool(match_bodies) and match_bodies[-1]
            is_header = first_word in HEADER_KEYWORDS or (first_word == "case" and in_match_body)

        last_value = value

        if header_colon_row is not None and not reported:
            print(f"{path}:{header_colon_row} compound statement on one line")
            reported = True

        # A lambda's colon ends its parameters rather than opening a suite.
        if kind == tokenize.NAME and value == "lambda":
            lambda_depths.append(depth)
            continue

        if kind != tokenize.OP:
            continue

        if value in ("(", "[", "{"):
            depth += 1
        elif value in (")", "]", "}"):
            depth -= 1
        elif value == ":" and lambda_depths and lambda_depths[-1] == depth:
            lambda_depths.pop()
        elif value == ":" and depth == 0 and is_header and header_colon_row is None:
            header_colon_row = row
        elif value == ";" and depth == 0:
            print(f"{path}:{row} semicolon-separated statements")
`

// The program goes in on stdin: a multi-line -c argument is fragile on Windows command lines.
const runPythonChecker = (files: string[]): string[] => {
  const output = execFileSync(python, ["-", ...files], { cwd: repoRoot, input: pythonChecker, encoding: "utf8" })
  return output.split(/\r?\n/).filter((line) => line.trim() !== "")
}

// Show where to look, capped so a large regression still prints a readable failure.
const assertNoViolations = (rule: Rule) => {
  const locations = repoViolations
    .filter((violation) => violation.rule === rule)
    .map((violation) => `${violation.file}:${violation.line}`)

  const shown = locations.slice(0, 40).join("\n")
  const remainder = locations.length > 40 ? `\n...and ${locations.length - 40} more` : ""

  assert.equal(locations.length, 0, `${locations.length} ${rule} violation(s):\n${shown}${remainder}`)
}

test("the scan covers source, test, script and root config files", () => {
  const scanned = scriptFiles.map(displayPath)

  for (const expected of ["src/server.ts", "tests/unit/code-style.test.ts", "scripts/package-smoke.mjs", "tsdown.config.ts"]) {
    assert.ok(scanned.includes(expected), `${expected} was not scanned`)
  }

  assert.ok(pythonFiles.map(displayPath).includes("scripts/release-issues.py"))
})

test("the checker reports each mechanical rule at the offending line", () => {
  const sample = [
    "if (ready) start()",
    "for (const item of items) use(item)",
    "if (ready) { start() }",
    "const first = 1; const second = 2",
    "if (ready) {",
    "  start()",
    "}",
    "else {",
    "  stop()",
    "}",
    "",
    "try {",
    "  load()",
    "}",
    "catch {",
    "  recover()",
    "}",
    "",
    "if (value == 1) {",
    "  report()",
    "}",
    "var legacy = 1",
    "let low = 1, high = 2",
    "",
    "if (value == null) {",
    "  ignore()",
    "}",
    "",
    "do {",
    "  poll()",
    "} while (waiting)",
    "done()",
    "",
    "switch (mode) { case 1: first() }",
    "class Point { x = 1 }",
    "class Empty {}",
    "interface Options { id: string }",
    "enum Kind { A }",
    "",
    "switch (kind) {",
    "  case 1: first(); case 2: second()",
    "}",
  ].join("\n")

  const found = collectViolations("sample.ts", sample)
    .sort((left, right) => left.line - right.line || left.rule.localeCompare(right.rule))
    .map((violation) => `${violation.line} ${violation.rule}`)

  assert.deepEqual(found, [
    "1 bracedBodies",
    "2 bracedBodies",
    "3 multilineBlocks",
    "4 oneStatementPerLine",
    "8 continuationOnClosingLine",
    "15 continuationOnClosingLine",
    "19 strictEquality",
    "22 blankLineAfterBlock",
    "22 declarations",
    "23 declarations",
    "32 blankLineAfterBlock",
    "34 multilineBlocks",
    "35 multilineBlocks",
    "37 multilineBlocks",
    "38 multilineBlocks",
    "41 oneStatementPerLine",
  ])
})

test("every if, else and loop body is a braced block", () => {
  assertNoViolations("bracedBodies")
})

test("braces never share a line with the contents of a non-empty block or body", () => {
  assertNoViolations("multilineBlocks")
})

test("each statement starts on its own line", () => {
  assertNoViolations("oneStatementPerLine")
})

test("a multi-line block statement is followed by a blank line", () => {
  assertNoViolations("blankLineAfterBlock")
})

test("else, catch and finally continue the line that closes the previous block", () => {
  assertNoViolations("continuationOnClosingLine")
})

test("equality is strict except for an intentional == null", () => {
  assertNoViolations("strictEquality")
})

test("declarations use const or let with one variable each", () => {
  assertNoViolations("declarations")
})

test("the Python checker reports compound one-liners, continued ones and case clauses included, and semicolons", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-code-style-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  // `case` and `match` are soft keywords, so `case: int = 1` and `match = 2` are ordinary
  // statements. A lambda's colon opens no suite, so the `for` header on line 15 is valid.
  const sample = path.join(directory, "sample.py")
  const source = [
    "if ready: start()",
    "first = 1; second = 2",
    "if ready:",
    "    start()",
    "if ready: \\",
    "    start()",
    "match command:",
    "    case 1: start()",
    "    case 2:",
    "        stop()",
    "    case 3: \\",
    "        pause()",
    "case: int = 1",
    "match = 2",
    "for callback in lambda: 1, lambda: 2:",
    "    register(callback)",
    "if ready: run(lambda: 1)",
  ].join("\n")

  fs.writeFileSync(sample, `${source}\n`)

  assert.deepEqual(runPythonChecker([sample]), [
    `${sample}:1 compound statement on one line`,
    `${sample}:2 semicolon-separated statements`,
    `${sample}:5 compound statement on one line`,
    `${sample}:8 compound statement on one line`,
    `${sample}:11 compound statement on one line`,
    `${sample}:17 compound statement on one line`,
  ])
})

test("Python scripts keep one simple statement per line", () => {
  assert.deepEqual(runPythonChecker(pythonFiles.map(displayPath)), [])
})
