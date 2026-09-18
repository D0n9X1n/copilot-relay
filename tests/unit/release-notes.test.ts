import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify, stripVTControlCharacters } from "node:util"
import { fileURLToPath } from "node:url"

const execute = promisify(execFile)
const root = fileURLToPath(new URL("../../", import.meta.url))
const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3")

const runSuite = async (executable: string, suite: string) => {
  try {
    return await execute(executable, [path.join(root, "scripts", suite)], {
      cwd: root,
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    })
  } catch (error) {
    const failure = error as Error & { code?: string | number; stdout?: string; stderr?: string }
    throw new Error(`Release-note test ${suite} failed (${executable}, ${failure.code ?? "unknown"}): ${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`)
  }
}

for (const suite of ["release-issues_tests.py", "release-notes_tests.py"]) {
  test(`offline release notes: ${suite}`, { timeout: 190_000 }, async () => {
    const { stderr } = await runSuite(python, suite)
    const output = stripVTControlCharacters(stderr)
    assert.match(output, /Ran \d+ tests/)
    assert.match(output, /^OK(?: \(.*\))?$/m)
  })
}

test("release-note tests fail loudly when Python is missing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-missing-python-"))
  try {
    await assert.rejects(runSuite(path.join(home, "nonexistent-python"), "release-notes_tests.py"), /ENOENT/)
  } finally {
    await fs.rm(home, { recursive: true, force: true })
  }
})

test("release workflow generates verified notes with Python provisioned", async () => {
  const publish = await fs.readFile(path.join(root, ".github/workflows/publish.yml"), "utf8")
  const ci = await fs.readFile(path.join(root, ".github/workflows/ci.yml"), "utf8")
  assert.match(publish, /python3 scripts\/release-notes\.py "\$tag" release > "\$notes_file"/)
  assert.match(publish, /issues: read/)
  assert.match(publish, /pull-requests: read/)
  assert.match(publish, /fetch-depth: 0/)
  assert.equal((publish.match(/actions\/setup-python@/g) ?? []).length, 2)
  assert.match(ci, /actions\/setup-python@/)
  assert.doesNotMatch(publish, /commit_messages=|Automated release for/)
})
