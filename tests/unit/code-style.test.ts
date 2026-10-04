// Mechanical rules of the repository code style, enforced here so they cannot drift.
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
  | "paddedBlocks"
  | "multipleBlankLines"
  | "continuationOnClosingLine"
  | "nestedTernaries"
  | "strictEquality"
  | "declarations"
  | "issueNumbers"

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

// A blank line holds only spaces or tabs; both patterns include the line breaks around it.
// A run of blank lines may also open the file, with no line break before it.
const blankLine = /\n[ \t]*\r?\n/
const blankLineRuns = /(?:^|\n)(?:[ \t]*\r?\n){2,}/g

// Issue and PR citations are searched for in prose only: comments and the text of string and
// template literals. Code around them is not read, so an object key named issues that holds a count
// is not a citation. A template literal is read whole, with the code in each ${} field replaced by
// x's, so a link continues across a field and a field's code never reads as prose. In prose, a
// citation is:
// - a hash and a number, alone or after a project name or owner/repo;
// - "issue", "PR", "pull request" or "GH", then a space, "#", ":", "-", "no." or "number", then a
//   number;
// - a path to an issue, pull request or merge request page.
// Ordinals take no hash ("attempt 2"). Every other link is blanked first, so its path, query and
// fragment cannot read as a citation. An owner name has no dot, so a domain and a path do not read
// as owner/repo. A hash right after a letter, a digit or URL punctuation, other than a comment's //,
// belongs to a word, a relative link or an HTML entity. A hash and 3, 4, 6 or 8 digits is a color,
// not a citation, when it fills a string literal or follows a CSS color property.
const linkPattern = /\b(?:[a-z][\w+.-]*:\/\/|www\.)[^\s"'`<>()]+/gi
const trackerPath = /\/(?:issues|pulls?|merge_requests)\/\d+\b/
const labelledReference = /(?<!\w)(?:issues?|PRs?|pull[ -]requests?|GH)(?:(?:[ \t]*(?:[:#-]|no\.|number))+[ \t]*|[ \t]+)\d+\b/
const namedReference = /(?<![\w/.&=?#+%-])(?:[\w-]+\/[\w.-]+|[\w.-]+)#\d+\b/
const bareReference = /(?:(?<=\/\/)|(?<![\w/.&=?#+%-]))#\d+\b/
const citationPatterns = [trackerPath, labelledReference, namedReference, bareReference]
const issueReference = new RegExp(citationPatterns.map((pattern) => pattern.source).join("|"), "gi")
const colorValue = /^#(?:\d{3}|\d{4}|\d{6}|\d{8})$/
const colorProperty = /(?:color|background|fill|stroke):[ \t]*$/
const literalOpening = /^[a-z]*["'`]+$/i
const literalClosing = /^["'`]+$/

// A hash and 3, 4, 6 or 8 digits that fills a string literal or follows a CSS color property.
const isColor = (prose: string, index: number, reference: string) => {
  if (!colorValue.test(reference)) {
    return false
  }

  const before = prose.slice(0, index)
  const after = prose.slice(index + reference.length)
  return (literalOpening.test(before) && literalClosing.test(after)) || colorProperty.test(before)
}

// Offsets of the citations in one comment or literal.
const citationOffsets = (prose: string) => {
  const searched = prose.replace(linkPattern, (link) => trackerPath.test(link) ? link : " ".repeat(link.length))

  return [...searched.matchAll(issueReference)]
    .filter((match) => !isColor(prose, match.index, match[0]))
    .map((match) => match.index)
}

// The text of a template literal, with the code in each ${} field replaced by x's. Line breaks stay,
// so an offset in the result is an offset in the source.
const maskedTemplate = (sourceFile: ts.SourceFile, template: ts.TemplateExpression) => {
  const text = sourceFile.text
  const pieces = [text.slice(template.getStart(sourceFile), template.head.getEnd())]
  let fieldStart = template.head.getEnd()

  for (const span of template.templateSpans) {
    const fieldEnd = span.literal.getStart(sourceFile)
    pieces.push(text.slice(fieldStart, fieldEnd).replace(/[^\r\n]/g, "x"))
    pieces.push(text.slice(fieldEnd, span.literal.getEnd()))
    fieldStart = span.literal.getEnd()
  }

  return pieces.join("")
}

// Comments and the text of string and template literals, each with the offset it starts at. A
// template literal with fields is one segment, masked by maskedTemplate. Comments sit in the trivia
// before a token, so the full start of every token is read for leading and trailing comments. JSDoc
// nodes are skipped: their text is read as a leading comment of the node they document.
const proseSegments = (sourceFile: ts.SourceFile) => {
  const segments = new Map<number, string>()

  const visit = (node: ts.Node) => {
    const commentRanges = [
      ...(ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(sourceFile.text, node.getFullStart()) ?? []),
    ]

    for (const range of commentRanges) {
      segments.set(range.pos, sourceFile.text.slice(range.pos, range.end))
    }

    if (ts.isStringLiteralLike(node)) {
      segments.set(node.getStart(sourceFile), node.getText(sourceFile))
    }

    if (ts.isTemplateExpression(node)) {
      segments.set(node.getStart(sourceFile), maskedTemplate(sourceFile, node))
    }

    for (const child of node.getChildren(sourceFile)) {
      if (!ts.isJSDoc(child)) {
        visit(child)
      }
    }
  }

  visit(sourceFile)
  return [...segments].sort(([first], [second]) => first - second)
}

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

  // Parentheses do not hide nesting: `a ? (b ? c : d) : e` is still a nested ternary.
  const unwrapParentheses = (node: ts.Expression): ts.Expression => {
    return ts.isParenthesizedExpression(node) ? unwrapParentheses(node.expression) : node
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

  // String and template literals hold content rather than layout, so their blank lines are kept.
  const literalRanges: Array<[number, number]> = []

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

    if (contents !== undefined) {
      const openBrace = childOfKind(node, ts.SyntaxKind.OpenBraceToken) ?? node
      const closeBrace = node.getEnd() - 1

      if (contents.length > 0) {
        const opensBesideFirst = lineOf(startOf(openBrace)) === lineOf(startOf(contents[0]))
        const closesBesideLast = lineOf(node.getEnd()) === lineOf(contents[contents.length - 1].getEnd())

        if (opensBesideFirst || closesBesideLast) {
          record("multilineBlocks", startOf(openBrace))
        }
      }

      // No blank line between a brace and the contents. Comments count as contents, so a body
      // holding only a comment is checked too; only a body of whitespace is exempt.
      const inside = text.slice(startOf(openBrace) + 1, closeBrace)

      if (inside.trim() !== "") {
        const leadingSpace = inside.slice(0, inside.length - inside.trimStart().length)
        const trailingSpace = inside.slice(inside.trimEnd().length)

        if (blankLine.test(leadingSpace)) {
          record("paddedBlocks", startOf(openBrace))
        }

        if (blankLine.test(trailingSpace)) {
          record("paddedBlocks", closeBrace)
        }
      }
    }

    if (ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node)
      || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      for (let index = 1; index < node.statements.length; index++) {
        const previous = node.statements[index - 1]
        const current = node.statements[index]
        const sharesLine = lineOf(startOf(current)) === lineOf(previous.getEnd())
        const spansLines = lineOf(startOf(previous)) !== lineOf(previous.getEnd())
        const hasBlankLine = blankLine.test(text.slice(previous.getEnd(), startOf(current)))

        // A multi-line block statement ends a paragraph: the next statement follows a blank line.
        if (sharesLine) {
          record("oneStatementPerLine", startOf(current))
        } else if (spansLines && endsWithBlock(previous) && !hasBlankLine) {
          record("blankLineAfterBlock", startOf(current))
        }
      }
    }

    // Statements are compared within one clause above. Across clauses, the last statement of one
    // clause meets the first statement of the next, so `case 1: a(); case 2: b()` is caught here.
    // Case labels are not statements: grouped labels such as `case 1: case 2:` may share a line.
    if (ts.isCaseBlock(node)) {
      let previousStatement: ts.Statement | undefined

      for (const clause of node.clauses) {
        if (clause.statements.length === 0) {
          continue
        }

        const firstStatement = clause.statements[0]
        const sharesLine = previousStatement !== undefined
          && lineOf(startOf(firstStatement)) === lineOf(previousStatement.getEnd())

        if (sharesLine) {
          record("oneStatementPerLine", startOf(firstStatement))
        }

        previousStatement = clause.statements[clause.statements.length - 1]
      }
    }

    // A ternary inside a ternary's branch hides a decision tree that if/else or a lookup would show.
    if (ts.isConditionalExpression(node)) {
      const branches = [node.whenTrue, node.whenFalse].map(unwrapParentheses)

      if (branches.some((branch) => ts.isConditionalExpression(branch))) {
        record("nestedTernaries", startOf(node))
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

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
      literalRanges.push([startOf(node), node.getEnd()])
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  // At most one blank line in a row anywhere outside string and template literals.
  for (const run of text.matchAll(blankLineRuns)) {
    const insideLiteral = literalRanges.some(([start, end]) => run.index > start && run.index < end)

    if (!insideLiteral) {
      record("multipleBlankLines", run.index + run[0].length)
    }
  }

  // Comments, test names and strings alike: code states how it works and cites no issue or PR.
  for (const [start, prose] of proseSegments(sourceFile)) {
    for (const offset of citationOffsets(prose)) {
      record("issueNumbers", start + offset)
    }
  }

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

// Python comments and strings, one JSON line each: the file, the line it starts on and its text. An
// f-string or t-string is read whole, from its prefix to its closing quote, with the code in each {}
// field replaced by x's, as a template literal is. Python 3.11 returns it as one STRING token; from
// Python 3.12 it is the span from FSTRING_START to the matching FSTRING_END (TSTRING_* from 3.14).
// Token columns count characters, so that span is sliced from the decoded source.
const pythonProse = String.raw`
import io
import json
import sys
import tokenize

starts = {getattr(tokenize, name) for name in ("FSTRING_START", "TSTRING_START") if hasattr(tokenize, name)}
ends = {getattr(tokenize, name) for name in ("FSTRING_END", "TSTRING_END") if hasattr(tokenize, name)}
prefix_letters = "rRbBfFtTuU"


def emit(path, line, text):
    print(json.dumps({"file": path, "line": line, "text": text}))


def is_formatted(text):
    prefix = text[:len(text) - len(text.lstrip(prefix_letters))]
    return any(letter in prefix for letter in "fFtT")


def mask_fields(text):
    masked = list(text)
    index = len(text) - len(text.lstrip(prefix_letters))
    depth = 0
    quote = ""
    field_start = 0
    while index < len(text):
        character = text[index]
        if depth == 0:
            if character in "{}" and text[index + 1:index + 2] == character:
                index += 2
                continue
            if character == "{":
                depth = 1
                field_start = index + 1
        elif quote:
            if character == quote:
                quote = ""
        elif character in "'\"":
            quote = character
        elif character in "{[(":
            depth += 1
        elif character in "}])":
            depth -= 1
            if depth == 0:
                for position in range(field_start, index):
                    if masked[position] not in "\r\n":
                        masked[position] = "x"
        index += 1
    return "".join(masked)


for path in sys.argv[1:]:
    with open(path, "rb") as source:
        data = source.read()
    encoding = tokenize.detect_encoding(io.BytesIO(data).readline)[0]
    text = data.decode(encoding)
    line_starts = [0]
    for line in text.split("\n"):
        line_starts.append(line_starts[-1] + len(line) + 1)
    depth = 0
    opened = (0, 0)
    for token in tokenize.tokenize(io.BytesIO(data).readline):
        if token.type in starts:
            if depth == 0:
                opened = token.start
            depth += 1
        elif token.type in ends:
            depth -= 1
            if depth == 0:
                begin = line_starts[opened[0] - 1] + opened[1]
                finish = line_starts[token.end[0] - 1] + token.end[1]
                emit(path, opened[0], mask_fields(text[begin:finish]))
        elif depth == 0 and token.type == tokenize.COMMENT:
            emit(path, token.start[0], token.string)
        elif depth == 0 and token.type == tokenize.STRING:
            emit(path, token.start[0], mask_fields(token.string) if is_formatted(token.string) else token.string)
`

interface PythonProse {
  file: string
  line: number
  text: string
}

// Every citation in the given Python files, as file:line.
const pythonCitations = (files: string[]) => {
  const output = execFileSync(python, ["-", ...files], { cwd: repoRoot, input: pythonProse, encoding: "utf8" })
  const tokens = output.split(/\r?\n/).filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as PythonProse)

  return tokens.flatMap((token) => {
    return citationOffsets(token.text).map((offset) => {
      return `${token.file}:${token.line + token.text.slice(0, offset).split("\n").length - 1}`
    })
  })
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
    "",
    "switch (kind) {",
    "  case 1: case 2:",
    "    handle()",
    "    break",
    "}",
    "",
    "const label = ready ? (fast ? 'now' : 'soon') : 'later'",
    "const size = small ? 1 : medium ? 2 : 3",
    "const total = (left ? 1 : 2) + (right ? 3 : 4)",
    "",
    "if (ready) {",
    "",
    "  start()",
    "",
    "}",
    "",
    "",
    "stop()",
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
    "50 nestedTernaries",
    "51 nestedTernaries",
    "54 paddedBlocks",
    "58 paddedBlocks",
    "61 multipleBlankLines",
  ])
})

// Comments count as contents, and a run of blank lines can open the file.
test("blank-line checks cover comment-only bodies and the start of a file", () => {
  const sample = [
    "",
    "",
    "function check() {",
    "",
    "  // intentionally empty",
    "",
    "}",
  ].join("\n")

  const found = collectViolations("sample.ts", sample)
    .sort((left, right) => left.line - right.line || left.rule.localeCompare(right.rule))
    .map((violation) => `${violation.line} ${violation.rule}`)

  assert.deepEqual(found, [
    "3 multipleBlankLines",
    "3 paddedBlocks",
    "7 paddedBlocks",
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

test("blocks and bodies neither start nor end with a blank line", () => {
  assertNoViolations("paddedBlocks")
})

test("at most one blank line separates two lines of code", () => {
  assertNoViolations("multipleBlankLines")
})

test("else, catch and finally continue the line that closes the previous block", () => {
  assertNoViolations("continuationOnClosingLine")
})

test("a ternary never nests another ternary in its branches", () => {
  assertNoViolations("nestedTernaries")
})

test("equality is strict except for an intentional == null", () => {
  assertNoViolations("strictEquality")
})

test("declarations use const or let with one variable each", () => {
  assertNoViolations("declarations")
})

// The release scripts read issue references as data, so their tests hold real ones as fixtures.
const issueReferenceFixtures = new Set(["scripts/release-issues_tests.py", "scripts/release-notes_tests.py"])

test("no source, test or script cites an issue or PR number", () => {
  assertNoViolations("issueNumbers")

  const pythonSources = pythonFiles.map(displayPath).filter((file) => !issueReferenceFixtures.has(file))
  assert.deepEqual(pythonCitations(pythonSources), [])
})

test("the issue-number check reports citations and leaves other uses of # alone", () => {
  // Built by concatenation, so this file cites nothing itself.
  const citations = [
    "call() // See #" + "12.",
    "test(\"keeps the header (#" + "12)\", () => {})",
    "// See issue " + "123.",
    "// Fixed in owner/repo#" + "123.",
    "// See PR " + "34.",
    "call() //#" + "34",
    "test(\"#" + "123 keeps the header\", () => {})",
    "// See `#" + "123`.",
    "// Reported upstream (project#" + "75395).",
    "// See owner/repo#" + "200000.",
    "// See issue #" + "200000.",
    "test(\"#" + "200000 keeps the header\", () => {})",
    "test(\"regression for #" + "200000\", () => {})",
    "// See #" + "200000; keep this fallback.",
    "// See https://github.com/owner/repo/issues/" + "12.",
    "// See https://github.com/owner/repo/pull/" + "12.",
    "// See https://gitlab.com/owner/repo/-/merge_requests/" + "12.",
    "// See ../issues/" + "12.",
    "// See PR: " + "3.",
    "// See issue  " + "12.",
    "// See issue: #" + "12.",
    "// See issue no. " + "12.",
    "// See issue number " + "12.",
    "// See PR no. " + "3.",
    "// See PR-" + "3.",
    "// See GH-" + "123.",
    "// Pull request #" + "7 changed this.",
    "function empty() { /* See #" + "12. */ }",
    "/** See #" + "12. */ function documented() {}",
    "const message = `See ${first} #" + "12 ${second}.`",
  ]

  const otherUses = [
    "const entity = \"&#" + "39;\"",
    "const link = \"https://example.com/page#" + "12\"",
    "const anchor = \"https://example.com/page-#" + "123\"",
    "const query = \"https://example.com/?q=#" + "123\"",
    "const search = \"https://example.com/page?q=repo#" + "123\"",
    "const spaced = \"https://example.com/page?q=foo+bar#" + "123\"",
    "const encoded = \"https://example.com/file%20name#" + "123\"",
    "const relative = \"/page?q=foo+bar#" + "123\"",
    "const site = \"www.example.com/page#" + "12\"",
    "const host = \"example.com/page#" + "12\"",
    "const repo = \"https://github.com/owner/repo#" + "12\"",
    "const page = `https://example.com/page?q=${query}#" + "123`",
    "const color = \"#" + "123456\"",
    "const translucent = '#" + "12345678'",
    "const templated = `#" + "123456`",
    "const css = \"body { color: #" + "123456; }\"",
    "const grey = \"body { color: #" + "333; }\"",
    "const overlay = \"a { background-color: #" + "00000000 }\"",
    "const counts = { issues" + ": 0, PRs" + ": 0 }",
    "const issues = items.filter((item) => item.kind === \"issue\")",
    "const api = `${base}/repos/${repo}/issues/${number}`",
  ]

  // A comment on the last line sits in the trivia of the end-of-file token.
  const lastLine = "// See #" + "12 at the end of the file."

  const found = collectViolations("sample.ts", [...citations, ...otherUses, lastLine].join("\n"))
    .filter((violation) => violation.rule === "issueNumbers")
    .map((violation) => violation.line)

  const lastLineNumber = citations.length + otherUses.length + 1
  assert.deepEqual(found, [...citations.map((_, index) => index + 1), lastLineNumber])
})

test("the Python issue-number check reads comments and strings, and leaves colors, links and f-string fields alone", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-code-style-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  // Built by concatenation, so this file cites nothing itself.
  const file = path.join(directory, "sample.py")
  const sample = [
    "COLOR = \"#" + "123456\"",
    "# See #" + "12.",
    "LABEL = \"PR " + "34\"",
    "LINK = \"https://example.com/page#" + "12\"",
    "NOTE = \"\"\"First line.",
    "See issue " + "56.\"\"\"",
    "SUMMARY = f\"Resolved {issues" + ":3} issues.\"",
    "URL = f\"https://example.com/page?q={query}#" + "123\"",
    "CITED = f\"{name} cites #" + "78.\"",
  ]
  fs.writeFileSync(file, sample.join("\n") + "\n")

  assert.deepEqual(pythonCitations([file]), [`${file}:2`, `${file}:3`, `${file}:6`, `${file}:9`])
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
