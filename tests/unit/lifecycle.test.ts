import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// lifecycle imports the logger and paths; never resolve either against the real home.
const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-relay-lifecycle-"))
process.env.HOME = tempHome
process.env.USERPROFILE = tempHome

const { isRelayStartProcess } = await import("../../src/lib/lifecycle")

test.after(async () => {
  await fs.rm(tempHome, { recursive: true, force: true })
})

test("recognizes installed copilot-relay start processes", () => {
  assert.equal(
    isRelayStartProcess(
      "node /usr/local/lib/node_modules/copilot-relay/dist/main.js start",
    ),
    true,
  )
  assert.equal(isRelayStartProcess("copilot-relay start"), true)
})

test("recognizes local dist start only from relay working directories", () => {
  assert.equal(
    isRelayStartProcess(
      "node dist/main.js start",
      "/private/tmp/copilot-relay-check",
    ),
    true,
  )
  assert.equal(
    isRelayStartProcess("node dist/main.js start", "/tmp/other-project"),
    false,
  )
})

// restart starts the replacement relay in the same foreground process.
for (const subcommand of ["start", "restart"]) {
  for (const [name, command, cwd] of [
    ["installed executable", `copilot-relay ${subcommand}`, undefined],
    ["installed Node bundle", `node /usr/local/lib/node_modules/copilot-relay/dist/main.js ${subcommand}`, undefined],
    ["POSIX checkout bundle", `node dist/main.js ${subcommand}`, "/workspace/copilot-relay-check"],
    ["POSIX checkout source", `node --import tsx src/main.ts ${subcommand}`, "/workspace/copilot-relay"],
    ["absolute checkout source", `node /workspace/copilot-relay/src/main.ts ${subcommand}`, undefined],
    ["quoted Windows Node and package paths", `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Relay User\\AppData\\Roaming\\npm\\node_modules\\copilot-relay\\dist\\main.js" ${subcommand}`, undefined],
    ["quoted POSIX checkout", `"/opt/Node Runtime/bin/node" "/workspace/My Projects/copilot-relay/dist/main.js" ${subcommand}`, undefined],
  ] as const) {
    test(`recognizes ${subcommand} from ${name}`, () => {
      assert.equal(isRelayStartProcess(command, cwd), true)
    })
  }
}

for (const command of [
  "copilot-relay stop",
  "copilot-relay status --note start",
  "copilot-relay auth start",
  "node /usr/local/lib/node_modules/copilot-relay/dist/main.js auth",
  "grep -n start /fixture/.copilot-relay/logs/example.log",
  "vim /workspace/copilot-relay/src/start.ts start",
  '"C:\\Program Files\\Editor\\editor.exe" "C:\\work\\copilot-relay\\dist\\main.js" start',
  "node /tmp/inspect.js copilot-relay start",
  'node --eval "copilot-relay start"',
  "node /tmp/not-copilot-relay/dist/main.js start",
  "node /tmp/other-project/dist/main.js start",
  "grep -n start /workspace/Space Folder/copilot-relay/dist/main.js",
  "vim /workspace/Space Folder/copilot-relay/dist/main.js start",
  "node /tmp/inspect.js /workspace/Space Folder/copilot-relay/dist/main.js start",
  "node /tmp/inspect.js start /workspace/Space Folder/copilot-relay/dist/main.js restart",
  "node /workspace/Space Folder/copilot-relay/dist/main.js auth start",
  "node --eval /workspace/Space Folder/copilot-relay/dist/main.js start",
  "node /usr/local/bin/worker ./workspace/copilot-relay/dist/main.js start",
  "node /usr/local/bin/worker workspace/copilot-relay/dist/main.js start",
  "node worker workspace/copilot-relay/dist/main.js start",
  "node /workspace/Space Folder/copilot-relay/dist/main.js start",
  "/usr/bin/node --import tsx /workspace/Space Folder/copilot-relay/src/main.ts restart",
  "/opt/Node Runtime/bin/node /workspace/copilot-relay/dist/main.js start",
]) {
  test(`rejects a command that is not a relay daemon: ${command}`, () => {
    assert.equal(isRelayStartProcess(command, "/workspace/copilot-relay"), false)
  })
}
