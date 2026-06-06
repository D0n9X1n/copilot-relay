// Maps Claude tool names to Copilot-compatible tool names and back.
import { createHash } from "node:crypto"

import type { ClaudeTool } from "~/claude/types"

const strictToolNameCharsPattern = /^[A-Za-z0-9_-]+$/
const dottedToolNameCharsPattern = /^[A-Za-z0-9_.-]+$/
const defaultToolNameMaxLength = 64
const extendedToolNameMaxLength = 128
const hashLength = 10

export interface ClaudeToolNameMapper {
  toClaude(name: string): string
  toOpenAI(name: string): string
}

interface ToolNameMapperOptions {
  allowDots?: boolean
  maxNameLength?: number
}

export const getToolNameMapperOptionsForModel = (
  modelId: string,
): Required<ToolNameMapperOptions> => {
  const normalized = modelId
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, "-1m")
    .replace(/[._]/g, "-")

  if (normalized.startsWith("gpt-")) {
    return { allowDots: false, maxNameLength: extendedToolNameMaxLength }
  }

  return { allowDots: false, maxNameLength: defaultToolNameMaxLength }
}

export const getClaudeToolNameMaxLength = (modelId: string): number =>
  getToolNameMapperOptionsForModel(modelId).maxNameLength

const makeHash = (value: string): string =>
  createHash("sha1").update(value).digest("hex").slice(0, hashLength)

const getAllowedNamePattern = (allowDots: boolean): RegExp =>
  allowDots ? dottedToolNameCharsPattern : strictToolNameCharsPattern

const cleanToolName = (name: string, allowDots: boolean): string => {
  const invalidCharsPattern = allowDots ? /[^A-Za-z0-9_.-]/g : /[^A-Za-z0-9_-]/g
  const cleaned = name.replace(invalidCharsPattern, "_").replace(/_+/g, "_")
  return cleaned.replace(/^_+|_+$/g, "") || "tool"
}

const isValidToolName = (
  name: string,
  maxNameLength: number,
  allowDots: boolean,
): boolean =>
  name.length > 0
  && name.length <= maxNameLength
  && getAllowedNamePattern(allowDots).test(name)

const makeValidToolName = (
  name: string,
  maxNameLength: number,
  allowDots: boolean,
): string => {
  if (isValidToolName(name, maxNameLength, allowDots)) {
    return name
  }

  const cleaned = cleanToolName(name, allowDots)
  if (cleaned.length <= maxNameLength) {
    return cleaned
  }

  const hash = makeHash(name)
  const prefixLength = maxNameLength - hash.length - 1
  return `${cleaned.slice(0, prefixLength)}_${hash}`
}

const makeUniqueToolName = (
  name: string,
  used: Set<string>,
  maxNameLength: number,
  allowDots: boolean,
): string => {
  const candidate = makeValidToolName(name, maxNameLength, allowDots)
  if (!used.has(candidate)) {
    return candidate
  }

  for (let index = 2; ; index++) {
    const suffix = `_${makeHash(`${name}:${index}`)}`
    const prefixLength = maxNameLength - suffix.length
    const next = `${cleanToolName(name, allowDots).slice(0, prefixLength)}${suffix}`
    if (!used.has(next)) {
      return next
    }
  }
}

export const createClaudeToolNameMapper = (
  tools: Array<ClaudeTool> | undefined,
  options: ToolNameMapperOptions = {},
): ClaudeToolNameMapper => {
  const maxNameLength = options.maxNameLength ?? defaultToolNameMaxLength
  const allowDots = options.allowDots ?? false
  const claudeToOpenAI = new Map<string, string>()
  const openAIToClaude = new Map<string, string>()
  const used = new Set<string>()

  for (const tool of tools ?? []) {
    if (claudeToOpenAI.has(tool.name)) {
      continue
    }

    const openAIName = makeUniqueToolName(
      tool.name,
      used,
      maxNameLength,
      allowDots,
    )
    used.add(openAIName)
    claudeToOpenAI.set(tool.name, openAIName)
    openAIToClaude.set(openAIName, tool.name)
  }

  return {
    toClaude: (name) => openAIToClaude.get(name) ?? name,
    toOpenAI: (name) =>
      claudeToOpenAI.get(name)
      ?? makeValidToolName(name, maxNameLength, allowDots),
  }
}
