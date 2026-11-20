import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import test from "node:test"

import { wrapHelp } from "../../src/lib/help"
import { displayWidth } from "../../src/lib/terminal"

test("a long option description wraps under its own column and no line ends in spaces", () => {
  const text = [
    "Show cache rates. (copilot-relay cache)",
    "",
    "OPTIONS",
    "",
    "     --json    Print the rows as a JSON array.                                                    ",
    "  --goal=\"95\"    Hit-rate goal in percent, with at most two decimals. A hit rate below it is marked ✗ (x without unicode) and shown in red.",
  ].join("\n")

  assert.deepEqual(wrapHelp(text, 80).split("\n"), [
    "Show cache rates. (copilot-relay cache)",
    "",
    "OPTIONS",
    "",
    "     --json    Print the rows as a JSON array.",
    "  --goal=\"95\"    Hit-rate goal in percent, with at most two decimals. A hit rate",
    "                 below it is marked ✗ (x without unicode) and shown in red.",
  ])
})

test("a long line with no column wraps at word boundaries", () => {
  const line = "Replay a captured request offline; compare current translation without network access. (copilot-relay replay)"

  assert.deepEqual(wrapHelp(line, 80).split("\n"), [
    "Replay a captured request offline; compare current translation without network",
    "access. (copilot-relay replay)",
  ])
})

test("backticks citty puts around names do not count toward the column", () => {
  const line = `  \`--goal="95"\`    Hit-rate goal in percent, with at most two decimals. A hit rate below it.`

  assert.equal(wrapHelp(line, 80).split("\n")[1], `${" ".repeat(17)}below it.`)
})

test("a long usage line continues under the command", () => {
  assert.deepEqual(wrapHelp(`USAGE \`copilot-relay ${"a|".repeat(40)}z\``, 80).split("\n").map((line) => line.slice(0, 7)), ["USAGE `", "      a"])
})

test("a colored usage line continues under the command too", () => {
  const colored = `\u001b[4m\u001b[1mUSAGE\u001b[22m\u001b[24m \`copilot-relay ${"a|".repeat(40)}z\``
  const lines = wrapHelp(colored, 80).split("\n")

  assert.equal(lines.length, 2)
  assert.equal(lines[1].slice(0, 7), "      a")
})

test("a usage line loses the space citty leaves inside its closing backtick", () => {
  assert.equal(wrapHelp("USAGE `auth `"), "USAGE `auth`")
})

test("a word longer than the line stays whole", () => {
  const word = "x".repeat(90)

  assert.equal(wrapHelp(`  --id    ${word}`, 80), `  --id    ${word}`)
})

const commands = ["auth", "cache", "completion", "models", "replay", "restart", "setup", "start", "status", "stop", "usage"]

test("every command's --help fits 80 columns", () => {
  for (const args of [["--help"], ...commands.map((command) => [command, "--help"])]) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/main.ts", ...args], {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", CONSOLA_LEVEL: "3" },
    })

    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`)
    assert.match(result.stdout, /USAGE/, args.join(" "))
    for (const line of result.stdout.split("\n")) {
      assert.ok(displayWidth(line) <= 80, `${args.join(" ")}: ${displayWidth(line)} columns: ${line}`)
      assert.doesNotMatch(line, / $/, `${args.join(" ")}: trailing space: ${line}`)
    }
  }
})
