import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import ts from "typescript"

// paths.ts resolves the home directory when it is imported, so it is redirected first. Node reads
// USERPROFILE on Windows and HOME elsewhere, so both are set.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-completion-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { completionModels, completionShells, renderCompletion } = await import("../../src/lib/completion")
const { buildCompletionSpec } = await import("../../src/completion")
const { paths } = await import("../../src/lib/paths")

assert.ok(paths.configPath.startsWith(home), paths.configPath)

const repoRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")

// The command names src/main.ts registers, read from its subCommands literal rather than by
// importing it: importing main.ts runs the CLI.
const registeredCommandNames = (): string[] => {
  const file = path.join(repoRoot, "src", "main.ts")
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const names: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "subCommands") {
      assert(ts.isObjectLiteralExpression(node.initializer), "subCommands must be an object literal")
      for (const property of node.initializer.properties) {
        assert(ts.isShorthandPropertyAssignment(property), "each command must be a shorthand property")
        names.push(property.name.text)
      }

      return
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return names
}

const hasShell = (shell: string): boolean => {
  const probe = spawnSync(shell, ["-c", "exit 0"], { encoding: "utf8" })
  return probe.status === 0
}

const writeScript = (name: string, body: string): string => {
  const file = path.join(home, name)
  fs.writeFileSync(file, body)
  return file
}

// A stand-in copilot-relay on PATH, so a script's dynamic model lookup answers without a real
// install. It prints the two configured models the way `completion --models` does.
const stubRelayDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(home, "bin-"))
  const stub = path.join(directory, "copilot-relay")
  fs.writeFileSync(stub, "#!/bin/sh\nprintf 'gpt-6-astra\\nclaude-opus-5.5\\n'\n")
  fs.chmodSync(stub, 0o755)
  return directory
}

test("the completion spec lists every command src/main.ts registers", async () => {
  const spec = await buildCompletionSpec()

  assert.deepEqual(
    spec.commands.map((command) => command.name).sort(),
    registeredCommandNames().sort(),
  )
  for (const command of spec.commands) {
    assert.notEqual(command.description, "", `${command.name} needs a description`)
  }
})

test("the completion spec carries each option, whether it takes a value, and the known values", async () => {
  const spec = await buildCompletionSpec()
  const command = (name: string) => {
    const found = spec.commands.find((entry) => entry.name === name)
    assert(found, `${name} must be in the spec`)
    return found
  }

  const option = (commandName: string, optionName: string) => {
    const found = command(commandName).options.find((entry) => entry.name === optionName)
    assert(found, `${commandName} must have --${optionName}`)
    return found
  }

  assert.equal(option("status", "deep").takesValue, false)
  assert.equal(option("cache", "since").takesValue, true)
  assert.deepEqual(option("cache", "since").values, { kind: "words", words: ["6h", "24h", "2d", "7d"] })
  assert.deepEqual(option("models", "model").values, { kind: "models" })
  assert.deepEqual(option("cache", "model").values, { kind: "models" })
  assert.deepEqual(command("setup").positional, {
    kind: "words",
    words: ["claude-code-cli", "claude-code-app", "codex-cli", "codex-app"],
  })
  assert.deepEqual(command("completion").positional, { kind: "words", words: [...completionShells] })
  assert.deepEqual(command("replay").positional, { kind: "directories" })
  assert.equal(command("start").positional, undefined)
})

test("each shell's script names every command and every option", async () => {
  const spec = await buildCompletionSpec()

  for (const shell of completionShells) {
    const script = renderCompletion(shell, spec)

    for (const command of spec.commands) {
      assert(script.includes(command.name), `${shell} script must name ${command.name}`)
      for (const option of command.options) {
        assert(script.includes(`--${option.name}`), `${shell} script must name ${command.name} --${option.name}`)
      }
    }

    for (const word of ["claude-code-cli", "codex-app", "6h", "7d", "completion --models"]) {
      assert(script.includes(word), `${shell} script must include ${word}`)
    }
  }
})

test("a description with quotes, brackets and colons cannot break a script", () => {
  const spec = {
    commands: [{
      name: "start",
      description: "It's [odd]: \"quoted\" `tick` $HOME \\ end",
      options: [{ name: "deep", description: "Don't [break]: here", takesValue: false }],
      positional: undefined,
    }],
  }

  for (const shell of completionShells) {
    const script = renderCompletion(shell, spec)
    assert(!script.includes("$HOME"), `${shell} must not leave $HOME expandable`)
  }

  if (hasShell("bash")) {
    const file = writeScript("odd.bash", renderCompletion("bash", spec))
    assert.equal(spawnSync("bash", ["-n", file]).status, 0)
  }

  if (hasShell("zsh")) {
    const file = writeScript("odd.zsh", renderCompletion("zsh", spec))
    assert.equal(spawnSync("zsh", ["-n", file]).status, 0)
  }
})

test("completion models come from config.yaml, in gptModel then opusModel order, without writing it", async () => {
  assert.deepEqual(await completionModels(), [], "no config.yaml gives no models")
  assert.equal(fs.existsSync(paths.configPath), false, "reading must not create config.yaml")

  fs.mkdirSync(path.dirname(paths.configPath), { recursive: true })
  const config = "gptModel: gpt-6-astra\nopusModel: claude-opus-5.5\n"
  fs.writeFileSync(paths.configPath, config)

  try {
    assert.deepEqual(await completionModels(), ["gpt-6-astra", "claude-opus-5.5"])
    assert.equal(fs.readFileSync(paths.configPath, "utf8"), config, "reading must not rewrite config.yaml")

    fs.writeFileSync(paths.configPath, "gptModel: [unclosed\n")
    assert.deepEqual(await completionModels(), [], "an unreadable config gives no models rather than an error")
  } finally {
    fs.rmSync(paths.configPath, { force: true })
  }
})

test("bash completes commands, options, setup targets and configured models", { skip: !hasShell("bash") || process.platform === "win32" }, async () => {
  const file = writeScript("copilot-relay.bash", renderCompletion("bash", await buildCompletionSpec()))
  const complete = (words: string[]): string[] => {
    const script = [
      `source '${file}'`,
      `COMP_WORDS=(${words.map((word) => `'${word}'`).join(" ")})`,
      `COMP_CWORD=${words.length - 1}`,
      `COMP_LINE='${words.join(" ")}'`,
      `COMP_POINT=\${#COMP_LINE}`,
      "_copilot_relay",
      `printf '%s\\n' "\${COMPREPLY[@]}"`,
    ].join("\n")
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubRelayDirectory()}${path.delimiter}${process.env.PATH ?? ""}` },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.split("\n").filter((line) => line !== "").sort()
  }

  assert.equal(spawnSync("bash", ["-n", file]).status, 0)
  assert.deepEqual(complete(["copilot-relay", "se"]), ["setup"])
  assert.deepEqual(complete(["copilot-relay", "setup", ""]).filter((word) => !word.startsWith("-")), [
    "claude-code-app",
    "claude-code-cli",
    "codex-app",
    "codex-cli",
  ])
  assert.deepEqual(complete(["copilot-relay", "status", "--d"]), ["--deep"])
  assert.deepEqual(complete(["copilot-relay", "models", "--model", ""]), ["claude-opus-5.5", "gpt-6-astra"])
  assert.deepEqual(complete(["copilot-relay", "cache", "--since", "2"]), ["24h", "2d"])
  assert.deepEqual(complete(["copilot-relay", "completion", "z"]), ["zsh"])
})

test("zsh loads the script and the plugin and registers the completion function", { skip: !hasShell("zsh") || process.platform === "win32" }, async () => {
  const file = writeScript("_copilot-relay.zsh", renderCompletion("zsh", await buildCompletionSpec()))
  assert.equal(spawnSync("zsh", ["-n", file]).status, 0)

  const plugin = path.join(repoRoot, "completions", "copilot-relay.plugin.zsh")
  assert.equal(spawnSync("zsh", ["-n", plugin]).status, 0)

  // The plugin asks the installed copilot-relay for its script, so a stub that prints this one
  // stands in for the install.
  const binDirectory = fs.mkdtempSync(path.join(home, "zsh-bin-"))
  const stub = path.join(binDirectory, "copilot-relay")
  fs.writeFileSync(stub, `#!/bin/sh\ncat '${file}'\n`)
  fs.chmodSync(stub, 0o755)

  for (const load of [`source '${file}'`, `source '${plugin}'`]) {
    const script = [
      "autoload -Uz compinit",
      `compinit -u -d '${path.join(home, "zcompdump")}'`,
      load,
      "print -r -- \"${_comps[copilot-relay]}\"",
    ].join("\n")
    const result = spawnSync("zsh", ["-f", "-c", script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}` },
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), "_copilot_relay", `${load} must register _copilot_relay`)
  }
})

// zpty drives an interactive zsh through a pseudo-terminal, so this checks what a user gets when
// pressing Tab, not only that the script parses.
test("zsh offers commands, setup targets, configured models and option values on Tab", { skip: !hasShell("zsh") || process.platform === "win32", timeout: 120_000 }, async () => {
  const file = writeScript("_copilot-relay-tab.zsh", renderCompletion("zsh", await buildCompletionSpec()))
  const work = fs.mkdtempSync(path.join(home, "zsh-tab-"))
  const lines = [
    "copilot-relay se",
    "copilot-relay setup ",
    "copilot-relay models --model ",
    "copilot-relay cache --since ",
    "copilot-relay status --d",
    "copilot-relay completion ",
  ]
  const result = spawnSync("zsh", ["-f", path.join(repoRoot, "tests", "fixtures", "zsh-complete.zsh"), file, work], {
    encoding: "utf8",
    input: `${lines.join("\n")}\n`,
    env: { ...process.env, PATH: `${stubRelayDirectory()}${path.delimiter}${process.env.PATH ?? ""}` },
    timeout: 100_000,
  })
  assert.equal(result.status, 0, result.stderr)

  const offered = new Map<string, string[]>()
  let current = ""
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("=== ")) {
      current = line.slice(4)
      offered.set(current, [])
    } else if (line.trim() !== "") {
      offered.get(current)?.push(line.trim())
    }
  }

  assert.deepEqual(offered.get("copilot-relay se"), ["setup"])
  assert.deepEqual(offered.get("copilot-relay setup "), ["claude-code-app", "claude-code-cli", "codex-app", "codex-cli"])
  assert.deepEqual(offered.get("copilot-relay models --model "), ["claude-opus-5.5", "gpt-6-astra"])
  assert.deepEqual(offered.get("copilot-relay cache --since "), ["24h", "2d", "6h", "7d"])
  assert.deepEqual(offered.get("copilot-relay status --d"), ["--deep"])
  assert.deepEqual(offered.get("copilot-relay completion "), ["bash", "fish", "powershell", "zsh"])
})

test("fish parses the script", { skip: !hasShell("fish") || process.platform === "win32" }, async () => {
  const file = writeScript("copilot-relay.fish", renderCompletion("fish", await buildCompletionSpec()))
  const result = spawnSync("fish", ["--no-execute", file], { encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr)
})

// TabExpansion2 is what PowerShell runs for Tab, so it returns the completions a user would see.
test("PowerShell parses the script and completes commands and setup targets", { skip: !hasShell("pwsh") }, async () => {
  const file = writeScript("copilot-relay.ps1", renderCompletion("powershell", await buildCompletionSpec()))
  const quoted = file.replaceAll("'", "''")
  const check = [
    "$errors = $null",
    `[System.Management.Automation.Language.Parser]::ParseFile('${quoted}', [ref]$null, [ref]$errors) | Out-Null`,
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }",
    `. '${quoted}'`,
    "foreach ($line in @('copilot-relay se', 'copilot-relay setup ', 'copilot-relay status --d')) {",
    "  $found = (TabExpansion2 -inputScript $line -cursorColumn $line.Length).CompletionMatches | ForEach-Object { $_.CompletionText } | Sort-Object",
    "  Write-Output ('=== ' + $line)",
    "  $found | ForEach-Object { Write-Output $_ }",
    "}",
  ].join("\n")
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", check], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stdout + result.stderr)

  const offered = new Map<string, string[]>()
  let current = ""
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith("=== ")) {
      current = line.slice(4)
      offered.set(current, [])
    } else if (line.trim() !== "") {
      offered.get(current)?.push(line.trim())
    }
  }

  assert.deepEqual(offered.get("copilot-relay se"), ["setup"])
  assert.deepEqual(offered.get("copilot-relay setup "), ["claude-code-app", "claude-code-cli", "codex-app", "codex-cli"])
  assert.deepEqual(offered.get("copilot-relay status --d"), ["--deep"])
})
