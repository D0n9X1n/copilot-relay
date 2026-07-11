import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { applyClaudeConfig } from "../../src/lib/claude-settings"

const withTemporarySettings = async (
  run: (configPath: string) => Promise<void>,
): Promise<void> => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-claude-"))
  try {
    await run(path.join(directory, ".claude", "settings.json"))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

const readSettings = async (
  configPath: string,
): Promise<Record<string, unknown>> =>
  JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>

// Why: a fresh managed Claude Code setup must actually select the configured GPT
// default and expose its 1M client-side context identity without changing the
// canonical model that Copilot receives.
test("creates Claude settings with the 1M GPT identity", async () => {
  await withTemporarySettings(async (configPath) => {
    const result = await applyClaudeConfig({
      baseUrl: "http://127.0.0.1:4142",
      configPath,
      gptModel: "GPT-5.6-SOL[1M][1m]",
    })
    const settings = await readSettings(configPath)
    const env = settings.env as Record<string, unknown>

    assert.deepEqual(result, {
      configPath,
      changed: true,
      created: true,
      previousBaseUrl: undefined,
    })
    assert.equal(settings.model, "gpt-5.6-sol[1m]")
    assert.equal(env.ANTHROPIC_MODEL, undefined)
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4142")
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "dummy")
  })
})

// Why: normalization is exact-model-only. A new file may still select another
// configured GPT model, but that identity must be written unchanged.
test("keeps another configured model unchanged in new settings", async () => {
  await withTemporarySettings(async (configPath) => {
    await applyClaudeConfig({
      baseUrl: "http://127.0.0.1:4142",
      configPath,
      gptModel: "gpt-5.6-sol-preview",
    })
    const settings = await readSettings(configPath)
    const env = settings.env as Record<string, unknown>

    assert.equal(settings.model, "gpt-5.6-sol-preview")
    assert.equal(env.ANTHROPIC_MODEL, undefined)
  })
})

// Why: managed setup may encounter the plain ID in any known Claude Code model
// override. Normalize only that exact identity while preserving user choices,
// unrelated settings, existing auth, and absent secondary overrides.
test("normalizes known GPT overrides and preserves unrelated settings", async () => {
  await withTemporarySettings(async (configPath) => {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, `${JSON.stringify({
      model: "GPT-5.6-SOL[1M][1m]",
      permissions: { allow: ["Read"] },
      env: {
        ANTHROPIC_AUTH_TOKEN: "real-token",
        ANTHROPIC_BASE_URL: "http://old-relay:4142",
        ANTHROPIC_MODEL: "gpt-5.6-sol",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "GPT-5.6-SOL[1M]",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "gpt-5.6-sol[1m][1M]",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "GPT-5.6-SOL",
        ANTHROPIC_DEFAULT_FABLE_MODEL: "GPT-5.6-SOL[1M]",
        ANTHROPIC_SMALL_FAST_MODEL: "gpt-5.6-sol[1M]",
        CLAUDE_CODE_SUBAGENT_MODEL: "GPT-5.6-SOL",
        UNRELATED_ENV: "keep-me",
      },
    }, null, 2)}\n`)

    const result = await applyClaudeConfig({
      baseUrl: "http://127.0.0.1:5151",
      configPath,
      gptModel: "gpt-5.6-sol",
    })
    const settings = await readSettings(configPath)
    const env = settings.env as Record<string, unknown>

    assert.equal(result.previousBaseUrl, "http://old-relay:4142")
    assert.equal(settings.model, "gpt-5.6-sol[1m]")
    assert.deepEqual(settings.permissions, { allow: ["Read"] })
    assert.equal(env.ANTHROPIC_MODEL, "gpt-5.6-sol[1m]")
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "gpt-5.6-sol[1m]")
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "gpt-5.6-sol[1m]")
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "gpt-5.6-sol[1m]")
    assert.equal(env.ANTHROPIC_DEFAULT_FABLE_MODEL, "gpt-5.6-sol[1m]")
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "gpt-5.6-sol[1m]")
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "gpt-5.6-sol[1m]")
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "real-token")
    assert.equal(env.UNRELATED_ENV, "keep-me")
  })
})

// Why: family and subagent mappings do not select the main session model. They
// must remain intact while the managed top-level default is added.
test("seeds the GPT default when existing settings have no primary override", async () => {
  await withTemporarySettings(async (configPath) => {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, `${JSON.stringify({
      theme: "dark",
      env: {
        ANTHROPIC_AUTH_TOKEN: "keep-token",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4.8",
        CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku-4.5",
      },
    }, null, 2)}\n`)

    await applyClaudeConfig({
      baseUrl: "http://127.0.0.1:4142",
      configPath,
      gptModel: "gpt-5.6-sol",
    })
    const settings = await readSettings(configPath)
    const env = settings.env as Record<string, unknown>

    assert.equal(settings.model, "gpt-5.6-sol[1m]")
    assert.equal(env.ANTHROPIC_MODEL, undefined)
    assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, undefined)
    assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, undefined)
    assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "claude-opus-4.8")
    assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, undefined)
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "claude-haiku-4.5")
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "keep-token")
    assert.equal(settings.theme, "dark")
  })
})

// Why: ANTHROPIC_MODEL outranks the saved model setting. Managed setup must
// preserve an explicit primary choice without adding another selector.
test("preserves unrelated primary model overrides without seeding competitors", async () => {
  await withTemporarySettings(async (configPath) => {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, `${JSON.stringify({
      model: "claude-opus-4.8",
      env: {
        CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku-4.5",
      },
    }, null, 2)}\n`)

    await applyClaudeConfig({
      baseUrl: "http://127.0.0.1:4142",
      configPath,
      gptModel: "gpt-5.6-sol",
    })
    const settings = await readSettings(configPath)
    const env = settings.env as Record<string, unknown>

    assert.equal(settings.model, "claude-opus-4.8")
    assert.equal(env.ANTHROPIC_MODEL, undefined)
    assert.equal(env.CLAUDE_CODE_SUBAGENT_MODEL, "claude-haiku-4.5")
  })
})

// Why: ANTHROPIC_MODEL has higher startup precedence than the top-level model
// setting. An explicit environment choice must remain authoritative rather than
// being shadowed by a relay-managed default.
test("preserves an explicit ANTHROPIC_MODEL without seeding model", async () => {
  await withTemporarySettings(async (configPath) => {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, `${JSON.stringify({
      env: {
        ANTHROPIC_MODEL: "sonnet",
      },
    }, null, 2)}\n`)

    await applyClaudeConfig({
      baseUrl: "http://127.0.0.1:4142",
      configPath,
      gptModel: "gpt-5.6-sol",
    })
    const settings = await readSettings(configPath)
    const env = settings.env as Record<string, unknown>

    assert.equal(settings.model, undefined)
    assert.equal(env.ANTHROPIC_MODEL, "sonnet")
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:4142")
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "dummy")
  })
})

// Why: model picker restrictions are a separate user-controlled setting. Relay
// setup may choose the startup default but must not hide or rewrite entries such
// as Haiku and Sonnet.
test("preserves availableModels while seeding the managed default", async () => {
  await withTemporarySettings(async (configPath) => {
    const availableModels = ["haiku", "sonnet", "opus"]
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, `${JSON.stringify({
      availableModels,
      permissions: { allow: ["Read"] },
    }, null, 2)}\n`)

    await applyClaudeConfig({
      baseUrl: "http://127.0.0.1:4142",
      configPath,
      gptModel: "gpt-5.6-sol",
    })
    const settings = await readSettings(configPath)
    const env = settings.env as Record<string, unknown>

    assert.equal(settings.model, "gpt-5.6-sol[1m]")
    assert.deepEqual(settings.availableModels, availableModels)
    assert.deepEqual(settings.permissions, { allow: ["Read"] })
    assert.equal(env.ANTHROPIC_MODEL, undefined)
  })
})

// Why: the configured GPT model is the managed default regardless of which
// upstream ID the user selected, provided no primary override already exists.
test("seeds another configured GPT model in existing settings", async () => {
  await withTemporarySettings(async (configPath) => {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, `${JSON.stringify({
      theme: "dark",
      env: { ANTHROPIC_AUTH_TOKEN: "keep-token" },
    }, null, 2)}\n`)

    await applyClaudeConfig({
      baseUrl: "http://127.0.0.1:4142",
      configPath,
      gptModel: "gpt-5.6-sol-preview",
    })
    const settings = await readSettings(configPath)
    const env = settings.env as Record<string, unknown>

    assert.equal(settings.model, "gpt-5.6-sol-preview")
    assert.equal(env.ANTHROPIC_MODEL, undefined)
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "keep-token")
  })
})

// Why: rewriting malformed user settings could destroy data. The writer must
// leave the exact bytes untouched and report that it made no change.
test("leaves malformed Claude settings untouched", async () => {
  await withTemporarySettings(async (configPath) => {
    const malformed = "{ not-valid-json\n"
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, malformed)

    const result = await applyClaudeConfig({
      baseUrl: "http://127.0.0.1:4142",
      configPath,
      gptModel: "gpt-5.6-sol",
    })

    assert.equal(await fs.readFile(configPath, "utf8"), malformed)
    assert.deepEqual(result, {
      configPath,
      changed: false,
      created: false,
    })
  })
})

// Why: parseable JSON can still be malformed as Claude settings. A non-object
// root or non-object env block must be preserved just like invalid JSON.
test("leaves malformed Claude settings shapes untouched", async () => {
  for (const malformed of [
    "",
    "  \n",
    "[]\n",
    "{\"env\":\"invalid\"}\n",
    "{\"model\":42}\n",
    "{\"env\":{\"ANTHROPIC_MODEL\":42}}\n",
  ]) {
    await withTemporarySettings(async (configPath) => {
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, malformed)

      const result = await applyClaudeConfig({
        baseUrl: "http://127.0.0.1:4142",
        configPath,
        gptModel: "gpt-5.6-sol",
      })

      assert.equal(await fs.readFile(configPath, "utf8"), malformed)
      assert.deepEqual(result, {
        configPath,
        changed: false,
        created: false,
      })
    })
  }
})

// Why: startup runs repeatedly. Once settings are normalized, another managed
// setup pass must not rewrite even one byte.
test("is byte-idempotent after the first settings update", async () => {
  await withTemporarySettings(async (configPath) => {
    const input = {
      baseUrl: "http://127.0.0.1:4142",
      configPath,
      gptModel: "gpt-5.6-sol",
    }

    const first = await applyClaudeConfig(input)
    const firstBytes = await fs.readFile(configPath)
    const second = await applyClaudeConfig(input)
    const secondBytes = await fs.readFile(configPath)

    assert.equal(first.changed, true)
    assert.deepEqual(second, {
      configPath,
      changed: false,
      created: false,
      previousBaseUrl: "http://127.0.0.1:4142",
    })
    assert.deepEqual(secondBytes, firstBytes)
  })
})
