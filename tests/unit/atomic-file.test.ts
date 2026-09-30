import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-atomic-"))
process.env.HOME = home
process.env.USERPROFILE = home
const { readFileSnapshot, writeFileSnapshot, FileConflictError } =
  await import("../../src/lib/atomic-file")

test.after(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

const fixture = async (): Promise<string> =>
  path.join(await fs.mkdtemp(path.join(home, "case-")), "settings.json")

test("snapshots an absent nested file without creating directories and publishes privately", async () => {
  const file = path.join(await fixture(), "nested", "config.yaml")
  const snapshot = await readFileSnapshot(file)
  assert.equal(snapshot.raw, null)
  assert.equal(snapshot.identity, null)
  await assert.rejects(fs.stat(path.dirname(file)), { code: "ENOENT" })

  const previousUmask = process.umask(0o022)
  try {
    await writeFileSnapshot(snapshot, "port: 5555\n")
    assert.equal(await fs.readFile(file, "utf8"), "port: 5555\n")
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
      assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700)
    }
    assert.deepEqual(await fs.readdir(path.dirname(file)), ["config.yaml"])
  } finally {
    process.umask(previousUmask)
  }
})

test("rejects stale snapshots even when the replacement has identical bytes", async () => {
  const file = await fixture()
  await fs.writeFile(file, "original\n")
  const snapshot = await readFileSnapshot(file)
  const replacement = `${file}.replacement`
  await fs.writeFile(replacement, snapshot.raw!)
  await fs.rename(replacement, file)

  await assert.rejects(writeFileSnapshot(snapshot, "stale write\n"), FileConflictError)
  assert.equal(await fs.readFile(file, "utf8"), "original\n")
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["settings.json"])
})

test("rejects a destination created after an absent-file snapshot", async () => {
  const file = await fixture()
  const snapshot = await readFileSnapshot(file)
  await fs.writeFile(file, "concurrent creation\n")

  await assert.rejects(writeFileSnapshot(snapshot, "stale creation\n"), FileConflictError)
  assert.equal(await fs.readFile(file, "utf8"), "concurrent creation\n")
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["settings.json"])
})

test("exclusive publication cannot clobber creation after the final absence check", async (t) => {
  const file = await fixture()
  const snapshot = await readFileSnapshot(file)
  const realLink = fs.link.bind(fs)
  let raced = false
  t.mock.method(fs, "link", async (source: string, destination: string) => {
    if (destination === snapshot.resolvedPath) {
      raced = true
      await fs.writeFile(destination, "late creation\n", { flag: "wx" })
    }
    return realLink(source, destination)
  })

  await assert.rejects(writeFileSnapshot(snapshot, "must not win\n"), FileConflictError)
  assert.equal(raced, true, "fixture must race actual exclusive publication")
  assert.equal(await fs.readFile(file, "utf8"), "late creation\n")
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["settings.json"])
})

test("serializes cooperative writes and rejects the second stale snapshot", async () => {
  const file = await fixture()
  await fs.writeFile(file, "original\n")
  const first = await readFileSnapshot(file)
  const second = await readFileSnapshot(file)

  const results = await Promise.allSettled([
    writeFileSnapshot(first, "first write\n"),
    writeFileSnapshot(second, "second write\n"),
  ])
  assert.equal(results[0].status, "fulfilled")
  assert.equal(results[1].status, "rejected")
  if (results[1].status === "rejected") assert.ok(results[1].reason instanceof FileConflictError)
  assert.equal(await fs.readFile(file, "utf8"), "first write\n")
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["settings.json"])
})

test("rejects a symlink retargeted after snapshot without editing either target", {
  skip: process.platform === "win32",
}, async () => {
  const file = await fixture()
  const original = path.join(path.dirname(file), "original.json")
  const replacement = path.join(path.dirname(file), "replacement.json")
  await fs.writeFile(original, "original\n")
  await fs.writeFile(replacement, "replacement\n")
  await fs.symlink("original.json", file)
  const snapshot = await readFileSnapshot(file)
  await fs.unlink(file)
  await fs.symlink("replacement.json", file)

  await assert.rejects(writeFileSnapshot(snapshot, "must not land\n"), FileConflictError)
  assert.equal(await fs.readFile(original, "utf8"), "original\n")
  assert.equal(await fs.readFile(replacement, "utf8"), "replacement\n")
  assert.equal(await fs.readlink(file), "replacement.json")
})

test("failed temporary writes leave the original intact and remove partial bytes", async (t) => {
  const file = await fixture()
  await fs.writeFile(file, "original\n")
  const snapshot = await readFileSnapshot(file)
  const realOpen = fs.open.bind(fs)
  const failure = new Error("synthetic partial write failure")
  let injected = false
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args)
    if (typeof args[0] === "string" && path.dirname(args[0]) === path.dirname(snapshot.resolvedPath)
      && args[0] !== snapshot.resolvedPath) {
      assert.equal(args[1], "wx")
      assert.equal(args[2], 0o600)
      const write = handle.writeFile.bind(handle)
      t.mock.method(handle, "writeFile", async () => {
        injected = true
        await write("partial bytes")
        throw failure
      })
    }
    return handle
  })

  await assert.rejects(writeFileSnapshot(snapshot, "replacement\n"), (error) => error === failure)
  assert.equal(injected, true)
  assert.equal(await fs.readFile(file, "utf8"), "original\n")
  assert.deepEqual(await fs.readdir(path.dirname(file)), ["settings.json"])
})
