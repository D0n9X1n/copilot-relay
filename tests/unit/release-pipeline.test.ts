import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const root = fileURLToPath(new URL("../../", import.meta.url))
const bootstrap = pathToFileURL(path.join(root, "scripts/test-bootstrap.mjs")).href
const tsx = pathToFileURL(path.join(root, "node_modules/tsx/dist/loader.mjs")).href

// Run the actual preload before a static source import, including a simulated
// inherited home. Never use the developer's home even while this test is RED.
test("test preload isolates static imports per child and cleans only owned temporary files", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "relay-bootstrap-guard-"))
  const inheritedHome = path.join(fixture, "inherited-home")
  await fs.mkdir(inheritedHome)
  await fs.writeFile(path.join(inheritedHome, "keep"), "not owned by the bootstrap")
  const probe = path.join(fixture, "probe.mts")
  await fs.writeFile(probe, `
    import fs from "node:fs/promises"
    import os from "node:os"
    import path from "node:path"
    import { paths } from ${JSON.stringify(new URL("../../src/lib/paths.ts", import.meta.url).href)}
    import { log } from ${JSON.stringify(new URL("../../src/lib/log.ts", import.meta.url).href)}
    const suiteHome = await fs.mkdtemp(path.join(os.tmpdir(), "suite-home-"))
    const result = {
      home: process.env.HOME, userprofile: process.env.USERPROFILE,
      appDir: paths.appDir, level: String(log.level),
      temporary: os.tmpdir(), suiteHome,
      diskCaches: (await fs.readdir(os.tmpdir())).filter(name => /^tsx(?:-|$)/.test(name)),
    }
    // A suite can still select its own home. Cleanup must not follow env.HOME.
    process.env.HOME = process.env.INHERITED_HOME
    process.env.USERPROFILE = process.env.INHERITED_HOME
    console.log(JSON.stringify(result))
  `)

  try {
    // Each child inherits a home, a verbose logger and tsx disk caching that the
    // bootstrap must override.
    const run = () => execute(process.execPath, ["--import", bootstrap, "--import", tsx, probe], {
      cwd: root,
      env: {
        ...process.env, HOME: inheritedHome, USERPROFILE: inheritedHome,
        INHERITED_HOME: inheritedHome, CONSOLA_LEVEL: "5", TSX_DISABLE_CACHE: "",
      },
    })

    const results = await Promise.all([run(), run()])
    const homes = new Set<string>()
    for (const { stdout } of results) {
      const result = JSON.parse(stdout) as {
        home: string; userprofile: string; appDir: string; level: string
        temporary: string; suiteHome: string; diskCaches: string[]
      }
      assert.notEqual(result.home, inheritedHome)
      assert.equal(result.userprofile, result.home, "Windows must use the isolated home too")
      assert.equal(result.appDir, path.join(result.home, ".copilot-relay"))
      assert.equal(result.level, "0")
      assert.deepEqual(result.diskCaches, [], "tsx must not leave asynchronous disk-cache writes racing exit cleanup")
      assert.equal(path.dirname(result.temporary), path.dirname(result.home))
      homes.add(result.home)

      for (const owned of [result.home, result.temporary, result.suiteHome]) {
        await assert.rejects(fs.access(owned), { code: "ENOENT" })
      }
    }

    assert.equal(homes.size, 2, "each test process owns a distinct home")
    assert.equal(await fs.readFile(path.join(inheritedHome, "keep"), "utf8"), "not owned by the bootstrap")
  } finally {
    await fs.rm(fixture, { recursive: true, force: true })
  }
})

test("bootstrap silences its logger without silencing a spawned CLI help command", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "relay-help-guard-"))
  const probe = path.join(fixture, "help.mjs")
  await fs.writeFile(probe, `
    import { execFileSync } from "node:child_process"
    const output = execFileSync(process.execPath, ["--import", ${JSON.stringify(tsx)}, ${JSON.stringify(path.join(root, "src/main.ts"))}, "--help"], { encoding: "utf8", env: { ...process.env, CI: "true" } })
    process.stdout.write(output)
  `)

  try {
    // Without an inherited level, a silent --help can only mean the bootstrap leaked its own.
    const env = { ...process.env }
    delete env.CONSOLA_LEVEL
    const { stdout } = await execute(process.execPath, ["--import", bootstrap, probe], { cwd: root, env })

    assert.match(stdout, /USAGE/)
    assert.match(stdout, /copilot-relay/)
  } finally {
    await fs.rm(fixture, { recursive: true, force: true })
  }
})

for (const suite of ["chat-completions", "auth-recovery", "model-limits", "web-search", "url-leak-evidence"]) {
  test(`${suite} teardown drains delayed log writes before removing its home`, async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "relay-log-teardown-"))
    const guard = path.join(fixture, "guard.mjs")
    await fs.writeFile(guard, `
      import assert from "node:assert/strict";
      import fs from "node:fs/promises";
      import os from "node:os";
      import path from "node:path";
      import test from "node:test";
      const after = test.after;
      test.after = (hook, ...options) => after(async (...args) => {
        const { log, flushLogs } = await import(${JSON.stringify(new URL("../../src/lib/log.ts", import.meta.url).href)});
        const { paths, getLogPath } = await import(${JSON.stringify(new URL("../../src/lib/paths.ts", import.meta.url).href)});
        await flushLogs();
        const home = os.homedir();
        const mkdir = fs.mkdir, open = fs.open, rm = fs.rm;
        let release, entered, closed = false;
        const waiting = new Promise(resolve => { entered = resolve });
        const gate = new Promise(resolve => { release = resolve });
        fs.mkdir = async (...args) => {
          if (args[0] === paths.logsDir) { entered(); await gate }
          return mkdir(...args);
        };
        fs.open = async (...args) => {
          const handle = await open(...args);
          if (args[0] === getLogPath()) {
            const close = handle.close.bind(handle);
            handle.close = async () => { await close(); closed = true };
          }
          return handle;
        };
        fs.rm = async (target, ...args) => {
          if (path.resolve(String(target)) === path.resolve(home)) {
            assert.equal(closed, true, "LOG_WRITE_PENDING_AT_HOME_REMOVAL");
          }
          return rm(target, ...args);
        };
        try {
          log.info("Teardown log-drain fixture");
          await waiting;
          setImmediate(release);
          await hook(...args);
          assert.equal(closed, true);
          await assert.rejects(fs.access(home), { code: "ENOENT" });
          console.log("LOG_TEARDOWN_DRAIN_VERIFIED");
        } finally {
          release();
          await flushLogs();
          fs.mkdir = mkdir; fs.open = open; fs.rm = rm;
        }
      }, ...options);
    `)

    try {
      // Run the suite as a top-level test run, not as a child of this one. The
      // name pattern matches no test, so only the suite's setup and teardown run.
      const env = { ...process.env }
      delete env.NODE_TEST_CONTEXT
      const { stdout } = await execute(process.execPath, [
        "--import", bootstrap, "--import", tsx, "--import", pathToFileURL(guard).href,
        "--test", "--test-name-pattern=^__teardown_order_only__$", path.join(root, "tests/unit", `${suite}.test.ts`),
      ], { cwd: root, env, timeout: 20_000, maxBuffer: 1024 * 1024 })

      assert.match(stdout, /LOG_TEARDOWN_DRAIN_VERIFIED/)
    } finally {
      await fs.rm(fixture, { recursive: true, force: true })
    }
  })
}

test("dependency lock pins the manifest and all platform-specific build dependencies", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))
  const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"))

  assert.equal(lock.lockfileVersion, 3)
  assert.equal(lock.version, manifest.version)
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies)
  assert.deepEqual(lock.packages[""].devDependencies, manifest.devDependencies)

  for (const [location, value] of Object.entries(lock.packages)) {
    if (!location) {
      continue
    }

    const entry = value as { version: string; resolved: string; integrity: string; optionalDependencies?: Record<string, string> }
    assert.match(entry.version, /^\d+\./)
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//, location)
    assert.match(entry.integrity, /^sha512-/, location)
    for (const dependency of Object.keys(entry.optionalDependencies ?? {})) {
      assert.ok(lock.packages[`node_modules/${dependency}`], `missing ${dependency} for other CI platforms`)
    }
  }
})

// These are dependency assertions over the actual workflow, not a mock runner.
const workflowJobs = (yaml: string): Record<string, string> => Object.fromEntries(
  [...yaml.matchAll(/^  ([a-z][a-z0-9-]*):\r?\n([\s\S]*?)(?=^  [a-z][a-z0-9-]*:\r?\n|$(?![\s\S]))/gm)]
    .filter((match) => match.index! > yaml.indexOf("\njobs:"))
    .map((match) => [match[1], match[2]]),
)

test("release graph validates tags then gates immutable publishers on every platform and Node", async () => {
  const publish = await fs.readFile(path.join(root, ".github/workflows/publish.yml"), "utf8")
  const ci = await fs.readFile(path.join(root, ".github/workflows/ci.yml"), "utf8")
  const jobs = workflowJobs(publish)

  assert.ok(jobs.validate, "tag validation must be a separate prerequisite")
  assert.match(jobs.validate, /refs\/tags\//)
  assert.match(jobs.validate, /manifest\.version/)

  assert.match(jobs.candidates, /needs: validate/)
  assert.match(jobs.candidates, /npm ci/)
  assert.equal((jobs.candidates.match(/npm run build/g) ?? []).length, 1)
  assert.equal((jobs.candidates.match(/npm pack --ignore-scripts/g) ?? []).length, 2)
  assert.match(jobs.candidates, /actions\/upload-artifact@v4/)
  assert.match(jobs.candidates, /SHA256SUMS/)

  assert.match(jobs.test, /needs: \[validate, candidates\]/)
  for (const workflow of [jobs.test, ci]) {
    assert.match(workflow, /node-version: \[22, 26\]/)
    assert.match(workflow, /os: \[ubuntu-latest, macos-latest, windows-latest\]/)
    assert.match(workflow, /npm ci/)
    for (const gate of ["typecheck", "test:unit", "test:integration", "build"]) {
      assert.ok(workflow.includes(`npm run ${gate}`), gate)
    }
  }

  assert.match(jobs.test, /actions\/download-artifact@v4/)
  assert.equal((jobs.test.match(/node scripts\/package-smoke\.mjs candidates\//g) ?? []).length, 2)
  assert.ok(jobs.test.indexOf("npm run build") < jobs.test.indexOf("node scripts/package-smoke.mjs"))
  for (const id of ["publish-npm", "publish-github", "github-release"]) {
    assert.match(jobs[id], /needs: \[validate, candidates, test\]/, id)
    assert.match(jobs[id], /actions\/download-artifact@v4/, id)
    assert.match(jobs[id], /package-smoke\.mjs --verify/, id)
    assert.doesNotMatch(jobs[id], /npm (?:pack|run build|ci)|--clobber/, id)
  }

  for (const id of ["publish-npm", "publish-github"]) {
    assert.match(jobs[id], /dist\.integrity/)
    assert.match(jobs[id], /npm publish "\$tarball" --ignore-scripts/)
    assert.match(jobs[id], /E404/)
    assert.match(jobs[id], /sha512/)
  }

  assert.match(jobs["github-release"], /gh release download/)
  assert.match(jobs["github-release"], /cmp --/)
  assert.match(publish, /concurrency:\r?\n  group:.*(?:inputs\.tag|github\.ref_name)/)
  assert.match(publish, /cancel-in-progress: false/)
  assert.doesNotMatch(publish + ci, /npm install --no-audit/)
})

type OfflineOperation = { sentinel: string; program: string; args: string[]; bytes?: string }
type OfflineScenario = {
  tag?: string; version?: string; packageName?: string; lockVersion?: string; lockRootVersion?: string
  head?: string; registry?: "matching" | "different" | "missing" | "unavailable"
  release?: "matching" | "different" | "missing-tarball" | "missing-checksum" | "partial-different" | "missing" | "unavailable"
}

const fixtureVersion = "1.2.3"
const fixtureCommit = "a".repeat(40)
const fixtureTarball = `copilot-relay-${fixtureVersion}.tgz`
const fixtureBytes = Buffer.from("offline packed candidate bytes\n")
const fixtureChecksum = `${createHash("sha256").update(fixtureBytes).digest("hex")}  ${fixtureTarball}\n`
const publishWorkflow = path.join(root, ".github/workflows/publish.yml")

// Extract, do not reimplement, the shell that Actions executes. Each selected
// job has one literal block; fail loudly if that contract changes.
const workflowRunBlock = (yaml: string, job: string): string => {
  const section = workflowJobs(yaml)[job]
  assert.ok(section, `missing workflow job ${job}`)
  const lines = section.split(/\r?\n/)
  const starts = lines.flatMap((line, index) => line === "        run: |" ? [index] : [])
  assert.equal(starts.length, 1, `expected one shell block in ${job}`)

  // The literal block ends at the first non-empty line indented less than its body.
  const block: string[] = []
  for (const line of lines.slice(starts[0] + 1)) {
    if (line && !line.startsWith("          ")) {
      break
    }

    block.push(line.slice(10))
  }

  assert.ok(block.length)
  return `${block.join("\n").trimEnd()}\n`
}

test("release workflow extraction preserves the same jobs and shell blocks with LF or CRLF", async () => {
  const lf = (await fs.readFile(publishWorkflow, "utf8")).replace(/\r\n/g, "\n")
  const crlf = lf.replace(/\n/g, "\r\n")

  const jobs = workflowJobs(lf)
  assert.deepEqual(Object.keys(jobs), ["validate", "candidates", "test", "publish-npm", "publish-github", "github-release"])
  assert.deepEqual(Object.fromEntries(Object.entries(workflowJobs(crlf))
    .map(([name, body]) => [name, body.replace(/\r\n/g, "\n")])), jobs)
  for (const name of ["validate", "candidates", "publish-npm", "publish-github", "github-release"]) {
    assert.equal(workflowRunBlock(crlf, name), workflowRunBlock(lf, name))
  }
})

// The only executable CLIs on PATH are these fakes and wrappers around a small
// set of local shell utilities. Windows deliberately uses Git Bash, not WSL or
// cmd.exe. Forward-slash drive paths work in both Git Bash and native Node.
const bashPath = (value: string): string => value.replace(/\\/g, "/")
const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
const offlineWorkflow = async (job: string, scenario: OfflineScenario = {}, mutation?: (yaml: string) => string) => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "relay offline workflow "))
  try {
    const home = path.join(work, "home")
    const bin = path.join(work, "mock-bin")
    const temporary = path.join(work, "tmp")
    for (const directory of [home, bin, temporary, path.join(work, "candidates/npm"), path.join(work, "candidates/github")]) {
      await fs.mkdir(directory, { recursive: true })
    }

    const bashCandidates = process.platform === "win32" ? [
      path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git/bin/bash.exe"),
      path.join(process.env.ProgramW6432 ?? "C:\\Program Files", "Git/bin/bash.exe"),
    ] : ["/bin/bash", "/usr/bin/bash"]
    let bash: string | undefined
    for (const candidate of bashCandidates) {
      if (await fs.access(candidate).then(() => true, () => false)) {
        bash = candidate
        break
      }
    }

    assert.ok(bash, "Git Bash (Windows) or bash is required; publishing behavior is never skipped")

    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(?:SystemRoot|WINDIR|ComSpec|PATHEXT)$/i.test(key)) {
        env[key] = value
      }
    }

    Object.assign(env, {
      HOME: home, USERPROFILE: home, TMPDIR: bashPath(temporary), TMP: temporary, TEMP: temporary,
      CONSOLA_LEVEL: "0", BASH_ENV: "", ENV: "", LANG: "C", LC_ALL: "C",
    })

    const utilityNames = ["mkdir", "cp", "mktemp", "rm", "basename", "cmp", "grep", "jq"]
    const inheritedPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === "path")?.[1]
    const { stdout: discovered } = await execute(bash, ["--noprofile", "--norc", "-c",
      `export PATH="/usr/bin:/bin:$PATH"; for utility in ${utilityNames.join(" ")}; do type -P "$utility" || exit 1; done`,
    ], { cwd: work, env: { ...env, PATH: inheritedPath }, timeout: 10_000 })
    const utilities = discovered.trim().split(/\r?\n/)
    assert.equal(utilities.length, utilityNames.length)
    for (const [index, name] of utilityNames.entries()) {
      await fs.writeFile(path.join(bin, name), `#!/bin/bash\nexec ${shellQuote(utilities[index])} "$@"\n`, { mode: 0o700 })
    }

    const version = scenario.version ?? fixtureVersion
    const tag = scenario.tag ?? `v${version}`
    const archive = fixtureBytes.toString("base64")
    const checksum = Buffer.from(fixtureChecksum).toString("base64")
    const assets: Record<string, string> = { [fixtureTarball]: archive, SHA256SUMS: checksum }

    if (["different", "partial-different"].includes(scenario.release ?? "")) {
      assets[fixtureTarball] = Buffer.from("different immutable bytes").toString("base64")
    }

    if (scenario.release === "missing-tarball") {
      delete assets[fixtureTarball]
    }

    if (["missing-checksum", "partial-different"].includes(scenario.release ?? "")) {
      delete assets.SHA256SUMS
    }

    if (scenario.release === "missing") {
      delete assets[fixtureTarball]
      delete assets.SHA256SUMS
    }

    const state = {
      sentinel: path.basename(work), tag, commit: fixtureCommit, head: scenario.head ?? fixtureCommit,
      registry: scenario.registry ?? "matching", release: scenario.release ?? "matching", assets,
      integrity: `sha512-${createHash("sha512").update(fixtureBytes).digest("base64")}`,
    }

    await fs.writeFile(path.join(work, "state.json"), JSON.stringify(state))
    await fs.writeFile(path.join(work, "operations.jsonl"), "")
    await fs.writeFile(path.join(work, "package.json"), JSON.stringify({ name: scenario.packageName ?? "copilot-relay", version }))
    await fs.writeFile(path.join(work, "package-lock.json"), JSON.stringify({
      version: scenario.lockVersion ?? version, packages: { "": { version: scenario.lockRootVersion ?? version } },
    }))
    for (const [directory, filename] of [["npm", fixtureTarball], ["github", `owner-${fixtureTarball}`]]) {
      await fs.writeFile(path.join(work, "candidates", directory, filename), fixtureBytes)
      await fs.writeFile(path.join(work, "candidates", directory, "SHA256SUMS"), fixtureChecksum)
    }

    // These fakes model CLI responses and record effects, not release decisions.
    // Any unexpected command fails closed; nothing delegates to installed npm/gh.
    await fs.writeFile(path.join(work, "mock-cli.cjs"), `
      const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
      const [program, ...args] = process.argv.slice(2);
      const state = JSON.parse(fs.readFileSync(process.env.FIXTURE_STATE, "utf8"));
      const operation = { sentinel: state.sentinel, program, args };
      const file = program === "npm" && args[0] === "publish" ? args[1]
        : program === "gh" && args[1] === "upload" ? args[3] : undefined;
      if (file) operation.bytes = fs.readFileSync(file).toString("base64");
      fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(operation) + "\\n");
      const save = () => fs.writeFileSync(process.env.FIXTURE_STATE, JSON.stringify(state));
      if (program === "npm") {
        if (args[0] === "view") {
          assert.equal(args[2], "dist.integrity");
          if (state.registry === "matching" || state.registry === "different") {
            console.log(JSON.stringify(state.registry === "matching" ? state.integrity : "sha512-different-bytes"));
          } else {
            console.log(JSON.stringify({ error: { code: state.registry === "missing" ? "E404" : "E503" } }));
            process.exitCode = 1;
          }
        } else { assert.equal(args[0], "publish"); assert.ok(file.endsWith(".tgz")); }
      } else if (program === "git") {
        if (args.length === 2 && args.join(" ") === "rev-parse HEAD") console.log(state.head);
        else {
          assert.deepEqual(args, ["rev-parse", "--verify", "--end-of-options", "refs/tags/" + state.tag + "^{commit}"]);
          console.log(state.commit);
        }
      } else if (program === "python3") {
        assert.deepEqual(args, ["scripts/release-notes.py", state.tag, "release"]);
        console.log("Offline release notes fixture.");
      } else if (program === "gh") {
        if (args[0] === "api") {
          assert.deepEqual(args, ["api", "repos/owner/copilot-relay/releases/tags/" + state.tag]);
          if (state.release === "missing" || state.release === "unavailable") {
            console.error("gh: fixture (HTTP " + (state.release === "missing" ? "404" : "503") + ")"); process.exitCode = 1;
          } else console.log(JSON.stringify({ assets: Object.keys(state.assets).map(name => ({ name })) }));
        } else {
          assert.equal(args[0], "release"); assert.equal(args[2], state.tag); assert.ok(!args.includes("--clobber"));
          if (args[1] === "download") {
            const name = args[args.indexOf("--pattern") + 1], directory = args[args.indexOf("--dir") + 1];
            assert.ok(Object.hasOwn(state.assets, name)); fs.writeFileSync(path.join(directory, name), Buffer.from(state.assets[name], "base64"));
          } else if (args[1] === "upload") {
            const name = path.basename(file); assert.ok(!Object.hasOwn(state.assets, name)); state.assets[name] = operation.bytes; save();
          } else if (args[1] === "create") {
            assert.equal(state.release, "missing");
            for (const asset of args.slice(3, args.indexOf("--verify-tag"))) state.assets[path.basename(asset)] = fs.readFileSync(asset).toString("base64");
            save();
          } else assert.equal(args[1], "edit");
        }
      } else assert.fail("unrecognized offline CLI: " + program);
    `)

    // Native Node cannot exec a Git Bash script as git on Windows. Redirect only
    // that one execFileSync call to the same fake CLI; refuse every other child
    // launch and all sockets/fetches. Hashing, JSON and assertions remain real.
    await fs.writeFile(path.join(work, "offline-guard.cjs"), `
      const fs = require("node:fs"), net = require("node:net"), tls = require("node:tls"), cp = require("node:child_process");
      fs.writeFileSync(process.env.FIXTURE_GUARD, "offline guard active");
      const deny = () => { fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ program: "denied" }) + "\\n"); throw new Error("OFFLINE_EXTERNAL_ACCESS_DENIED"); };
      globalThis.fetch = deny; net.Socket.prototype.connect = deny; tls.connect = deny;
      const execute = cp.execFileSync;
      cp.execFileSync = (file, args, options) => file === "git"
        ? execute(process.execPath, [process.env.FIXTURE_CLI, "git", ...args], options) : deny();
      for (const name of ["exec", "execSync", "execFile", "spawn", "spawnSync", "fork"]) cp[name] = deny;
      require("node:module").syncBuiltinESMExports();
    `)

    Object.assign(env, {
      PATH: bashPath(bin), NODE_OPTIONS: `--require="${bashPath(path.join(work, "offline-guard.cjs"))}"`,
      FIXTURE_NODE: bashPath(process.execPath), FIXTURE_CLI: bashPath(path.join(work, "mock-cli.cjs")),
      FIXTURE_STATE: path.join(work, "state.json"), FIXTURE_LOG: path.join(work, "operations.jsonl"),
      FIXTURE_GUARD: path.join(work, "guard-active"), GITHUB_OUTPUT: path.join(work, "outputs"),
      GITHUB_REPOSITORY: "owner/copilot-relay", GITHUB_REPOSITORY_OWNER: "OwNeR",
      RELEASE_TAG: tag, VERSION: version, OWNER: "owner",
    })
    for (const program of ["npm", "gh", "git", "python3", "node"]) {
      const command = program === "node" ? 'exec "$FIXTURE_NODE" "$@"'
        : `exec "$FIXTURE_NODE" "$FIXTURE_CLI" ${program} "$@"`
      await fs.writeFile(path.join(bin, program), `#!/bin/bash\n${command}\n`, { mode: 0o700 })
    }

    const original = await fs.readFile(publishWorkflow, "utf8")
    const yaml = mutation ? mutation(original) : original
    // Mutants exist only here, never in the working workflow.
    const copy = path.join(work, "publish.fixture.yml")
    await fs.writeFile(copy, yaml)
    const script = path.join(work, "run.sh")
    await fs.writeFile(script, workflowRunBlock(await fs.readFile(copy, "utf8"), job))

    let code = 0
    let stdout = ""
    let stderr = ""
    try {
      // Bash's own PWD is already /c/... on Windows; use it for PATH rather
      // than a drive-letter colon, and avoid executable search via the host.
      ({ stdout, stderr } = await execute(
        bash,
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", 'export PATH="$PWD/mock-bin"; source ./run.sh'],
        { cwd: work, env, timeout: 20_000, maxBuffer: 1024 * 1024 },
      ))
    } catch (error) {
      const failure = error as { code: number | string; stdout: string; stderr: string; killed?: boolean }
      assert.equal(failure.killed, false, `workflow fixture timed out: ${failure.stderr}`)
      assert.equal(typeof failure.code, "number", `bash did not execute: ${failure.stderr}`)
      code = Number(failure.code)
      stdout = failure.stdout
      stderr = failure.stderr
    }

    assert.equal(await fs.readFile(env.FIXTURE_GUARD!, "utf8"), "offline guard active")
    const operations: OfflineOperation[] = (await fs.readFile(env.FIXTURE_LOG!, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line))
    for (const operation of operations) {
      assert.equal(operation.sentinel, state.sentinel, "only fixture CLI operations are allowed")
    }

    return {
      code,
      stdout,
      stderr,
      operations,
      outputs: await fs.readFile(env.GITHUB_OUTPUT!, "utf8").catch(() => ""),
      assets: JSON.parse(await fs.readFile(env.FIXTURE_STATE!, "utf8")).assets as Record<string, string>,
    }
  } finally {
    await fs.rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

const assertRegistryRefused = (result: Awaited<ReturnType<typeof offlineWorkflow>>) => {
  assert.notEqual(result.code, 0, "different immutable registry bytes must fail")
  assert.match(result.stderr, /different integrity; refusing/)
  assert.deepEqual(result.operations.map(op => op.args[0]), ["view"], "mismatch must never publish")
}

test("offline registry mutation proof rejects removal of the real integrity comparison", async () => {
  for (const job of ["publish-npm", "publish-github"]) {
    const mutant = await offlineWorkflow(job, { registry: "different" }, yaml => {
      const jobText = workflowJobs(yaml)[job]
      const mutated = jobText.replace(/^[ \t]+test "\$existing" = "\$integrity".*\r?\n/m, "")
      assert.notEqual(mutated, jobText, "mutation must remove exactly the integrity guard")
      return yaml.replace(jobText, () => mutated)
    })

    assert.equal(mutant.code, 0, "the mutant incorrectly succeeds on different bytes")
    assert.throws(() => assertRegistryRefused(mutant), /different immutable registry bytes must fail/)

    // The real workflow, guard intact, refuses the same bytes.
    assertRegistryRefused(await offlineWorkflow(job, { registry: "different" }))
  }
})

test("offline tag validation emits the exact committed identity only on success", async () => {
  const result = await offlineWorkflow("validate")

  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.outputs, `commit=${fixtureCommit}\nversion=${fixtureVersion}\nowner=owner\n`)
  assert.deepEqual(result.operations.map(op => [op.program, ...op.args]), [
    ["git", "rev-parse", "--verify", "--end-of-options", `refs/tags/v${fixtureVersion}^{commit}`],
    ["git", "rev-parse", "HEAD"],
  ])
})

test("offline validation and asset comparisons reject temporary fail-open mutations", async () => {
  const mutations: Array<{
    job: string; scenario: OfflineScenario; guard: RegExp
    check: (result: Awaited<ReturnType<typeof offlineWorkflow>>) => void
  }> = [
    {
      job: "validate", scenario: { tag: "v1.2.4" }, guard: /^[ \t]+assert\.equal\(tag,.*\r?\n/m,
      check: result => {
        assert.notEqual(result.code, 0, "tag mismatch must fail")
        assert.equal(result.outputs, "")
      },
    },
    {
      job: "validate", scenario: { lockVersion: "1.2.4" }, guard: /^[ \t]+assert\.equal\(lock\.version,.*\r?\n/m,
      check: result => {
        assert.notEqual(result.code, 0, "lock mismatch must fail")
        assert.equal(result.outputs, "")
      },
    },
    {
      job: "validate", scenario: { lockRootVersion: "1.2.4" }, guard: /^[ \t]+assert\.equal\(lock\.packages.*\r?\n/m,
      check: result => {
        assert.notEqual(result.code, 0, "lock root mismatch must fail")
        assert.equal(result.outputs, "")
      },
    },
    ...(["publish-npm", "publish-github"] as const).map(job => ({
      job, scenario: { registry: "unavailable" as const }, guard: /^[ \t]+node -e .*E404.*\r?\n/m,
      check: (result: Awaited<ReturnType<typeof offlineWorkflow>>) => {
        assert.notEqual(result.code, 0, "non-404 registry lookup must fail")
        assert.ok(result.operations.every(op => op.args[0] !== "publish"))
      },
    })),
    {
      job: "github-release", scenario: { release: "partial-different" }, guard: /^[ \t]+cmp --.*\r?\n/m,
      check: result => {
        assert.notEqual(result.code, 0, "different release assets must fail")
        assert.ok(result.operations.every(op => !["upload", "edit"].includes(op.args[1])))
      },
    },
  ]

  for (const { job, scenario, guard, check } of mutations) {
    const mutant = await offlineWorkflow(job, scenario, yaml => {
      const section = workflowJobs(yaml)[job]
      // Leave a valid no-op in either the Node heredoc or Bash if body.
      const replacement = section.replace(guard, job === "validate" ? "          void 0;\n" : "            :\n")
      assert.notEqual(replacement, section, `mutation must remove ${guard}`)
      // A function replacement preserves literal $' and $& inside shell text.
      return yaml.replace(section, () => replacement)
    })

    assert.equal(mutant.code, 0, mutant.stderr)
    assert.throws(() => check(mutant), /must fail/)

    // The real workflow, guard intact, passes the same check.
    check(await offlineWorkflow(job, scenario))
  }
})

for (const [description, scenario] of [
  ["non-tag ref", { tag: "main" }],
  ["noncanonical SemVer", { tag: "v01.2.3" }],
  ["tag/package version mismatch", { tag: "v1.2.4" }],
  ["wrong package name", { packageName: "unrelated-package" }],
  ["lockfile version mismatch", { lockVersion: "1.2.4" }],
  ["lockfile root version mismatch", { lockRootVersion: "1.2.4" }],
  ["checkout/tag commit mismatch", { head: "b".repeat(40) }],
] as const) {
  test(`offline tag validation rejects ${description} without publisher outputs`, async () => {
    const result = await offlineWorkflow("validate", scenario)

    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /AssertionError/)
    assert.equal(result.outputs, "", "failed validation cannot authorize candidate creation")
    assert.ok(result.operations.every(op => op.program === "git"))
  })
}

for (const [job, packageName, directory, registry] of [
  ["publish-npm", "copilot-relay", "npm", "https://registry.npmjs.org"],
  ["publish-github", "@owner/copilot-relay", "github", "https://npm.pkg.github.com"],
] as const) {
  for (const behavior of ["matching", "different", "missing", "unavailable"] as const) {
    test(`offline ${job} handles ${behavior} registry bytes without live publication`, async () => {
      const result = await offlineWorkflow(job, { registry: behavior })

      assert.deepEqual(result.operations[0].args, ["view", `${packageName}@${fixtureVersion}`, "dist.integrity", "--json", `--registry=${registry}`])
      assert.ok(result.operations.every(op => op.program === "npm"), "actual workflow must reach only the fake npm")

      if (behavior === "different") {
        assertRegistryRefused(result)
        return
      }

      if (behavior === "unavailable") {
        assert.notEqual(result.code, 0)
        assert.match(result.stderr, /lookup failed; refusing publication/)
        assert.equal(result.operations.length, 1)
        return
      }

      assert.equal(result.code, 0, result.stderr)
      if (behavior === "matching") {
        assert.match(result.stdout, /exact bytes; skipping/)
        assert.equal(result.operations.length, 1, "an existing matching version must not publish again")
      } else {
        assert.equal(result.operations.length, 2)
        const filename = directory === "npm" ? fixtureTarball : `owner-${fixtureTarball}`
        assert.deepEqual(result.operations[1].args, ["publish", `candidates/${directory}/${filename}`, "--ignore-scripts", "--access", "public", `--registry=${registry}`])
        assert.equal(result.operations[1].bytes, fixtureBytes.toString("base64"), "publish exactly the candidate, not the checkout")
      }
    })
  }
}

const githubOperations = (result: Awaited<ReturnType<typeof offlineWorkflow>>) => result.operations.filter(op => op.program === "gh")
const expectedReleaseAssets = { [fixtureTarball]: fixtureBytes.toString("base64"), SHA256SUMS: Buffer.from(fixtureChecksum).toString("base64") }

test("offline GitHub release rerun compares existing assets without replacing them", async () => {
  const result = await offlineWorkflow("github-release")

  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(result.assets, expectedReleaseAssets)
  assert.deepEqual(githubOperations(result).map(op => op.args.slice(0, 2)), [
    ["api", `repos/owner/copilot-relay/releases/tags/v${fixtureVersion}`],
    ["release", "download"], ["release", "download"], ["release", "edit"],
  ])
  assert.deepEqual(githubOperations(result).filter(op => op.args[1] === "download").map(op => op.args[4]).sort(), ["SHA256SUMS", fixtureTarball].sort())
})

for (const behavior of ["different", "partial-different"] as const) {
  test(`offline GitHub release ${behavior} bytes fail before any asset upload or release edit`, async () => {
    const result = await offlineWorkflow("github-release", { release: behavior })

    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /Existing release asset differs; refusing replacement/)
    assert.ok(githubOperations(result).some(op => op.args[1] === "download"))
    assert.ok(githubOperations(result).every(op => op.args[0] === "api" || op.args[1] === "download"))
    assert.equal(result.assets[fixtureTarball], Buffer.from("different immutable bytes").toString("base64"))

    if (behavior === "partial-different") {
      assert.ok(!Object.hasOwn(result.assets, "SHA256SUMS"), "do not upload a missing checksum before comparing every existing asset")
    }
  })
}

for (const [behavior, missing] of [["missing-tarball", fixtureTarball], ["missing-checksum", "SHA256SUMS"]] as const) {
  test(`offline GitHub release partial rerun uploads only ${missing}`, async () => {
    const result = await offlineWorkflow("github-release", { release: behavior })

    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(result.assets, expectedReleaseAssets)

    const uploads = githubOperations(result).filter(op => op.args[1] === "upload")
    assert.equal(uploads.length, 1)
    assert.deepEqual(uploads[0].args, ["release", "upload", `v${fixtureVersion}`, `release/${missing}`])
    assert.equal(uploads[0].bytes, expectedReleaseAssets[missing])
    assert.deepEqual(githubOperations(result).map(op => op.args[1]), [
      `repos/owner/copilot-relay/releases/tags/v${fixtureVersion}`, "download", "upload", "edit",
    ])
  })
}

test("offline GitHub release 404 creates only the candidate archive and checksum", async () => {
  const result = await offlineWorkflow("github-release", { release: "missing" })

  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(result.assets, expectedReleaseAssets)

  const operations = githubOperations(result)
  assert.equal(operations.length, 2)
  assert.deepEqual(operations[1].args.slice(0, 6), ["release", "create", `v${fixtureVersion}`, `release/${fixtureTarball}`, "release/SHA256SUMS", "--verify-tag"])
})

test("offline GitHub release non-404 lookup fails without uploads, creates or edits", async () => {
  const result = await offlineWorkflow("github-release", { release: "unavailable" })

  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /GitHub release lookup failed; refusing publication/)
  assert.deepEqual(githubOperations(result).map(op => op.args[0]), ["api"])
  assert.deepEqual(result.assets, expectedReleaseAssets)
})

test("packed smoke verifies exact tarballs and executes isolated help, version, tokenizer and mocked server", { timeout: 120_000 }, async () => {
  const smoke = path.join(root, "scripts/package-smoke.mjs")
  await fs.access(smoke)
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "relay-packed-test-"))

  try {
    const project = path.join(fixture, "project")
    await fs.mkdir(project)
    for (const file of ["package.json", "tsconfig.json", "tsdown.config.ts", "config.default.yaml", "LICENSE", "README.md"]) {
      await fs.copyFile(path.join(root, file), path.join(project, file))
    }

    await fs.cp(path.join(root, "src"), path.join(project, "src"), { recursive: true })
    await fs.symlink(path.join(root, "node_modules"), path.join(project, "node_modules"), process.platform === "win32" ? "junction" : "dir")
    await execute(process.execPath, [path.join(root, "node_modules/tsdown/dist/run.mjs")], { cwd: project, timeout: 60_000 })

    const manifest = JSON.parse(await fs.readFile(path.join(project, "package.json"), "utf8"))
    // Run npm's CLI script through Node: on Windows, execFile cannot launch the npm.cmd shim.
    const npmCLI = process.env.npm_execpath ?? (process.platform === "win32"
      ? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js") : undefined)
    const pack = async (directory: string) => {
      const args = ["pack", "--ignore-scripts", "--json", "--pack-destination", directory]
      const { stdout } = await execute(npmCLI ? process.execPath : "npm", npmCLI ? [npmCLI, ...args] : args, { cwd: project, timeout: 30_000 })
      const [{ filename }] = JSON.parse(stdout) as Array<{ filename: string }>
      const digest = createHash("sha256").update(await fs.readFile(path.join(directory, filename))).digest("hex")
      await fs.writeFile(path.join(directory, "SHA256SUMS"), `${digest}  ${filename}\n`)
      return path.join(directory, filename)
    }

    for (const name of ["copilot-relay", "@owner/copilot-relay"]) {
      const directory = await fs.mkdtemp(path.join(fixture, "candidate-"))
      await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ ...manifest, name }, null, 2))
      const tarball = await pack(directory)
      const { stdout } = await execute(process.execPath, [smoke, directory, name, manifest.version], { cwd: root, timeout: 45_000 })
      assert.match(stdout, /help, version, tokenizer, mocked server: ok/)

      // Bytes appended after packing must fail the checksum.
      await fs.appendFile(tarball, "tampered")
      await assert.rejects(
        execute(process.execPath, [smoke, "--verify", directory, name, manifest.version]),
        (error: unknown) => {
          assert.match((error as { stderr: string }).stderr, /checksum/i)
          return true
        },
      )
    }
  } finally {
    await fs.rm(fixture, { recursive: true, force: true })
  }
})

test("package smoke feeds checksummed bytes to tar without absolute path arguments", async () => {
  const source = await fs.readFile(path.join(root, "scripts/package-smoke.mjs"), "utf8")
  assert.match(source, /tarBytes\(\["-tzf", "-"\], bytes, unpacked\)/)
  assert.match(source, /tarBytes\(\["-xzf", "-"\], bytes, unpacked\)/)
  assert.match(source, /child\.stdin\.end\(bytes\)/)
  assert.doesNotMatch(source, /execute\("tar", \["-[tx]zf", candidate/)
})

test("package smoke rejects a checksum-matching corrupt archive without leaking temporary files", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "relay-corrupt-pack-"))

  try {
    const candidate = path.join(fixture, "candidate")
    const temporary = path.join(fixture, "tmp")
    await fs.mkdir(candidate)
    await fs.mkdir(temporary)
    const filename = "copilot-relay-1.2.3.tgz"
    const bytes = Buffer.alloc(2 * 1024 * 1024, 0x78)
    await fs.writeFile(path.join(candidate, filename), bytes)
    await fs.writeFile(path.join(candidate, "SHA256SUMS"), `${createHash("sha256").update(bytes).digest("hex")}  ${filename}\n`)

    // The checksum matches, so the failure has to come from tar reading bytes
    // that are not a gzip archive.
    await assert.rejects(
      execute(process.execPath, [path.join(root, "scripts/package-smoke.mjs"), "--verify", candidate, "copilot-relay", "1.2.3"], {
        env: { ...process.env, TEMP: temporary, TMP: temporary, TMPDIR: temporary }, timeout: 30_000,
      }),
      (error: unknown) => {
        const stderr = (error as { stderr: string }).stderr
        assert.match(stderr, /tar|archive|gzip/i)
        assert.doesNotMatch(stderr, /Unhandled 'error' event|checksum mismatch/)
        return true
      },
    )
    assert.deepEqual(await fs.readdir(temporary), [])
  } finally {
    await fs.rm(fixture, { recursive: true, force: true })
  }
})

test("both package test commands preload home isolation before tsx", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))

  for (const name of ["test:unit", "test:integration"]) {
    assert.match(manifest.scripts[name], /^node --import \.\/scripts\/test-bootstrap\.mjs --import tsx --test /)
  }
})
