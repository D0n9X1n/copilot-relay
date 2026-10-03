import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import { astraLimits, solLimits } from "../fixtures/model-limits"

// Keep transitive paths/log imports away from the user's real profile.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-settings-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { applyClaudeConfig } = await import("../../src/lib/claude-settings")

test.after(async () => {
  await fs.rm(tempHome, { recursive: true, force: true })
})

const withTemporarySettings = async (
  run: (configPath: string) => Promise<void>,
): Promise<void> => {
  const directory = await fs.mkdtemp(path.join(tempHome, "case-"))
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

test("seeds actual context and maximum output budgets from model discovery", async () => {
  for (const [gptModel, gptLimits, expectedModel] of [
    ["gpt-6-astra", astraLimits, "gpt-6-astra[1m]"],
    ["gpt-5.6-sol[1m]", solLimits, "gpt-5.6-sol"],
  ] as const) {
    await withTemporarySettings(async (configPath) => {
      const input = {
        baseUrl: "http://127.0.0.1:4142",
        configPath,
        gptModel,
        gptLimits,
        maxOutputTokens: 128_000
      }

      await applyClaudeConfig(input)
      const settings = await readSettings(configPath)
      const env = settings.env as Record<string, unknown>

      assert.equal(settings.model, expectedModel)
      assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, String(gptLimits.max_context_window_tokens))
      assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "128000")
      assert.equal(env.DISABLE_COMPACT, undefined)
      assert.equal(env.CLAUDE_CODE_DISABLE_1M_CONTEXT, undefined)

      assert.equal((await applyClaudeConfig(input)).changed, false)
    })
  }
})

test("preserves explicit client context and output overrides", async () => {
  await withTemporarySettings(async (configPath) => {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, JSON.stringify({
      env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "500000", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8192" },
    }))

    await applyClaudeConfig({
      baseUrl: "http://127.0.0.1:4142",
      configPath,
      gptModel: "gpt-6-astra",
      gptLimits: astraLimits,
      maxOutputTokens: 128_000,
    })
    const env = (await readSettings(configPath)).env as Record<string, unknown>

    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "500000")
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "8192")
  })
})

// #162: through the relay, auto mode's server checks did not reach Claude Code, and it showed a
// notice. The writer seeds CLAUDE_CODE_AUTO_MODE_SERVER=0, but only when the key is absent.
test("seeds CLAUDE_CODE_AUTO_MODE_SERVER=0 only when it is absent", async () => {
  const input = (configPath: string) => ({
    baseUrl: "http://127.0.0.1:4142",
    configPath,
    gptModel: "gpt-6-astra",
    gptLimits: astraLimits,
    maxOutputTokens: 128_000,
  })

  await withTemporarySettings(async (configPath) => {
    await applyClaudeConfig(input(configPath))
    const env = (await readSettings(configPath)).env as Record<string, unknown>

    assert.equal(env.CLAUDE_CODE_AUTO_MODE_SERVER, "0")
    assert.equal((await applyClaudeConfig(input(configPath))).changed, false)
  })

  for (const value of ["0", "1"]) {
    await withTemporarySettings(async (configPath) => {
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, JSON.stringify({ env: { CLAUDE_CODE_AUTO_MODE_SERVER: value } }))

      await applyClaudeConfig(input(configPath))
      const env = (await readSettings(configPath)).env as Record<string, unknown>

      assert.equal(env.CLAUDE_CODE_AUTO_MODE_SERVER, value)
    })
  }
})

// Why: a fresh managed Claude Code setup must actually select the configured GPT
// default and expose its 1M client-side context identity without changing the
// canonical model that Copilot receives.
test("creates Claude settings with Astra's 1M identity", async () => {
  await withTemporarySettings(async (configPath) => {
    const result = await applyClaudeConfig({
      baseUrl: "http://127.0.0.1:4142",
      configPath,
      gptModel: "GPT-6-ASTRA[1M][1m]",
    })
    const settings = await readSettings(configPath)
    const env = settings.env as Record<string, unknown>

    assert.deepEqual(result, {
      configPath,
      changed: true,
      created: true,
      previousBaseUrl: undefined,
    })
    assert.equal(settings.model, "gpt-6-astra[1m]")
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

for (const symlinked of [false, true]) {
  test(`atomically publishes ${symlinked ? "symlinked" : "regular"} settings without corrupting open readers`, {
    skip: symlinked && process.platform === "win32",
  }, async () => {
    await withTemporarySettings(async (configPath) => {
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      const target = symlinked ? path.join(path.dirname(configPath), "managed.json") : configPath
      const original = `${JSON.stringify({ theme: "dark", permissions: { allow: ["Read"] } })}\n`
      await fs.writeFile(target, original, { mode: 0o640 })
      if (symlinked) {
        await fs.symlink("managed.json", configPath)
      }

      const input = { baseUrl: "http://relay.test.invalid", configPath, gptModel: "gpt-6-astra" }
      const reader = await fs.open(target, "r")
      try {
        // Windows refuses to rename over the open file, so the first publish
        // must fail cleanly there and succeed once the reader closes.
        if (process.platform === "win32") {
          await assert.rejects(applyClaudeConfig(input), { code: "EPERM", syscall: "rename" })
          assert.equal(await fs.readFile(target, "utf8"), original)
          assert.deepEqual(await fs.readdir(path.dirname(configPath)), ["settings.json"])
        } else {
          assert.equal((await applyClaudeConfig(input)).changed, true)
        }

        assert.equal(
          await reader.readFile("utf8"),
          original,
          "an open reader must never see a truncated/replaced payload"
        )
      } finally {
        await reader.close()
      }

      if (process.platform === "win32") {
        assert.equal((await applyClaudeConfig(input)).changed, true)
      }

      const settings = await readSettings(configPath)

      assert.equal(settings.theme, "dark")
      assert.deepEqual(settings.permissions, { allow: ["Read"] })
      assert.equal((settings.env as Record<string, unknown>).ANTHROPIC_BASE_URL, "http://relay.test.invalid")
      if (symlinked) {
        assert.equal((await fs.lstat(configPath)).isSymbolicLink(), true)
        assert.equal(await fs.readlink(configPath), "managed.json")
        assert.deepEqual(await readSettings(target), settings)
      }

      if (process.platform !== "win32") {
        assert.equal((await fs.stat(target)).mode & 0o777, 0o640)
      }

      assert.deepEqual(
        (await fs.readdir(path.dirname(configPath))).sort(),
        symlinked ? ["managed.json", "settings.json"] : ["settings.json"]
      )
    })
  })
}

test("does not overwrite a concurrent settings edit made after its snapshot read", async (t) => {
  await withTemporarySettings(async (configPath) => {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, '{"theme":"dark"}\n')

    const replacement = '{"theme":"light","concurrent":"keep me"}\n'
    const realRead = fs.readFile.bind(fs)
    const realWrite = fs.writeFile.bind(fs)
    const resolvedPath = await fs.realpath(configPath)
    let edited = false
    t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      const bytes = await realRead(...args)
      if ((args[0] === configPath || args[0] === resolvedPath) && !edited) {
        edited = true
        await realWrite(configPath, replacement)
      }

      return bytes
    })

    await assert.rejects(applyClaudeConfig({
      baseUrl: "http://relay.test.invalid",
      configPath,
      gptModel: "gpt-6-astra",
    }), /changed|conflict/i)
    assert.equal(edited, true, "fixture must actually race the snapshot read")
    assert.equal(await realRead(configPath, "utf8"), replacement)
    assert.deepEqual(await fs.readdir(path.dirname(configPath)), ["settings.json"])
  })
})

test("preserves settings when publication fails and removes its temporary file", async (t) => {
  await withTemporarySettings(async (configPath) => {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    const original = '{"theme":"dark"}\n'
    await fs.writeFile(configPath, original)

    const realRename = fs.rename.bind(fs)
    const resolvedPath = await fs.realpath(configPath)
    const failure = Object.assign(new Error("synthetic rename failure"), { code: "EIO" })
    t.mock.method(fs, "rename", async (source: string, destination: string) => {
      if (destination === configPath || destination === resolvedPath) {
        throw failure
      }

      return realRename(source, destination)
    })

    await assert.rejects(applyClaudeConfig({
      baseUrl: "http://relay.test.invalid",
      configPath,
      gptModel: "gpt-6-astra",
    }), (error) => error === failure)
    assert.equal(await fs.readFile(configPath, "utf8"), original)
    assert.deepEqual(await fs.readdir(path.dirname(configPath)), ["settings.json"])
  })
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

// Why (#159): with an apiKey set, the relay refuses Claude Code's dummy token,
// so managed setup writes the key as ANTHROPIC_AUTH_TOKEN, replacing the dummy
// value or an older key.
test("writes the relay apiKey as Claude Code's auth token", async () => {
  await withTemporarySettings(async (configPath) => {
    const input = {
      baseUrl: "http://127.0.0.1:4142",
      configPath,
      gptModel: "gpt-5.6-sol",
    }

    await applyClaudeConfig(input)
    let env = (await readSettings(configPath)).env as Record<string, unknown>
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "dummy")

    await applyClaudeConfig({ ...input, apiKey: "relay-fixture-key-0001" })
    env = (await readSettings(configPath)).env as Record<string, unknown>
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "relay-fixture-key-0001")

    const rotated = await applyClaudeConfig({ ...input, apiKey: "relay-fixture-key-0002" })
    env = (await readSettings(configPath)).env as Record<string, unknown>
    assert.equal(rotated.changed, true)
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "relay-fixture-key-0002")

    const repeated = await applyClaudeConfig({ ...input, apiKey: "relay-fixture-key-0002" })
    assert.equal(repeated.changed, false)
  })
})

test("leaves an existing auth token unchanged when no apiKey is set", async () => {
  await withTemporarySettings(async (configPath) => {
    await fs.mkdir(path.dirname(configPath), { recursive: true })
    await fs.writeFile(configPath, `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "user-chosen-token" } }, null, 2)}\n`)

    for (const apiKey of [undefined, ""]) {
      await applyClaudeConfig({
        apiKey,
        baseUrl: "http://127.0.0.1:4142",
        configPath,
        gptModel: "gpt-5.6-sol",
      })

      const env = (await readSettings(configPath)).env as Record<string, unknown>
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, "user-chosen-token")
    }
  })
})

// Why (#159 review): the writer kept an existing file's mode, so a 0644 or 0640 settings file that
// gained the relay's apiKey stayed readable by other local users.
for (const mode of [0o644, 0o640]) {
  test(`publishes settings holding the apiKey owner-only over an existing ${mode.toString(8).padStart(4, "0")} file`, {
    skip: process.platform === "win32",
  }, async () => {
    await withTemporarySettings(async (configPath) => {
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "dummy" } }, null, 2)}\n`)
      await fs.chmod(configPath, mode)
      const input = { baseUrl: "http://127.0.0.1:4142", configPath, gptModel: "gpt-5.6-sol" }
      const keyed = { ...input, apiKey: "relay-fixture-key-0001" }
      const token = async () => ((await readSettings(configPath)).env as Record<string, unknown>).ANTHROPIC_AUTH_TOKEN
      const fileMode = async () => (await fs.stat(configPath)).mode & 0o777

      // Without a key, the token and the mode are kept.
      assert.equal((await applyClaudeConfig(input)).changed, true)
      assert.equal(await token(), "dummy")
      assert.equal(await fileMode(), mode)

      assert.equal((await applyClaudeConfig(keyed)).changed, true)
      assert.equal(await token(), "relay-fixture-key-0001")
      assert.equal(await fileMode(), 0o600)

      // A file that already holds the key is published again once its mode is opened back up.
      const current = await fs.readFile(configPath, "utf8")
      await fs.chmod(configPath, mode)

      assert.equal((await applyClaudeConfig(keyed)).changed, true)
      assert.equal(await fs.readFile(configPath, "utf8"), current)
      assert.equal(await fileMode(), 0o600)

      // Private and current: nothing to write.
      assert.equal((await applyClaudeConfig(keyed)).changed, false)
    })
  })
}
