// Optional writer for Claude Code settings so it points at the local proxy.
import { readFileSnapshot, writeFileSnapshot } from "~/lib/atomic-file"
import { normalizeClaudeModelId, type ModelTokenLimits } from "~/lib/models"

interface ApplyClaudeConfigInput {
  baseUrl: string
  configPath: string
  gptModel: string
  gptLimits?: ModelTokenLimits
  maxOutputTokens?: number
}

interface ApplyClaudeResult {
  configPath: string
  changed: boolean
  created: boolean
  previousBaseUrl?: string
}

const knownModelEnvKeys = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const hasMalformedModelOverride = (
  parsed: Record<string, unknown>,
): boolean => {
  if (parsed.model !== undefined && typeof parsed.model !== "string") {
    return true
  }

  const env = parsed.env
  if (!isRecord(env)) {
    return false
  }

  return knownModelEnvKeys.some(
    (key) => env[key] !== undefined && typeof env[key] !== "string",
  )
}

const hasPrimaryModelOverride = (
  parsed: Record<string, unknown>,
  env: Record<string, unknown>,
): boolean =>
  typeof parsed.model === "string"
  || typeof env.ANTHROPIC_MODEL === "string"

/**
 * Update `~/.claude/settings.json` so its env block points Claude Code at the
 * running proxy. Preserves unrelated keys and model choices while normalizing
 * managed one-million-context GPT overrides. Sets a dummy auth token only if absent.
 */
export async function applyClaudeConfig(
  input: ApplyClaudeConfigInput,
): Promise<ApplyClaudeResult> {
  const { configPath, baseUrl, gptModel } = input

  const snapshot = await readFileSnapshot(configPath)
  const raw = snapshot.raw ?? ""
  const created = snapshot.raw === null

  let parsed: Record<string, unknown> = {}

  // Only a missing file is created. An existing blank one is treated like a malformed file and left
  // as it is.
  if (!created && raw.trim().length === 0) {
    return { configPath, changed: false, created: false }
  }

  if (raw.trim().length > 0) {
    try {
      const value = JSON.parse(raw) as unknown
      if (
        !isRecord(value)
        || (value.env !== undefined && !isRecord(value.env))
        || hasMalformedModelOverride(value)
      ) {
        return { configPath, changed: false, created: false }
      }

      parsed = value
    } catch {
      // Refuse to overwrite a malformed file; bail without changes.
      return { configPath, changed: false, created: false }
    }
  }

  const env: Record<string, unknown> = isRecord(parsed.env) ? { ...parsed.env } : {}

  const previousBaseUrl =
    typeof env.ANTHROPIC_BASE_URL === "string"
      ? (env.ANTHROPIC_BASE_URL as string)
      : undefined

  const hadPrimaryModelOverride = hasPrimaryModelOverride(parsed, env)
  const contextWindow = input.gptLimits?.max_context_window_tokens
  const claudeGptModel = normalizeClaudeModelId(gptModel, contextWindow)
  const shouldSeedTopLevelModel = !hadPrimaryModelOverride
  const nextModel =
    typeof parsed.model === "string"
      ? normalizeClaudeModelId(parsed.model, contextWindow)
      : undefined

  // ANTHROPIC_MODEL outranks the saved model setting, so only normalize it
  // when the user already set it; managed defaults belong in `model`.
  for (const key of knownModelEnvKeys) {
    if (typeof env[key] === "string") {
      env[key] = normalizeClaudeModelId(env[key], contextWindow)
    }
  }

  env.ANTHROPIC_BASE_URL = baseUrl

  // Claude Code only requires a syntactically present auth token here; real
  // upstream authentication is handled by copilot-relay's Copilot token.
  if (typeof env.ANTHROPIC_AUTH_TOKEN !== "string" || !env.ANTHROPIC_AUTH_TOKEN) {
    env.ANTHROPIC_AUTH_TOKEN = "dummy"
  }

  if (contextWindow !== undefined && env.CLAUDE_CODE_MAX_CONTEXT_TOKENS === undefined) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(contextWindow)
  }

  if (input.maxOutputTokens !== undefined && env.CLAUDE_CODE_MAX_OUTPUT_TOKENS === undefined) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(input.maxOutputTokens)
  }

  // In auto mode Claude Code asks the server to check actions. In #162 those checks did not reach
  // it through the relay, so it made its own classifier requests and printed a notice asking the
  // gateway to support them. "0" skips the server check and the notice; the classifier requests
  // stay as they were. Seeded only when absent, so a value the user set is kept.
  if (env.CLAUDE_CODE_AUTO_MODE_SERVER === undefined) {
    env.CLAUDE_CODE_AUTO_MODE_SERVER = "0"
  }

  const next: Record<string, unknown> = {
    ...parsed,
    ...(nextModel !== undefined && { model: nextModel }),
    ...(shouldSeedTopLevelModel && { model: claudeGptModel }),
    env,
  }
  const serialized = `${JSON.stringify(next, null, 2)}\n`

  if (serialized === raw) {
    return { configPath, changed: false, created: false, previousBaseUrl }
  }

  await writeFileSnapshot(snapshot, serialized)
  return { configPath, changed: true, created, previousBaseUrl }
}
