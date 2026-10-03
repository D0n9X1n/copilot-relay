#!/usr/bin/env node
// Verify a candidate's immutable bytes, then run only its packed JavaScript.
// No registry, real credentials, inference, installed CLI, or source imports.
import assert from "node:assert/strict"
import { execFile, fork } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify, stripVTControlCharacters } from "node:util"

const execute = promisify(execFile)

// Feed the verified bytes directly: GNU tar interprets Windows drive colons as
// remote hosts, and reopening the path would not guarantee the hashed bytes.
const tarBytes = (args, bytes, cwd) => new Promise((resolve, reject) => {
  let inputError
  const child = execFile("tar", args, { cwd }, (error, stdout) => {
    if (error || inputError) {
      reject(error ?? inputError)
    } else {
      resolve(stdout)
    }
  })

  // A rejecting tar may close stdin early; wait for its exit/stderr rather than
  // letting EPIPE escape as an unhandled event.
  child.stdin.on("error", (error) => {
    inputError = error
  })
  child.stdin.end(bytes)
})

const root = fileURLToPath(new URL("../", import.meta.url))
const argv = process.argv.slice(2)
const verifyOnly = argv[0] === "--verify"
if (verifyOnly) {
  argv.shift()
}

const [directory, name, version] = argv
assert.equal(argv.length, 3, "Usage: package-smoke.mjs [--verify] <directory> <package-name> <version>")
assert.match(name, /^(?:@[a-z0-9][a-z0-9-]*\/)?copilot-relay$/)
assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)

// npm pack names a scoped package's tarball without the "@" and with "-" for "/".
const filename = `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`
const candidate = path.resolve(directory, filename)
assert.deepEqual(
  (await fs.readdir(directory)).sort(),
  ["SHA256SUMS", filename].sort(),
  "candidate directory must contain only its tarball and SHA256SUMS",
)
for (const file of [candidate, path.resolve(directory, "SHA256SUMS")]) {
  assert.ok((await fs.lstat(file)).isFile(), "candidate assets must be regular files, not symlinks")
}

const bytes = await fs.readFile(candidate)
const checksum = createHash("sha256").update(bytes).digest("hex")
assert.equal(
  await fs.readFile(path.join(directory, "SHA256SUMS"), "utf8"),
  `${checksum}  ${filename}\n`,
  "candidate checksum mismatch",
)

const work = await fs.mkdtemp(path.join(tmpdir(), "copilot-relay-package-smoke-"))
// Declared outside the try so the finally block can stop whatever was started.
let upstream
let child
let childExit
try {
  const unpacked = path.join(work, "unpacked")
  const home = path.join(work, "home")
  await fs.mkdir(unpacked)
  await fs.mkdir(home)

  // Candidate tarballs originate in our pack job, but reject unexpected members
  // before extraction rather than allowing path traversal in a smoke fixture.
  const listing = await tarBytes(["-tzf", "-"], bytes, unpacked)
  for (const member of listing.trim().split(/\r?\n/)) {
    assert.ok(
      member.startsWith("package/")
      && !member.includes("\\")
      && !member.split("/").includes(".."),
      "unsafe archive member",
    )
  }

  await tarBytes(["-xzf", "-"], bytes, unpacked)
  const installed = path.join(unpacked, "package")
  const manifest = JSON.parse(await fs.readFile(path.join(installed, "package.json"), "utf8"))
  assert.equal(manifest.name, name)
  assert.equal(manifest.version, version)
  assert.equal(manifest.bin["copilot-relay"], "dist/main.js")
  const entry = path.join(installed, manifest.bin["copilot-relay"])
  assert.ok((await fs.stat(entry)).size > 0, "packed CLI is missing")
  await fs.access(path.join(installed, "config.default.yaml"))

  if (verifyOnly) {
    console.log(`${name}@${version}: checksum and manifest ok`)
  } else {
    // Use only production dependencies already installed by npm ci in this
    // matrix leg. A real copy, not a link to the checkout, proves src and dev
    // tooling cannot supply a missing packaged file or dynamic tokenizer asset.
    const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"))
    // packages[""] is the root project; every other key is an installed path.
    assert.deepEqual(manifest.dependencies, lock.packages[""].dependencies)
    for (const [location, dependency] of Object.entries(lock.packages)) {
      if (!location || dependency.dev) {
        continue
      }

      assert.ok(location.startsWith("node_modules/") && !location.split("/").includes(".."))
      const source = path.join(root, location)
      const actual = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"))
      assert.equal(actual.version, dependency.version, `npm ci required: ${location}`)
      await fs.mkdir(path.dirname(path.join(installed, location)), { recursive: true })
      await fs.cp(source, path.join(installed, location), { recursive: true, dereference: true })
    }

    // os.homedir() reads USERPROFILE on Windows and HOME elsewhere.
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CI: "true",
      FORCE_COLOR: "0",
      CONSOLA_LEVEL: "3",
    }
    delete env.NO_COLOR
    // Do not carry credentials or a developer's preload/proxy into the child.
    for (const key of Object.keys(env)) {
      if (
        /TOKEN|SECRET|PASSWORD|API_KEY|PROXY/i.test(key)
        || ["NODE_OPTIONS", "NODE_PATH"].includes(key)
      ) {
        delete env[key]
      }
    }

    // Preloaded into each child with --import. Sockets may reach only the mock
    // upstream, the mock upstream answers GitHub's user lookup, the global fetch
    // is never allowed, every listener takes a kernel-chosen port and reports it
    // over IPC, and "shutdown" raises SIGTERM.
    const guard = path.join(installed, "smoke-guard.mjs")
    await fs.writeFile(guard, `
      import fs from "node:fs/promises";
      import net from "node:net";
      import { syncBuiltinESMExports } from "node:module";
      import { Agent } from "undici";
      // The relay sends Copilot and GitHub calls through its own undici dispatcher, not the
      // global fetch (#153). Its GitHub user lookup goes to the mock upstream; any other
      // request off this machine is left to the socket guard below, which blocks it.
      const dispatch = Agent.prototype.dispatch;
      Agent.prototype.dispatch = function (options, handler) {
        const github = new URL(String(options.origin)).origin === "https://api.github.com";
        if (github && options.method === "GET" && options.path === "/user") {
          options = { ...options, origin: "http://127.0.0.1:" + process.env.SMOKE_UPSTREAM_PORT, path: "/github/user" };
        }
        return dispatch.call(this, options, handler);
      };
      // Guard the socket layer too: the relay uses its own undici dispatcher.
      const connect = net.Socket.prototype.connect;
      net.Socket.prototype.connect = function (...args) {
        const options = Array.isArray(args[0]) ? args[0][0] : args[0];
        const port = typeof options === "object" ? options.port : options;
        const host = typeof options === "object" ? options.host : args[1];
        if (host !== "127.0.0.1" || Number(port) !== Number(process.env.SMOKE_UPSTREAM_PORT)) {
          fs.writeFile(process.env.SMOKE_VIOLATION, "blocked socket").catch(() => {});
          throw new Error("SMOKE_BLOCKED_NETWORK");
        }
        return connect.apply(this, args);
      };
      syncBuiltinESMExports();
      globalThis.fetch = async () => {
        await fs.writeFile(process.env.SMOKE_VIOLATION, "blocked fetch");
        throw new Error("SMOKE_BLOCKED_NETWORK");
      };
      // The config parser correctly rejects port 0; assign 0 only at the owned
      // child socket so the kernel chooses a free port without a reserve race.
      const listen = net.Server.prototype.listen;
      net.Server.prototype.listen = function (options, ...args) {
        if (typeof options === "number") options = 0;
        else options = { ...options, port: 0, host: "127.0.0.1" };
        this.once("listening", () => {
          // Written to stdout, the stream startup logs use, so the smoke can order them.
          process.stdout.write("SMOKE_LISTENING\\n");
          process.send?.({ port: this.address().port });
        });
        return listen.call(this, options, ...args);
      };
      syncBuiltinESMExports();
      process.on("message", (message) => {
        if (message === "shutdown") {
          process.emit("SIGTERM", "SIGTERM");
          process.disconnect?.();
        }
      });
    `)

    env.SMOKE_VIOLATION = path.join(work, "network-violation")
    env.SMOKE_UPSTREAM_PORT = "0"
    const help = await execute(
      process.execPath,
      ["--import", pathToFileURL(guard).href, entry, "--help"],
      { cwd: installed, env, timeout: 10_000 },
    )
    assert.match(help.stdout, /USAGE/)
    assert.match(help.stdout, /copilot-relay/)

    const requests = []
    upstream = createServer(async (request, response) => {
      let body = ""
      for await (const chunk of request) {
        body += chunk
      }

      const payload = body ? JSON.parse(body) : {}
      requests.push(`${request.method} ${request.url}`)
      response.setHeader("content-type", "application/json")
      if (request.url === "/models") {
        response.end(JSON.stringify({
          data: ["gpt-6-astra", "claude-opus-5.5"].map((id) => ({
            id,
            supported_endpoints: ["/responses", "/chat/completions"],
            capabilities: {
              type: "chat",
              tokenizer: "o200k_base",
              limits: {
                max_context_window_tokens: 32768,
                max_prompt_tokens: 16384,
                max_output_tokens: 4096,
              },
            },
          })),
        }))
      } else if (request.method === "GET" && request.url === "/github/user") {
        // The relay's GitHub user lookup, sent here by the guard.
        response.end(JSON.stringify({ login: "offline-smoke" }))
      } else if (request.url === "/responses") {
        response.end(JSON.stringify({
          id: "resp_smoke",
          status: "completed",
          model: payload.model,
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "offline smoke" }],
          }],
          usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        }))
      } else if (request.url === "/chat/completions") {
        response.end(JSON.stringify({
          id: "chat_smoke",
          model: payload.model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: "offline smoke" },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }))
      } else {
        response.statusCode = 500
        response.end("Unexpected smoke upstream path")
      }
    })

    await new Promise((resolve, reject) => {
      upstream.once("error", reject)
      upstream.listen(0, "127.0.0.1", resolve)
    })

    // Never the default relay port (4142), which a developer's live relay may be using.
    const upstreamPort = upstream.address().port
    assert.notEqual(upstreamPort, 4142)
    env.SMOKE_UPSTREAM_PORT = String(upstreamPort)

    // The guard moves every listener to port 0, so port 65535 is never bound; it
    // only has to pass config validation.
    const app = path.join(home, ".copilot-relay")
    await fs.mkdir(app)
    await fs.writeFile(path.join(app, "config.yaml"), [
      "host: 127.0.0.1",
      "port: 65535",
      `copilotBaseUrl: http://127.0.0.1:${upstreamPort}`,
      "upstreamProxy: ",
      "claudeSetup: false",
      "logLevel: info",
      "logRetentionDays: 3",
      "thinkEffort: high",
      "upstreamTimeoutSeconds: 5",
      "webSearchBackend: ",
      "gptModel: gpt-6-astra",
      "opusModel: claude-opus-5.5",
      "",
    ].join("\n"))
    await fs.writeFile(path.join(app, "github_token"), "offline-github-fixture\n", { mode: 0o600 })
    await fs.writeFile(path.join(app, "copilot_token.json"), JSON.stringify({
      token: "offline-copilot-fixture",
      refreshedAt: Date.now(),
      refreshIn: 86400,
    }), { mode: 0o600 })

    child = fork(entry, ["start"], {
      cwd: installed,
      env,
      execArgv: ["--import", pathToFileURL(guard).href],
      silent: true,
    })

    let output = ""
    child.stdout.on("data", (chunk) => {
      output += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      output += chunk.toString()
    })
    childExit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))

    // The guard reports the kernel-chosen port over IPC once the relay listens.
    const port = await new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("packaged server did not listen within 15s")),
        15_000,
      )
      child.once("error", (error) => {
        clearTimeout(deadline)
        reject(error)
      })
      child.once("exit", (code) => {
        clearTimeout(deadline)
        reject(new Error(`packaged server exited early (${code}): ${output}`))
      })
      child.once("message", (message) => {
        clearTimeout(deadline)
        resolve(message.port)
      })
    })

    assert.ok(Number.isInteger(port) && port > 0 && port !== 4142)
    const base = `http://127.0.0.1:${port}`
    const request = (route, init) => fetch(`${base}${route}`, { ...init, signal: AbortSignal.timeout(5000) })

    const health = await request("/healthz")
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true, version })

    const beforeTokens = requests.length
    const counted = await request("/v1/messages/count_tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-6-astra",
        messages: [{ role: "user", content: "Count the tokens in this offline packaged smoke request." }],
      }),
    })
    assert.equal(counted.status, 200)
    assert.ok((await counted.json()).input_tokens > 1, "real dynamic tokenizer must not fall back to 1")
    assert.equal(requests.length, beforeTokens, "token counting must remain local")

    for (const model of ["gpt-6-astra", "claude-opus-5.5"]) {
      const response = await request("/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 16,
          messages: [{ role: "user", content: "offline fixture" }],
        }),
      })
      assert.equal(response.status, 200)
      assert.match(JSON.stringify(await response.json()), /offline smoke/)
    }

    assert.ok(requests.includes("POST /responses"))
    assert.ok(requests.includes("POST /chat/completions"))
    // The guard answers the GitHub user lookup only at the undici dispatcher, so this request
    // shows that the packed relay sends GitHub calls through it.
    assert.ok(requests.includes("GET /github/user"))

    // start loads the configured models' tokenizers before its server listens. The guard writes
    // SMOKE_LISTENING to stdout when the server listens, after every line logged before that;
    // logLevel: info in the config above makes the startup lines print. The GitHub user line
    // comes after the server listens.
    const settle = Date.now() + 5000
    while (
      !(output.includes("SMOKE_LISTENING") && output.includes("GitHub user:"))
      && Date.now() < settle
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    const startup = stripVTControlCharacters(output)
    const loaded = startup.indexOf("Tokenizers loaded: o200k_base")
    assert.ok(
      loaded !== -1 && loaded < startup.indexOf("SMOKE_LISTENING"),
      `tokenizers must load before the server listens:\n${startup}`,
    )
    assert.match(startup, /GitHub user: offline-smoke/)

    // claudeSetup is false, so ~/.claude must not exist; the guard writes the
    // violation file only when it blocks network access.
    await assert.rejects(fs.access(path.join(home, ".claude")), { code: "ENOENT" })
    await assert.rejects(fs.access(env.SMOKE_VIOLATION), { code: "ENOENT" })
    assert.doesNotMatch(output, /offline-github-fixture|offline-copilot-fixture|SMOKE_BLOCKED_NETWORK/)
    console.log(`${name}@${version}: help, version, tokenizer, mocked server: ok`)
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    // Asked over IPC because child.kill() on Windows terminates at once, without
    // the relay's SIGTERM handler; the guard raises SIGTERM inside the child.
    if (child.connected) {
      child.send("shutdown")
    }

    // Only the child this script forked can be terminated. No pid-file lookup,
    // global process scan, or installed stop/restart command is ever involved.
    const deadline = setTimeout(() => child.kill("SIGKILL"), 3000)
    await childExit
    clearTimeout(deadline)
  }

  if (upstream) {
    upstream.closeAllConnections()
    await new Promise((resolve) => upstream.close(resolve))
  }

  await fs.rm(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
