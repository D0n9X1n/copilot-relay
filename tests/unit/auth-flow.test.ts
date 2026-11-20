import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

// paths.ts resolves the home directory when it is imported, so it is redirected first. Node reads
// USERPROFILE on Windows.
const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-auth-flow-test-"))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CONSOLA_LEVEL = "0"

const { authCallTimeoutMs, defaultDeviceFlowSeconds, getDeviceCode, getGitHubUser, pollAccessToken } = await import("../../src/lib/auth")
const { flushLogs } = await import("../../src/lib/log")
type AuthClock = import("../../src/lib/auth").AuthClock
type AuthFetch = import("../../src/lib/auth").AuthFetch

test.after(async () => {
  await flushLogs()
  await fs.rm(home, { recursive: true, force: true })
})

// A clock the test drives: sleeps advance time at once, and a deadline aborts when time passes it.
// It records each sleep, so a test can see the interval and the clamp to the time left.
const fakeClock = () => {
  let time = 0
  const sleeps: Array<number> = []
  const deadlines: Array<{ at: number; controller: AbortController }> = []
  const advance = (ms: number) => {
    time += ms
    for (const deadline of deadlines) {
      if (!deadline.controller.signal.aborted && time >= deadline.at) {
        deadline.controller.abort(new DOMException("The operation timed out.", "TimeoutError"))
      }
    }
  }

  const clock: AuthClock = {
    now: () => time,
    sleep: async (ms, signal) => {
      sleeps.push(ms)
      if (signal?.aborted) {
        throw signal.reason
      }

      advance(ms)
    },
    deadline: (ms) => {
      const controller = new AbortController()
      deadlines.push({ at: time + ms, controller })
      return controller.signal
    },
  }

  return { clock, sleeps, advance, now: () => time }
}

const deviceCode = { device_code: "device", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }

// A fetch that answers each poll from a script, one entry per call, and records what it was given.
const scriptedFetch = (script: Array<(signal: AbortSignal | undefined) => Promise<Response>>) => {
  const calls: Array<{ url: string; signal: AbortSignal | undefined }> = []
  const fetch: AuthFetch = async (url, init) => {
    calls.push({ url, signal: init.signal })
    const next = script.shift()
    if (next === undefined) {
      throw new Error(`Unexpected call to ${url}`)
    }

    return next(init.signal)
  }

  return { fetch, calls }
}

const json = (payload: unknown, status = 200) => async () => Response.json(payload, { status })

// A response whose body never ends until the signal aborts, as a stalled upstream sends it.
const stalledBody = (signal: AbortSignal | undefined) => Promise.resolve(new Response(new ReadableStream({
  start(controller) {
    signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true })
  },
}), { status: 200, headers: { "content-type": "application/json" } }))

test("a pending poll waits the interval and the next poll returns the token", async () => {
  const { clock, sleeps } = fakeClock()
  const { fetch } = scriptedFetch([json({ error: "authorization_pending" }), json({ access_token: "gho_token" })])

  assert.equal(await pollAccessToken(deviceCode, clock, fetch), "gho_token")
  assert.deepEqual(sleeps, [5000])
})

test("slow_down adds five seconds to the interval, and again each time it repeats", async () => {
  const { clock, sleeps } = fakeClock()
  const { fetch } = scriptedFetch([
    json({ error: "slow_down" }),
    json({ error: "slow_down" }),
    json({ error: "authorization_pending" }),
    json({ access_token: "gho_token" }),
  ])

  assert.equal(await pollAccessToken(deviceCode, clock, fetch), "gho_token")
  assert.deepEqual(sleeps, [10000, 15000, 15000])
})

test("access_denied and expired_token stop the flow at once with a clear error", async () => {
  for (const error of ["access_denied", "expired_token"]) {
    const { clock, sleeps } = fakeClock()
    const { fetch } = scriptedFetch([json({ error })])

    await assert.rejects(pollAccessToken(deviceCode, clock, fetch), (thrown: Error) => {
      assert.match(thrown.message, error === "access_denied" ? /denied/ : /expired/)
      return true
    })
    assert.deepEqual(sleeps, [])
  }
})

test("a transport failure or a 5xx retries at the current interval", async () => {
  const { clock, sleeps } = fakeClock()
  const { fetch } = scriptedFetch([
    () => Promise.reject(new TypeError("fetch failed")),
    json({ message: "unavailable" }, 503),
    json({ access_token: "gho_token" }),
  ])

  assert.equal(await pollAccessToken(deviceCode, clock, fetch), "gho_token")
  assert.deepEqual(sleeps, [5000, 5000])
})

test("repeated immediate 503 answers end at the device code's expiry", async () => {
  const { clock, now } = fakeClock()
  const answers = Array.from({ length: 1000 }, () => json({ message: "unavailable" }, 503))
  const { fetch } = scriptedFetch(answers)

  await assert.rejects(pollAccessToken({ ...deviceCode, expires_in: 60 }, clock, fetch), /expired|did not finish/)
  assert.ok(now() <= 60_000, `the flow ended at ${now()} ms`)
})

test("a missing expires_in falls back to the default flow deadline", async () => {
  const { clock, now } = fakeClock()
  const answers = Array.from({ length: 1000 }, () => json({ error: "authorization_pending" }))
  const { fetch } = scriptedFetch(answers)

  await assert.rejects(pollAccessToken({ ...deviceCode, expires_in: Number.NaN }, clock, fetch))
  assert.ok(now() <= defaultDeviceFlowSeconds * 1000 && now() > (defaultDeviceFlowSeconds - 10) * 1000, `ended at ${now()} ms`)
})

test("a sleep is cut to the time left, and a poll started with 1 s left is bounded by it", async () => {
  const { clock, sleeps, advance } = fakeClock()
  advance(0)
  const signals: Array<AbortSignal | undefined> = []
  const { fetch } = scriptedFetch([
    json({ error: "authorization_pending" }),
    (signal) => {
      signals.push(signal)
      return stalledBody(signal)
    },
  ])

  // 6 s to expire: the first poll leaves 6 s, the sleep is cut to 5 s (the interval), leaving 1 s for
  // the second poll, whose stalled body is aborted when that second runs out.
  const flow = pollAccessToken({ ...deviceCode, expires_in: 6 }, clock, fetch)
  await new Promise((resolve) => setImmediate(resolve))
  advance(1000)
  await assert.rejects(flow)
  assert.deepEqual(sleeps, [5000])
  assert.equal(signals[0]?.aborted, true)
})

test("a sleep longer than the time left is cut to it", async () => {
  const { clock, sleeps } = fakeClock()
  const { fetch } = scriptedFetch([json({ error: "slow_down" }), json({ error: "authorization_pending" })])

  await assert.rejects(pollAccessToken({ ...deviceCode, expires_in: 7, interval: 5 }, clock, fetch))
  assert.equal(sleeps[0], 7000)
})

test("a stalled poll body is cut off after 30 seconds, then polling goes on", async () => {
  const { clock, sleeps, advance } = fakeClock()
  const { fetch } = scriptedFetch([(signal) => stalledBody(signal), json({ access_token: "gho_token" })])

  const flow = pollAccessToken(deviceCode, clock, fetch)
  await new Promise((resolve) => setImmediate(resolve))
  advance(authCallTimeoutMs)

  assert.equal(await flow, "gho_token")
  assert.deepEqual(sleeps, [5000])
})

test("a stalled device-code body fails after 30 seconds", async () => {
  const { clock, advance } = fakeClock()
  const { fetch } = scriptedFetch([(signal) => stalledBody(signal)])

  const request = getDeviceCode(clock, fetch)
  await new Promise((resolve) => setImmediate(resolve))
  advance(authCallTimeoutMs)

  await assert.rejects(request)
})

test("a stalled /user lookup fails after its own 30 seconds", async () => {
  const { clock, advance } = fakeClock()
  const { fetch } = scriptedFetch([(signal) => stalledBody(signal)])

  const lookup = getGitHubUser("gho_token", "1.99.3", undefined, clock, fetch)
  await new Promise((resolve) => setImmediate(resolve))
  advance(authCallTimeoutMs)

  await assert.rejects(lookup)
})

const { quickEditTip, signInLines } = await import("../../src/lib/auth")

test("the QuickEdit tip appears only on a Windows terminal", () => {
  const tip = "Tip: a click in this window pauses output; press Esc or Enter to resume."

  assert.equal(quickEditTip({ isTTY: true }, "win32"), tip)
  assert.equal(quickEditTip({ isTTY: false }, "win32"), undefined)
  assert.equal(quickEditTip({ isTTY: undefined }, "win32"), undefined)
  assert.equal(quickEditTip({ isTTY: true }, "darwin"), undefined)
  assert.equal(quickEditTip({ isTTY: true }, "linux"), undefined)
})

test("the sign-in lines put the tip before the device code, on the stream that prints it", () => {
  const url = "https://github.com/login/device"

  assert.deepEqual(signInLines(url, "ABCD-1234", { isTTY: true }, "win32"), [
    "Tip: a click in this window pauses output; press Esc or Enter to resume.",
    "Sign in: open https://github.com/login/device and enter ABCD-1234.",
  ])
  assert.deepEqual(signInLines(url, "ABCD-1234", { isTTY: false }, "win32"), [
    "Sign in: open https://github.com/login/device and enter ABCD-1234.",
  ])
  assert.deepEqual(signInLines(url, "ABCD-1234", { isTTY: true }, "linux"), [
    "Sign in: open https://github.com/login/device and enter ABCD-1234.",
  ])
})

const { authOutcomeLine } = await import("../../src/auth")

test("auth names the signed-in user, or says the lookup failed without failing auth", () => {
  assert.equal(authOutcomeLine("octocat"), "Logged in as octocat")
  assert.equal(authOutcomeLine(undefined), "Logged in; GitHub user unavailable")
})
