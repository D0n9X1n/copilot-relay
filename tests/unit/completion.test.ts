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
type CompletionShell = import("../../src/lib/completion").CompletionShell
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
// install. It prints the given models, one per line, the way `completion --models` does.
const stubRelayDirectory = (models: string[] = ["gpt-6-astra", "claude-opus-5.5"]): string => {
  const directory = fs.mkdtempSync(path.join(home, "bin-"))
  const list = path.join(directory, "models.txt")
  fs.writeFileSync(list, models.map((model) => `${model}\n`).join(""))
  const stub = path.join(directory, "copilot-relay")
  fs.writeFileSync(stub, `#!/bin/sh\ncat '${list}'\n`)
  fs.chmodSync(stub, 0o755)
  return directory
}

// fish single quotes: a backslash and a quote are the only characters that need a backslash.
const singleQuoteForFish = (text: string): string => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`

// A model name that runs a command if a shell evaluates it rather than offering it as text.
const injectedModel = (marker: string): string => `$(touch ${marker})`

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

// How each shell registers a command, and the part of the script that belongs to one command, so
// an option is looked for only where that command's completions are. A script that only mentions
// a name, in a comment, a description or another command's section, does not pass.
const sectionEnd = (script: string, from: number, end: string): string => {
  const stop = script.indexOf(end, from)
  return script.slice(from, stop === -1 ? undefined : stop)
}

const registrations: Record<CompletionShell, {
  command: (script: string, name: string) => boolean
  option: (script: string, command: string, option: string) => boolean
}> = {
  zsh: {
    command: (script, name) => script.includes(`\n    '${name}:`),
    option: (script, command, option) => {
      const from = script.indexOf(`\n    (${command})\n`)
      const section = from === -1 ? "" : sectionEnd(script, from + 1, "\n      ;;")
      return section.includes(`'--${option}[`) || section.includes(`'--${option}=[`)
    },
  },
  bash: {
    command: (script, name) => script.includes(`\n    ${name})\n`),
    option: (script, command, option) => {
      const from = script.indexOf(`\n    ${command})\n`)
      const section = from === -1 ? "" : sectionEnd(script, from + 1, "\n      ;;")
      return section.split("\n").some((line) => line.trimStart().startsWith("_copilot_relay_offer ") && line.includes(`'--${option}'`))
    },
  },
  fish: {
    command: (script, name) => script.includes(`\ncomplete -c copilot-relay -n '__copilot_relay_using' -a ${name} -d `),
    option: (script, command, option) =>
      new RegExp(`^complete -c copilot-relay -n '__copilot_relay_using ${command}' -l ${option}( |$)`, "m").test(script),
  },
  powershell: {
    command: (script, name) => script.includes(`\n  '${name}' = @{\n`),
    option: (script, command, option) => {
      const from = script.indexOf(`\n  '${command}' = @{\n`)
      const section = from === -1 ? "" : sectionEnd(script, from + 1, "\n  }\n")
      return section.includes(`\n        '--${option}' = @{`)
    },
  },
}

test("each shell's script registers every command and every option", async () => {
  const spec = await buildCompletionSpec()

  for (const shell of completionShells) {
    const script = renderCompletion(shell, spec)

    for (const command of spec.commands) {
      assert(registrations[shell].command(script, command.name), `${shell} must register ${command.name}`)
      for (const option of command.options) {
        assert(registrations[shell].option(script, command.name, option.name), `${shell} must register ${command.name} --${option.name}`)
      }
    }

    for (const word of ["claude-code-cli", "codex-app", "6h", "7d", "completion --models"]) {
      assert(script.includes(word), `${shell} script must include ${word}`)
    }
  }
})

// cache and models both have --model. With it removed from cache alone, the check must still see
// it missing there, or it could pass on the other command's registration.
test("the registration check fails when one command loses one option", async () => {
  const spec = await buildCompletionSpec()
  const withoutCacheModel = {
    commands: spec.commands.map((command) => command.name === "cache"
      ? { ...command, options: command.options.filter((option) => option.name !== "model") }
      : command),
  }

  for (const shell of completionShells) {
    const script = renderCompletion(shell, withoutCacheModel)

    assert.equal(registrations[shell].option(script, "cache", "model"), false, `${shell} check must notice cache --model is gone`)
    assert.equal(registrations[shell].option(script, "models", "model"), true, `${shell} check must still find models --model`)
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
  const complete = (words: string[], options: { cwd?: string, models?: string[] } = {}): string[] => {
    // Each word is passed through the environment, so the test's own quoting cannot change it.
    const environment: Record<string, string> = {}
    words.forEach((word, index) => {
      environment[`WORD_${index}`] = word
    })
    const script = [
      `source '${file}'`,
      "COMP_WORDS=()",
      ...words.map((_, index) => `COMP_WORDS[${index}]=$WORD_${index}`),
      `COMP_CWORD=${words.length - 1}`,
      "_copilot_relay",
      `printf '%s\\n' "\${COMPREPLY[@]}"`,
    ].join("\n")
    const result = spawnSync("bash", ["-c", script], {
      cwd: options.cwd,
      encoding: "utf8",
      env: { ...process.env, ...environment, PATH: `${stubRelayDirectory(options.models)}${path.delimiter}${process.env.PATH ?? ""}` },
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

  // bash 3.2 keeps "--model=gp" as one word; later bash splits it at the = into "--model", "="
  // and "gp". Either way the value alone is completed, as readline replaces the text after the =.
  assert.deepEqual(complete(["copilot-relay", "models", "--model=gp"]), ["gpt-6-astra"])
  assert.deepEqual(complete(["copilot-relay", "cache", "--since=7"]), ["7d"])
  assert.deepEqual(complete(["copilot-relay", "models", "--model", "=", "gp"]), ["gpt-6-astra"])
  assert.deepEqual(complete(["copilot-relay", "cache", "--since", "=", "7"]), ["7d"])

  // A configured model is offered escaped, never evaluated: not when Tab is pressed, and not when
  // the completed line is run.
  const marker = path.join(home, "bash-injected")
  const offered = complete(["copilot-relay", "models", "--model", ""], { models: [injectedModel(marker), "gpt-6-astra"] })
  const escaped = spawnSync("bash", ["-c", 'printf "%q" "$MODEL"'], { encoding: "utf8", env: { ...process.env, MODEL: injectedModel(marker) } }).stdout
  assert.equal(fs.existsSync(marker), false, "a model name must not run as a command")
  assert(offered.includes(escaped), "the model name must be offered escaped")

  // A directory with a space is one completion, escaped for the command line.
  const captures = fs.mkdtempSync(path.join(home, "captures-"))
  fs.mkdirSync(path.join(captures, "my capture"))
  assert.deepEqual(complete(["copilot-relay", "replay", "my"], { cwd: captures }), ["my\\ capture/"])
})

// Loaded with eval, as ~/.zshrc does, the script registers its function with compinit; autoloaded
// from fpath as a _copilot-relay file, it runs as that function.
test("zsh registers the completion function when the script is evaluated after compinit", { skip: !hasShell("zsh") || process.platform === "win32" }, async () => {
  const file = writeScript("_copilot-relay.zsh", renderCompletion("zsh", await buildCompletionSpec()))
  assert.equal(spawnSync("zsh", ["-n", file]).status, 0)

  const script = [
    "autoload -Uz compinit",
    `compinit -u -d '${path.join(home, "zcompdump")}'`,
    `eval "$(cat '${file}')"`,
    "print -r -- \"${_comps[copilot-relay]}\"",
  ].join("\n")
  const result = spawnSync("zsh", ["-f", "-c", script], { encoding: "utf8" })

  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), "_copilot_relay")
})

// zpty drives an interactive zsh through a pseudo-terminal, so this checks what a user gets when
// pressing Tab, not only that the script parses.
test("zsh offers commands, setup targets, configured models and option values on Tab", { skip: !hasShell("zsh") || process.platform === "win32", timeout: 120_000 }, async () => {
  const file = writeScript("_copilot-relay-tab.zsh", renderCompletion("zsh", await buildCompletionSpec()))
  const work = fs.mkdtempSync(path.join(home, "zsh-tab-"))
  const marker = path.join(home, "zsh-injected")
  const lines = [
    "copilot-relay se",
    "copilot-relay setup ",
    "copilot-relay models --model ",
    "copilot-relay cache --since ",
    "copilot-relay cache --since=2",
    "copilot-relay models --model=gp",
    "copilot-relay status --d",
    "copilot-relay completion ",
  ]
  const result = spawnSync("zsh", ["-f", path.join(repoRoot, "tests", "fixtures", "zsh-complete.zsh"), file, work], {
    encoding: "utf8",
    input: `${lines.join("\n")}\n`,
    env: {
      ...process.env,
      PATH: `${stubRelayDirectory(["gpt-6-astra", "claude-opus-5.5", injectedModel(marker)])}${path.delimiter}${process.env.PATH ?? ""}`,
    },
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
  assert.deepEqual(offered.get("copilot-relay models --model "), [injectedModel(marker), "claude-opus-5.5", "gpt-6-astra"])
  assert.equal(fs.existsSync(marker), false, "a model name must not run as a command")
  assert.deepEqual(offered.get("copilot-relay cache --since "), ["24h", "2d", "6h", "7d"])
  assert.deepEqual(offered.get("copilot-relay cache --since=2"), ["24h", "2d"])
  assert.deepEqual(offered.get("copilot-relay models --model=gp"), ["gpt-6-astra"])
  assert.deepEqual(offered.get("copilot-relay status --d"), ["--deep"])
  assert.deepEqual(offered.get("copilot-relay completion "), ["bash", "fish", "powershell", "zsh"])
})

// The completed line is printed rather than run, so this checks the text each shell inserts: the
// joined --option=value form, and a model name with $( inserted so it stays literal text.
test("bash and zsh insert completions that stay literal when the line is run", { skip: process.platform === "win32" || !hasShell("zsh"), timeout: 120_000 }, async () => {
  const spec = await buildCompletionSpec()
  const marker = path.join(home, "line-injected")
  const bin = stubRelayDirectory(["gpt-6-astra", "claude-opus-5.5", `inj${injectedModel(marker)}`])
  const lines = [
    "copilot-relay cache --since=7",
    "copilot-relay models --model=inj",
    "copilot-relay models --model inj",
    "copilot-relay setup claude-code-c",
  ]
  const shells: Array<[string, string, string, string[]]> = []
  if (hasShell("bash")) {
    const file = writeScript("line.bash", renderCompletion("bash", spec))
    shells.push(["bash", `PS1='$ '; source '${file}'`, "echo LINE:", ["bash", "--norc", "--noprofile", "-i"]])
  }

  const zshFile = writeScript("line.zsh", renderCompletion("zsh", spec))
  shells.push(["zsh", `PS1='$ '; bindkey -e; autoload -Uz compinit; compinit -u -d '${path.join(home, "line-zcompdump")}'; source '${zshFile}'`, "print -r -- LINE:", ["zsh", "-f", "-i"]])

  for (const [name, setup, prefix, command] of shells) {
    const result = spawnSync("zsh", ["-f", path.join(repoRoot, "tests", "fixtures", "shell-line.zsh"), setup, prefix, ...command], {
      encoding: "utf8",
      input: `${lines.join("\n")}\n`,
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      timeout: 100_000,
    })
    assert.equal(result.status, 0, `${name}: ${result.stderr}`)

    const printed = result.stdout.split("\n").filter((line) => line.startsWith("LINE:")).map((line) => line.trim())
    assert.equal(printed.length, lines.length, `${name} printed ${printed.join(" | ")}`)
    assert.equal(printed[0], "LINE: copilot-relay cache --since=7d", `${name} joined --since=`)
    assert.equal(printed[1], `LINE: copilot-relay models --model=inj${injectedModel(marker)}`, `${name} joined --model=`)
    assert.equal(printed[2], `LINE: copilot-relay models --model inj${injectedModel(marker)}`, `${name} --model value`)
    assert.equal(printed[3], "LINE: copilot-relay setup claude-code-cli", `${name} setup target`)
    assert.equal(fs.existsSync(marker), false, `${name} must not run a $( in a model name`)
  }
})

// complete -C prints what fish offers for a command line, the same list Tab shows.
test("fish parses the script and completes by the command word, skipping option values", { skip: !hasShell("fish") || process.platform === "win32" }, async () => {
  const file = writeScript("copilot-relay.fish", renderCompletion("fish", await buildCompletionSpec()))
  const parsed = spawnSync("fish", ["--no-execute", file], { encoding: "utf8" })
  assert.equal(parsed.status, 0, parsed.stderr)

  const complete = (line: string): string[] => {
    const result = spawnSync("fish", ["--no-config", "-c", `source '${file}'; complete -C ${singleQuoteForFish(line)}`], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubRelayDirectory()}${path.delimiter}${process.env.PATH ?? ""}` },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.split("\n").map((entry) => entry.split("\t")[0]).filter((entry) => entry !== "").sort()
  }

  assert.deepEqual(complete("copilot-relay se"), ["setup"])
  assert.deepEqual(complete("copilot-relay setup claude-code-c"), ["claude-code-app", "claude-code-cli"])
  assert.deepEqual(complete("copilot-relay status --d"), ["--deep"])
  assert.deepEqual(complete("copilot-relay status --h"), ["--help"])
  assert.deepEqual(complete("copilot-relay models --model gp"), ["gpt-6-astra"])
  assert.deepEqual(complete("copilot-relay cache --model status --d"), ["--daily"])
})

// TabExpansion2 is what PowerShell runs for Tab, so it returns the completions a user would see.
test("PowerShell parses the script and completes commands and setup targets", { skip: !hasShell("pwsh") }, async () => {
  const file = writeScript("copilot-relay.ps1", renderCompletion("powershell", await buildCompletionSpec()))
  const quoted = file.replaceAll("'", "''")
  const captures = fs.mkdtempSync(path.join(home, "pwsh-captures-"))
  fs.mkdirSync(path.join(captures, "cap tures"))
  const check = [
    "$errors = $null",
    `[System.Management.Automation.Language.Parser]::ParseFile('${quoted}', [ref]$null, [ref]$errors) | Out-Null`,
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }",
    `. '${quoted}'`,
    // A function named copilot-relay answers the model lookup, ahead of any command on PATH.
    "function copilot-relay { 'gpt-6-astra'; 'claude-opus-5.5'; 'inj$(touch x)' }",
    `Set-Location -LiteralPath '${captures.replaceAll("'", "''")}'`,
    "$probes = @(",
    "  @('copilot-relay se', 16),",
    "  @('copilot-relay setup ', 20),",
    "  @('copilot-relay status --d', 24),",
    "  @('copilot-relay cache --since=2', 29),",
    "  @('copilot-relay models --model g --deep', 29),",
    "  @('copilot-relay models --model inj', 33),",
    "  @('copilot-relay replay ./cap', 26)",
    ")",
    "foreach ($probe in $probes) {",
    "  $found = (TabExpansion2 -inputScript $probe[0] -cursorColumn $probe[1]).CompletionMatches | ForEach-Object { $_.CompletionText } | Sort-Object",
    "  Write-Output ('=== ' + $probe[0])",
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
  assert.deepEqual(offered.get("copilot-relay cache --since=2"), ["--since=24h", "--since=2d"])
  assert.deepEqual(offered.get("copilot-relay models --model g --deep"), ["gpt-6-astra"])
  assert.deepEqual(offered.get("copilot-relay models --model inj"), ["'inj$(touch x)'"])
  assert.deepEqual(offered.get("copilot-relay replay ./cap"), ["'./cap tures/'"])
})
