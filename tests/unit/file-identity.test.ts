import assert from "node:assert/strict"
import test from "node:test"

import { sameFile, sameOpenedFile } from "../../src/lib/file-identity"

test("sameFile requires the same dev and ino", () => {
  assert.equal(sameFile({ dev: 7, ino: 42 }, { dev: 7, ino: 42 }), true)
  assert.equal(sameFile({ dev: 0, ino: 42 }, { dev: 7, ino: 42 }), false)
  assert.equal(sameFile({ dev: 7, ino: 42 }, { dev: 7, ino: 43 }), false)
})

test("sameOpenedFile compares dev and ino off Windows", () => {
  assert.equal(sameOpenedFile({ dev: 7, ino: 42 }, { dev: 7, ino: 42 }, "linux"), true)
  assert.equal(sameOpenedFile({ dev: 0, ino: 42 }, { dev: 7, ino: 42 }, "darwin"), false)
  assert.equal(sameOpenedFile({ dev: 7, ino: 42 }, { dev: 7, ino: 43 }, "linux"), false)
})

test("sameOpenedFile on Windows treats a dev of 0 as unreported but still compares two nonzero devs", () => {
  assert.equal(sameOpenedFile({ dev: 0, ino: 42 }, { dev: 3356741918, ino: 42 }, "win32"), true)
  assert.equal(sameOpenedFile({ dev: 3356741918, ino: 42 }, { dev: 0, ino: 42 }, "win32"), true)
  assert.equal(sameOpenedFile({ dev: 3356741918, ino: 42 }, { dev: 4000000000, ino: 42 }, "win32"), false)
  assert.equal(sameOpenedFile({ dev: 0, ino: 42 }, { dev: 3356741918, ino: 43 }, "win32"), false)
})
