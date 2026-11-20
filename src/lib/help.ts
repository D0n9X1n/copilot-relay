// What --help prints: citty's usage text, wrapped so every line fits a standard terminal.
import { renderUsage, type ArgsDef, type CommandDef } from "citty"
import { consola } from "consola"
import { stripVTControlCharacters } from "node:util"

import { displayWidth } from "./terminal"

const helpWidth = 80

// citty wraps names in backticks, which consola prints as color or drops, and colors a few itself,
// so width is measured without either.
const visibleWidth = (text: string): number =>
  displayWidth(stripVTControlCharacters(text).replaceAll("`", ""))

// Greedy word wrap: each continuation line starts with indent, and a word longer than the line
// stays whole rather than being split.
const wrapWords = (prefix: string, words: string[], indent: string, width: number): string[] => {
  const lines: string[] = []
  let current = prefix
  let empty = true

  for (const word of words) {
    const candidate = empty ? current + word : `${current} ${word}`

    if (!empty && visibleWidth(candidate) > width) {
      lines.push(current)
      current = indent + word
    } else {
      current = candidate
    }

    empty = false
  }

  lines.push(current)

  return lines
}

// A table row is a name, a gap of two or more spaces, then its description. A long description
// wraps under its own column; any other long line wraps under its own indent.
const wrapLine = (line: string, width: number): string[] => {
  if (visibleWidth(line) <= width) {
    return [line]
  }

  const row = /^(\s*\S.*?)( {2,})(?=\S)/.exec(line)

  if (row !== null) {
    const prefix = row[0]
    return wrapWords(prefix, line.slice(prefix.length).split(/ +/), " ".repeat(visibleWidth(prefix)), width)
  }

  // A usage line continues under its first word, so the command it names stands out. citty colors
  // USAGE when color is on, so the word is found without the escapes around it.
  const indent = /^\s*/.exec(line)?.[0] ?? ""
  const usage = stripVTControlCharacters(line).trimStart().startsWith("USAGE ")
  const hanging = usage ? indent + " ".repeat("USAGE ".length) : indent

  return wrapWords(indent, line.trim().split(/ +/), hanging, width)
}

// Spaces at the end of a line, including those before a closing color span or backtick, as citty
// leaves after a usage line's last argument; consola prints a backtick span as plain or cyan text.
const trailingSpaces = /\s+((?:\u001b\[[0-9;]*m|`)*)$/

/** Help text with trailing spaces removed and every line wrapped to width columns. */
export const wrapHelp = (text: string, width = helpWidth): string =>
  text.split("\n").flatMap((line) => wrapLine(line.replace(trailingSpaces, "$1"), width)).join("\n")

/** citty's showUsage, with the text wrapped. */
export const showHelp = async <T extends ArgsDef = ArgsDef>(command: CommandDef<T>, parent?: CommandDef<T>): Promise<void> => {
  try {
    consola.log(wrapHelp(await renderUsage(command, parent)) + "\n")
  } catch (error) {
    consola.error(error)
  }
}
