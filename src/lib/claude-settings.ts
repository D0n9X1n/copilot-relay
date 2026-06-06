import fs from "node:fs/promises"
import path from "node:path"

interface ApplyClaudeConfigInput {
  baseUrl: string
  configPath: string
}

interface ApplyClaudeResult {
  configPath: string
  changed: boolean
  created: boolean
  previousBaseUrl?: string
}

/**
 * Update `~/.claude/settings.json` so its env block points Claude Code at the
 * running proxy. Preserves all unrelated keys (model overrides, plugins,
 * marketplaces, etc.). Sets a dummy auth token only if none is present.
 */
export async function applyClaudeConfig(
  input: ApplyClaudeConfigInput,
): Promise<ApplyClaudeResult> {
  const { configPath, baseUrl } = input

  let raw = ""
  let created = false
  try {
    raw = await fs.readFile(configPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      created = true
    } else {
      throw error
    }
  }

  let parsed: Record<string, unknown> = {}
  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        parsed = {}
      }
    } catch {
      // Refuse to overwrite a malformed file; bail without changes.
      return { configPath, changed: false, created: false }
    }
  }

  const env: Record<string, unknown> =
    typeof parsed.env === "object"
    && parsed.env !== null
    && !Array.isArray(parsed.env)
      ? { ...(parsed.env as Record<string, unknown>) }
      : {}

  const previousBaseUrl =
    typeof env.ANTHROPIC_BASE_URL === "string"
      ? (env.ANTHROPIC_BASE_URL as string)
      : undefined

  env.ANTHROPIC_BASE_URL = baseUrl
  if (typeof env.ANTHROPIC_AUTH_TOKEN !== "string" || !env.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_AUTH_TOKEN = "dummy"
  }

  const next: Record<string, unknown> = { ...parsed, env }
  const serialized = `${JSON.stringify(next, null, 2)}\n`

  if (serialized === raw) {
    return { configPath, changed: false, created: false, previousBaseUrl }
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, serialized)
  return { configPath, changed: true, created, previousBaseUrl }
}
