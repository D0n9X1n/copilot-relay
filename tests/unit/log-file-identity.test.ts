import assert from "node:assert/strict"
import type { PathLike } from "node:fs"
import fs from "node:fs/promises"
import test from "node:test"

import { readLogs } from "../fixtures/logs"

const { log, flushLogs } = await import("../../src/lib/log")

const lstat = fs.lstat

// On Windows, Node 22.13.1 reports dev 0 for a path stat and the volume serial number for a stat of
// the open handle, for the same file. This makes every path stat look like that, whatever Node runs
// the test.
test("a log entry reaches the file when path stats report dev 0 on Windows", { skip: process.platform !== "win32" }, async (t) => {
  t.mock.method(fs, "lstat", async (target: PathLike) => {
    const stat = await lstat(target)
    stat.dev = 0
    return stat
  })

  log.info("path-stat-dev-zero-marker")
  await flushLogs()

  assert.match(await readLogs(), /path-stat-dev-zero-marker/)
})
