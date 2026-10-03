import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-atomic-"))
process.env.HOME = home
process.env.USERPROFILE = home

const { readFileSnapshot, writeFileSnapshot, FileConflictError, NotRegularFileError } =
  await import("../../src/lib/atomic-file")

test.after(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

const fixture = async (): Promise<string> =>
  path.join(await fs.mkdtemp(path.join(home, "case-")), "settings.json")

// Pin only metadata in the deterministic acquisition tests. Real bytes, reads,
// renames and publication still go through the filesystem. drift receives the
// 1-based count of lstat calls on the target and returns that call's ctime
// offset.
const metadataFixture = async (
  t: import("node:test").TestContext,
  file: string,
  drift: (call: number) => number
) => {
  const realStat = fs.lstat.bind(fs)
  const baseline = await realStat(file)
  const canonical = await fs.realpath(file)

  // Acquisition stats the canonical path, so match both spellings. Windows
  // paths compare case-insensitively.
  const key = (value: unknown) => process.platform === "win32"
    ? path.resolve(String(value)).toLowerCase()
    : path.resolve(String(value))
  const targets = new Set([key(file), key(canonical)])
  let calls = 0
  const tracked = (value: unknown) => targets.has(key(value))
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const stat = await realStat(...args)
    if (tracked(args[0])) {
      stat.ctimeMs = baseline.ctimeMs + drift(++calls)
    }

    return stat
  })

  return { baseline, calls: () => calls, tracked }
}

test("snapshots an absent nested file without creating directories and publishes privately", async () => {
  const file = path.join(await fixture(), "nested", "config.yaml")
  const snapshot = await readFileSnapshot(file)

  assert.equal(snapshot.raw, null)
  assert.equal(snapshot.identity, null)
  await assert.rejects(fs.stat(path.dirname(file)), { code: "ENOENT" })

  // Under a 022 umask, default modes would be 0644 and 0755, so the checks
  // below prove the private modes are set explicitly.
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
  if (results[1].status === "rejected") {
    assert.ok(results[1].reason instanceof FileConflictError)
  }

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

    // atomic-file opens only its temporary file beside the destination.
    // Failing that write after partial bytes land proves cleanup removes them.
    if (
      typeof args[0] === "string"
      && path.dirname(args[0]) === path.dirname(snapshot.resolvedPath)
      && args[0] !== snapshot.resolvedPath
    ) {
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

test("metadata injection follows a canonicalized parent directory", async (t) => {
  const file = await fixture()
  await fs.writeFile(file, "original\n")
  const alias = path.join(path.dirname(file), "alias")
  await fs.symlink(path.dirname(file), alias, process.platform === "win32" ? "junction" : "dir")
  t.after(() => fs.unlink(alias))

  // Through the alias, the requested path differs from the canonical path
  // that acquisition stats; the injected drift must still reach that lstat.
  const requested = path.join(alias, "settings.json")
  const metadata = await metadataFixture(t, requested, (call) => call === 2 ? 1 : 0)
  const snapshot = await readFileSnapshot(requested)

  assert.equal(snapshot.raw, "original\n")
  assert.equal(snapshot.resolvedPath, await fs.realpath(file))
  assert.equal(metadata.calls(), 4, "canonical lstat path must receive the injected conflict")
})

test("reacquires a snapshot after one inconsistent metadata read", async (t) => {
  const file = await fixture()
  await fs.writeFile(file, "original\n")
  const metadata = await metadataFixture(t, file, (call) => call === 2 ? 1 : 0)
  const snapshot = await readFileSnapshot(file)

  assert.equal(snapshot.raw, "original\n")
  assert.equal(snapshot.identity?.ctimeMs, metadata.baseline.ctimeMs)
  assert.equal(metadata.calls(), 4)
})

test("persistent snapshot drift fails after three whole acquisition attempts", async (t) => {
  const file = await fixture()
  await fs.writeFile(file, "original\n")
  const metadata = await metadataFixture(t, file, (call) => call)
  const realRead = fs.readFile.bind(fs)
  let reads = 0
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (metadata.tracked(args[0])) {
      reads++
    }

    return realRead(...args)
  })

  await assert.rejects(readFileSnapshot(file), (error) => {
    assert.ok(error instanceof FileConflictError)
    assert.equal(error.constructor, FileConflictError)
    assert.equal("snapshot" in error, false, "file bytes must not escape in a loggable error")
    return true
  })

  assert.equal(reads, 3)
  assert.equal(metadata.calls(), 6)
})

test("snapshot permission errors propagate without acquisition retries", async (t) => {
  const file = await fixture()
  await fs.writeFile(file, "original\n")
  const realRead = fs.readFile.bind(fs)
  const failure = Object.assign(new Error("synthetic permission denied"), { code: "EACCES" })
  let reads = 0
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (path.basename(String(args[0])) === "settings.json") {
      reads++
      throw failure
    }

    return realRead(...args)
  })

  await assert.rejects(readFileSnapshot(file), (error) => error === failure)
  assert.equal(reads, 1)
})

test("a non-regular target fails bounded acquisition without reading it", async (t) => {
  const file = await fixture()
  await fs.mkdir(file)

  const realStat = fs.lstat.bind(fs)
  let stats = 0
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    stats++
    return realStat(...args)
  })
  const read = t.mock.method(fs, "readFile", async () => {
    assert.fail("must not read a non-regular file")
  })

  await assert.rejects(readFileSnapshot(file), NotRegularFileError)
  assert.equal(stats, 1)
  assert.equal(read.mock.callCount(), 0)
})

for (const stableChange of [false, true]) {
  test(`publication reacquisition never authorizes a changed original, stableChange=${stableChange}`, async (t) => {
    const file = await fixture()
    await fs.writeFile(file, "original\n")

    // The snapshot sees steady metadata. After it, a stable change shifts
    // every lstat, while a transient one shifts only the fourth call.
    let changed = false
    const metadata = await metadataFixture(t, file, (call) => {
      if (!changed) {
        return 0
      }

      if (stableChange) {
        return 1
      }

      return call === 4 ? 1 : 0
    })
    const snapshot = await readFileSnapshot(file)
    changed = true

    if (stableChange) {
      await assert.rejects(writeFileSnapshot(snapshot, "replacement\n"), FileConflictError)
      assert.equal(metadata.calls(), 4, "stable new identity must reject at comparison, not exhaust retries")
      assert.equal(await fs.readFile(file, "utf8"), "original\n")
    } else {
      await writeFileSnapshot(snapshot, "replacement\n")
      assert.equal(await fs.readFile(file, "utf8"), "replacement\n")
    }

    assert.deepEqual(await fs.readdir(path.dirname(file)), ["settings.json"])
  })
}

for (const duringPublish of [false, true]) {
  test(`deletion during a read rejects immediately: publish=${duringPublish}`, async (t) => {
    const file = await fixture()
    await fs.writeFile(file, "original\n")
    await metadataFixture(t, file, () => 0)
    const snapshot = duringPublish ? await readFileSnapshot(file) : undefined

    const realRead = fs.readFile.bind(fs)
    let removed = false
    t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
      if (!removed && path.basename(String(args[0])) === "settings.json") {
        removed = true
        await fs.unlink(file)
      }

      return realRead(...args)
    })

    if (snapshot) {
      await assert.rejects(writeFileSnapshot(snapshot, "stale\n"), FileConflictError)
      await assert.rejects(fs.stat(file), { code: "ENOENT" })
    } else {
      await assert.rejects(readFileSnapshot(file), FileConflictError)
    }

    assert.deepEqual(await fs.readdir(path.dirname(file)), [])
  })
}

test("replacement during an initial read still rejects", async (t) => {
  const file = await fixture()
  await fs.writeFile(file, "original\n")
  const replacement = `${file}.replacement`
  await fs.writeFile(replacement, "new\n")

  const realRead = fs.readFile.bind(fs)
  let replaced = false
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (!replaced && path.basename(String(args[0])) === "settings.json") {
      replaced = true
      await fs.rename(replacement, file)
    }

    return realRead(...args)
  })

  await assert.rejects(readFileSnapshot(file), FileConflictError)
  assert.equal(await realRead(file, "utf8"), "new\n")
})

test("ctime-only reacquisition cannot accept different bytes with matching metadata", async (t) => {
  const file = await fixture()
  await fs.writeFile(file, "original\n")
  // Drift on the second lstat forces a second attempt, whose read returns
  // different bytes. Only ctime may settle between attempts, so this rejects.
  await metadataFixture(t, file, (call) => call === 2 ? 1 : 0)
  const realRead = fs.readFile.bind(fs)
  let reads = 0
  t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    if (path.basename(String(args[0])) === "settings.json" && ++reads > 1) {
      return "modified\n"
    }

    return realRead(...args)
  })

  await assert.rejects(readFileSnapshot(file), FileConflictError)
  assert.equal(reads, 2)
  assert.equal(await realRead(file, "utf8"), "original\n")
})
