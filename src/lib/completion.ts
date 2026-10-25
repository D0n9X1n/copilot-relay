// Shell completion for copilot-relay: a description of the commands, built from their citty
// definitions, rendered as a completion script for zsh, bash, fish or PowerShell.
import type { ArgsDef } from "citty"

import { readExistingAppConfig } from "~/lib/app-config"

export const completionShells = ["zsh", "bash", "fish", "powershell"] as const
export type CompletionShell = (typeof completionShells)[number]

export const isCompletionShell = (value: string): value is CompletionShell =>
  (completionShells as ReadonlyArray<string>).includes(value)

// What a value completes to: fixed words, the configured models (looked up when the shell
// completes, so a config edit shows at once), or directories.
export type CompletionValues =
  | { kind: "words", words: Array<string> }
  | { kind: "models" }
  | { kind: "directories" }

export interface CompletionOption {
  name: string
  description: string
  takesValue: boolean
  values?: CompletionValues
}

export interface CompletionCommand {
  name: string
  description: string
  options: Array<CompletionOption>
  positional: CompletionValues | undefined
}

export interface CompletionSpec {
  commands: Array<CompletionCommand>
}

// A command as citty defines it, with its meta and args already plain objects.
export interface CompletionSource {
  meta?: { description?: string }
  args?: ArgsDef
}

// Values keyed by "command --option", or "command <>" for the command's positional argument.
export type CompletionHints = Record<string, CompletionValues>

export const buildCompletionSpec = (
  commands: Record<string, CompletionSource>,
  hints: CompletionHints,
): CompletionSpec => ({
  commands: Object.entries(commands).map(([name, command]) => {
    const args = Object.entries(command.args ?? {})
    const options = args
      .filter(([, definition]) => definition.type !== "positional")
      .map(([optionName, definition]): CompletionOption => {
        const values = hints[`${name} --${optionName}`]
        const option: CompletionOption = {
          name: optionName,
          description: definition.description ?? "",
          takesValue: definition.type === "string",
        }
        if (values !== undefined) {
          option.values = values
        }

        return option
      })
    const hasPositional = args.some(([, definition]) => definition.type === "positional")

    return {
      name,
      description: command.meta?.description ?? "",
      options,
      positional: hasPositional ? hints[`${name} <>`] : undefined,
    }
  }),
})

/**
 * gptModel and opusModel from config.yaml, for completing a model option. Reads the file without
 * creating or rewriting it, and gives no models rather than an error when it is missing or cannot
 * be read: a completion must never print a failure into the command line being typed.
 */
export const completionModels = async (): Promise<Array<string>> => {
  try {
    const config = await readExistingAppConfig()
    if (config === undefined) {
      return []
    }

    return [...new Set([config.gptModel, config.opusModel].filter((model) => model !== ""))]
  } catch {
    return []
  }
}

// A description on one line, without the characters a shell could expand or a quoting rule could
// trip on. Descriptions are help text, so dropping them loses nothing a reader needs.
const plainDescription = (text: string): string =>
  text.replace(/[$`\\]/g, "").replace(/\s+/g, " ").trim()

const singleQuotePosix = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`

const singleQuoteFish = (text: string): string => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`

const singleQuotePowerShell = (text: string): string => `'${text.replaceAll("'", "''")}'`

// The value-taking options of a command, for a shell that has to skip an option's value when it
// looks for the command word.
const valueOptions = (spec: CompletionSpec): Array<string> =>
  [...new Set(spec.commands.flatMap((command) =>
    command.options.filter((option) => option.takesValue).map((option) => `--${option.name}`)))]

const modelsCommand = "copilot-relay completion --models"

// zsh: one _arguments call per command, after the command word is chosen.
const renderZsh = (spec: CompletionSpec): string => {
  const zshDescription = (text: string): string =>
    plainDescription(text).replaceAll("[", "(").replaceAll("]", ")")

  const zshValues = (label: string, values: CompletionValues | undefined): string => {
    if (values === undefined) {
      return `:${label}: `
    }

    if (values.kind === "words") {
      return `:${label}:(${values.words.join(" ")})`
    }

    if (values.kind === "models") {
      return `:${label}:_copilot_relay_models`
    }

    return `:${label}:_files -/`
  }

  const commandList = spec.commands
    .map((command) => `    ${singleQuotePosix(`${command.name}:${plainDescription(command.description)}`)}`)
    .join("\n")

  const commandCases = spec.commands.map((command) => {
    const specs = command.options.map((option) => {
      // "--since=" accepts both "--since 6h" and "--since=6h", as citty does.
      if (option.takesValue) {
        return singleQuotePosix(`--${option.name}=[${zshDescription(option.description)}]${zshValues(option.name, option.values)}`)
      }

      return singleQuotePosix(`--${option.name}[${zshDescription(option.description)}]`)
    })
    specs.push(singleQuotePosix("--help[Show help for this command]"))
    if (command.positional !== undefined) {
      specs.push(singleQuotePosix(`*${zshValues("argument", command.positional)}`))
    }

    return [
      `    (${command.name})`,
      `      _arguments -s ${specs.join(" \\\n        ")}`,
      "      ;;",
    ].join("\n")
  })

  return `#compdef copilot-relay
# zsh completion for copilot-relay. Generated by \`copilot-relay completion zsh\`.

_copilot_relay_models() {
  local -a models
  models=(\${(f)"$(${modelsCommand} 2>/dev/null)"})
  _describe -t models 'model' models
}

_copilot_relay() {
  local -a commands
  commands=(
${commandList}
  )

  if (( CURRENT == 2 )); then
    _describe -t commands 'copilot-relay command' commands
    _arguments '--help[Show help]' '--version[Show the version]'
    return
  fi

  local command=\${words[2]}
  shift 1 words
  (( CURRENT-- ))

  case $command in
${commandCases.join("\n")}
  esac
}

# Autoloaded from fpath, this file is the body of _copilot_relay; sourced or evaluated, it registers
# the function with compinit's compdef.
if [[ \${funcstack[1]} == _copilot_relay ]]; then
  _copilot_relay "$@"
elif (( \${+functions[compdef]} )); then
  compdef _copilot_relay copilot-relay
else
  print -u2 "copilot-relay completion: run compinit before loading this script"
fi
`
}

// bash: works with bash 3.2, the macOS default. Candidates are matched in bash itself rather than
// with `compgen -W`, which expands the word list again and would run a `$(...)` in a model name.
const renderBash = (spec: CompletionSpec): string => {
  // The lines that fill COMPREPLY for one kind of value, at the given indent. A free-form value
  // completes nothing, so the user types it.
  const reply = (values: CompletionValues | undefined, indent: string): Array<string> => {
    if (values === undefined) {
      return [`${indent}return 0`]
    }

    if (values.kind === "words") {
      return [`${indent}_copilot_relay_offer ${values.words.map(singleQuotePosix).join(" ")}`, `${indent}return 0`]
    }

    if (values.kind === "models") {
      return [`${indent}_copilot_relay_offer_lines < <(_copilot_relay_models)`, `${indent}return 0`]
    }

    return [`${indent}_copilot_relay_offer_directories`, `${indent}return 0`]
  }

  const commandCases = spec.commands.map((command) => {
    const lines = [`    ${command.name})`]
    const valueOptionsOfCommand = command.options.filter((option) => option.takesValue)
    if (valueOptionsOfCommand.length > 0) {
      lines.push("      case $option in")
      for (const option of valueOptionsOfCommand) {
        lines.push(`        --${option.name})`, ...reply(option.values, "          "), "          ;;")
      }

      lines.push("      esac")
    }

    if (command.positional !== undefined) {
      lines.push("      if [[ $cur != -* ]]; then", ...reply(command.positional, "        "), "      fi")
    }

    const options = [...command.options.map((option) => `--${option.name}`), "--help"]
    lines.push(`      _copilot_relay_offer ${options.map(singleQuotePosix).join(" ")}`, "      ;;")
    return lines.join("\n")
  })

  const topLevel = [...spec.commands.map((command) => command.name), "--help", "--version"]

  // An option's value is skipped, not taken for the command word: two words for "--since 6h",
  // three for "--since=6h", which bash splits at the =. With no value-taking option, the case has
  // no such branch: an empty pattern is a syntax error.
  const skipValue = valueOptions(spec).length === 0
    ? ""
    : `      ${valueOptions(spec).join("|")})
        if [[ \${COMP_WORDS[index+1]} == = ]]; then
          index=$(( index + 3 ))
        else
          index=$(( index + 2 ))
        fi

        continue
        ;;
`

  return `# bash completion for copilot-relay. Generated by \`copilot-relay completion bash\`.

_copilot_relay_models() {
  ${modelsCommand} 2>/dev/null
}

# Offers each argument that starts with the word being completed. A case pattern compares the
# quoted word as text, so neither the candidate nor the typed word is expanded.
_copilot_relay_offer() {
  local candidate
  for candidate in "$@"; do
    case $candidate in
      "$cur"*)
        COMPREPLY+=("$candidate")
        ;;
    esac
  done
}

# Offers each line of standard input that starts with the word being completed.
_copilot_relay_offer_lines() {
  local candidate
  while IFS= read -r candidate; do
    if [[ -n $candidate ]]; then
      _copilot_relay_offer "$candidate"
    fi
  done
}

# Offers directories, escaped for the command line and ending in /, so a name with a space stays
# one argument and the next Tab goes inside it.
_copilot_relay_offer_directories() {
  local directory
  while IFS= read -r directory; do
    COMPREPLY+=("$(printf '%q' "$directory")/")
  done < <(compgen -d -- "$cur")

  if type compopt >/dev/null 2>&1; then
    compopt -o nospace
  fi
}

_copilot_relay() {
  local cur option command index word
  cur=\${COMP_WORDS[COMP_CWORD]}
  COMPREPLY=()

  # The option whose value is being completed: the word before, or the one before "=" when bash
  # split "--since=6h" into "--since", "=" and "6h".
  option=\${COMP_WORDS[COMP_CWORD-1]}
  if [[ $option == = && COMP_CWORD -ge 2 ]]; then
    option=\${COMP_WORDS[COMP_CWORD-2]}
  fi

  if [[ $cur == = ]]; then
    cur=
  fi

  # The command is the first word that is neither an option nor an option's value.
  command=
  index=1
  while (( index < COMP_CWORD )); do
    word=\${COMP_WORDS[index]}
    case $word in
${skipValue}      -*)
        ;;
      *)
        command=$word
        break
        ;;
    esac

    index=$(( index + 1 ))
  done

  if [[ -z $command ]]; then
    _copilot_relay_offer ${topLevel.map(singleQuotePosix).join(" ")}
    return 0
  fi

  case $command in
${commandCases.join("\n")}
  esac
}

complete -F _copilot_relay copilot-relay
`
}

const renderFish = (spec: CompletionSpec): string => {
  const names = spec.commands.map((command) => command.name).join(" ")
  const fishValues = (values: CompletionValues | undefined): string => {
    if (values === undefined) {
      return ""
    }

    if (values.kind === "words") {
      return ` -a ${singleQuoteFish(values.words.join(" "))}`
    }

    if (values.kind === "models") {
      return ` -a '(${modelsCommand} 2>/dev/null)'`
    }

    return " -a '(__fish_complete_directories)'"
  }

  const commandLines = spec.commands.map((command) => {
    const condition = `__fish_seen_subcommand_from ${command.name}`
    const lines = [
      `complete -c copilot-relay -n '__fish_use_subcommand' -a ${command.name} -d ${singleQuoteFish(plainDescription(command.description))}`,
    ]
    for (const option of command.options) {
      const value = option.takesValue ? ` -r${fishValues(option.values)}` : ""
      lines.push(`complete -c copilot-relay -n '${condition}' -l ${option.name}${value} -d ${singleQuoteFish(plainDescription(option.description))}`)
    }

    if (command.positional !== undefined) {
      lines.push(`complete -c copilot-relay -n '${condition}'${fishValues(command.positional)}`)
    }

    return lines.join("\n")
  })

  return `# fish completion for copilot-relay. Generated by \`copilot-relay completion fish\`.

complete -c copilot-relay -f
complete -c copilot-relay -n 'not __fish_seen_subcommand_from ${names}' -l help -d 'Show help'
complete -c copilot-relay -n 'not __fish_seen_subcommand_from ${names}' -l version -d 'Show the version'

${commandLines.join("\n\n")}
`
}

const renderPowerShell = (spec: CompletionSpec): string => {
  const valuesLiteral = (values: CompletionValues | undefined): string => {
    if (values === undefined) {
      return "$null"
    }

    if (values.kind === "words") {
      return `@(${values.words.map(singleQuotePowerShell).join(", ")})`
    }

    return singleQuotePowerShell(values.kind)
  }

  const commandEntries = spec.commands.map((command) => {
    const options = command.options.map((option) =>
      `        ${singleQuotePowerShell(`--${option.name}`)} = @{ TakesValue = $${option.takesValue}; Values = ${valuesLiteral(option.values)}; Description = ${singleQuotePowerShell(plainDescription(option.description) || option.name)} }`)

    return [
      `  ${singleQuotePowerShell(command.name)} = @{`,
      `    Description = ${singleQuotePowerShell(plainDescription(command.description) || command.name)}`,
      `    Positional = ${valuesLiteral(command.positional)}`,
      "    Options = [ordered]@{",
      ...options,
      "    }",
      "  }",
    ].join("\n")
  })

  return `# PowerShell completion for copilot-relay. Generated by \`copilot-relay completion powershell\`.

$script:CopilotRelayCommands = [ordered]@{
${commandEntries.join("\n")}
}

Register-ArgumentCompleter -Native -CommandName copilot-relay -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $words = @($commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() })
  if ($wordToComplete -ne '' -and $words.Count -gt 0) {
    $words = @($words | Select-Object -SkipLast 1)
  }

  # The command is the first word that is neither an option nor an option's value.
  $command = $null
  $index = 0
  while ($index -lt $words.Count) {
    $word = $words[$index]
    if ($word.StartsWith('-')) {
      $known = $null
      if ($command -ne $null) {
        $known = $script:CopilotRelayCommands[$command].Options[$word]
      }

      if ($known -ne $null -and $known.TakesValue) {
        $index += 1
      }
    } elseif ($command -eq $null) {
      $command = $word
    }

    $index += 1
  }

  $previous = $null
  if ($words.Count -gt 0) {
    $previous = $words[$words.Count - 1]
  }

  $candidates = @()
  $resolve = {
    param($values)
    if ($values -is [array]) {
      return $values | ForEach-Object { @{ Text = $_; Tip = $_ } }
    }

    if ($values -eq 'models') {
      return @(${modelsCommand} 2>$null) | Where-Object { $_ -ne '' } | ForEach-Object { @{ Text = $_; Tip = $_ } }
    }

    if ($values -eq 'directories') {
      return Get-ChildItem -Directory -Path "$wordToComplete*" -ErrorAction SilentlyContinue | ForEach-Object { @{ Text = $_.Name; Tip = $_.FullName } }
    }

    return @()
  }

  if ($command -eq $null -or -not $script:CopilotRelayCommands.Contains($command)) {
    foreach ($name in $script:CopilotRelayCommands.Keys) {
      $candidates += @{ Text = $name; Tip = $script:CopilotRelayCommands[$name].Description }
    }

    $candidates += @{ Text = '--help'; Tip = 'Show help' }
    $candidates += @{ Text = '--version'; Tip = 'Show the version' }
  } else {
    $entry = $script:CopilotRelayCommands[$command]
    $option = $null
    if ($previous -ne $null) {
      $option = $entry.Options[$previous]
    }

    if ($option -ne $null -and $option.TakesValue) {
      $candidates = @(& $resolve $option.Values)
    } elseif (-not $wordToComplete.StartsWith('-') -and $entry.Positional -ne $null) {
      $candidates = @(& $resolve $entry.Positional)
    } else {
      foreach ($name in $entry.Options.Keys) {
        $candidates += @{ Text = $name; Tip = $entry.Options[$name].Description }
      }

      $candidates += @{ Text = '--help'; Tip = 'Show help for this command' }
    }
  }

  $candidates | Where-Object { $_.Text -like "$wordToComplete*" } | ForEach-Object {
    [System.Management.Automation.CompletionResult]::new($_.Text, $_.Text, 'ParameterValue', $_.Tip)
  }
}
`
}

export const renderCompletion = (shell: CompletionShell, spec: CompletionSpec): string => {
  if (shell === "zsh") {
    return renderZsh(spec)
  }

  if (shell === "bash") {
    return renderBash(spec)
  }

  if (shell === "fish") {
    return renderFish(spec)
  }

  return renderPowerShell(spec)
}
