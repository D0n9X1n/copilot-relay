// Process lifecycle helpers for stopping stale local relay instances.
import { execFile } from "node:child_process"
import type { Stats } from "node:fs"
import fs from "node:fs/promises"
import { posix } from "node:path"
import { promisify } from "node:util"

import type { ProxyConfig } from "~/lib/config"
import { getRelayBaseUrl } from "~/lib/address"
import { log } from "~/lib/log"
import { paths } from "~/lib/paths"
import { appVersion } from "~/lib/version"

const execFileAsync = promisify(execFile)
const stopTimeoutMs = 5_000
const stopPollMs = 100

export interface RelayPidFile {
  host: string
  pid: number
  port: number
  startedAt: string
  /**
   * The version of the build that wrote this file — the daemon's, never the
   * caller's. Optional because a file written before v0.3.1 has no such field,
   * and because it must be readable even when the daemon is not yet healthy.
   */
  version?: string
}

const isNodeErrno = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const parsePid = (value: unknown): number | undefined => {
  const pid = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value.trim()) : value
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0
    ? pid : undefined
}

const readCommandOutput = async (
  file: string,
  args: Array<string>,
  required = false,
): Promise<string> => {
  try {
    const { stdout } = await execFileAsync(file, args, {
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    return String(stdout)
  } catch (error) {
    // lsof uses exit 1 (with empty output) for a verified empty listener set.
    const emptyListeners = file === "lsof" && args.some((arg) => arg.startsWith("-iTCP:"))
      && typeof error === "object" && error !== null && "code" in error && error.code === 1
      && "stdout" in error && error.stdout === "" && "stderr" in error && error.stderr === ""
    if (required && !emptyListeners) throw new RelayInspectionError()
    // Failed queries can carry partial stdout; it is not verified identity.
    return ""
  }
}

const parsePidLines = (output: string): Array<number> =>
  output
    .split(/\r?\n/)
    .map((line) => parsePid(line))
    .filter((pid): pid is number => pid !== undefined)

// Only parse argv-like quoted paths, never shell expressions or arbitrary
// mentions. A false negative is safer than signalling an editor or grep.
const commandArgs = (command: string): Array<string> => {
  const tokens = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g) ?? []
  if (tokens.join(" ") !== command.trim().replace(/\s+(?=(?:[^"']*["'][^"']*["'])*[^"']*$)/g, " ")) {
    return []
  }
  return tokens.map((token) => token.replace(/^(["'])(.*)\1$/, "$2").replaceAll("\\", "/"))
}

type CommandProof = "relay" | "nonrelay" | "unknown"

const isDaemonCommand = (value: string | undefined) => value === "start" || value === "restart"

// The Node script argument of `node [--import tsx] <entry> start|restart`, or
// undefined for any other argv shape.
const nodeDaemonEntry = (args: Array<string>): string | undefined => {
  if (!/^node(?:\.exe)?$/i.test(posix.basename(args[0] ?? ""))) return undefined
  let index = 1
  // These documented loader forms are used for source checkouts. Do not skip
  // arbitrary Node switches: --eval/--print can merely quote a relay command.
  if (args[index] === "--import" && args[index + 1] === "tsx") index += 2
  else if (args[index] === "--import=tsx") index++
  const entry = args[index]
  return entry && isDaemonCommand(args[index + 1]) ? entry : undefined
}

const resolveEntry = (entry: string, cwd: string | undefined): string | undefined => {
  const normalizedCwd = cwd?.replaceAll("\\", "/")
  const absolute = posix.isAbsolute(entry) || /^[A-Za-z]:\//.test(entry)
  if (!absolute && !normalizedCwd) return undefined
  return posix.normalize(absolute ? entry : `${normalizedCwd}/${entry}`)
}

export const isRelayStartProcess = (command: string, cwd?: string): boolean => {
  const args = commandArgs(command)
  if (/^copilot-relay(?:\.cmd|\.exe)?$/i.test(posix.basename(args[0] ?? ""))) {
    return isDaemonCommand(args[1])
  }
  const entry = nodeDaemonEntry(args)
  if (!entry) return false
  if (posix.basename(entry) === "copilot-relay") return true

  const resolved = resolveEntry(entry, cwd)
  // Exact package/check-out directory, not a substring in a parent directory.
  return resolved !== undefined
    && /(?:^|\/)copilot-relay(?:-[A-Za-z0-9._-]+)?\/(?:dist\/main\.js|src\/main\.ts)$/.test(resolved)
}

// A relay entrypoint installed under a directory with any name, e.g. a release
// runtime at ~/.copilot-relay/runtime/0.4.1/dist/main.js (#113). The argv shape
// is only a candidate; packageEntryProof decides from the filesystem.
const packagedEntryCandidate = (command: string, cwd?: string): string | undefined => {
  const entry = nodeDaemonEntry(commandArgs(command))
  const resolved = entry === undefined ? undefined : resolveEntry(entry, cwd)
  return resolved && /\/(?:dist\/main\.js|src\/main\.ts)$/.test(resolved) ? resolved : undefined
}

// Identity comes from the package manifest beside the entrypoint, not from the
// install directory's name. Any failure to prove it is "nonrelay", exactly what
// these commands were before, so an unrelated `node app/dist/main.js start`
// can never become a relay or block `stop` on an unreadable directory.
const packageEntryProof = async (entry: string): Promise<CommandProof> => {
  try {
    if (!(await fs.stat(entry)).isFile()) return "nonrelay"
    const canonical = (await fs.realpath(entry)).replaceAll("\\", "/")
    if (!/\/(?:dist\/main\.js|src\/main\.ts)$/.test(canonical)) return "nonrelay"
    const manifest: unknown = JSON.parse(await fs.readFile(
      posix.join(posix.dirname(posix.dirname(canonical)), "package.json"), "utf8"))
    return typeof manifest === "object" && manifest !== null && "name" in manifest
      && manifest.name === "copilot-relay" ? "relay" : "nonrelay"
  } catch {
    return "nonrelay"
  }
}

export class RelayInspectionError extends Error {
  constructor(pid?: number) {
    super(pid === undefined
      ? "Could not verify relay process discovery; stop was not confirmed."
      : `Could not verify copilot-relay process pid=${pid}; stop was not confirmed.`)
    this.name = "RelayInspectionError"
  }
}

interface FlatInvocation {
  node: string
  earlierExecutables: string[]
  program: string
  earlierPrograms: string[]
}

// This describes a possible flattened POSIX invocation, never ownership. The
// async verifier below must prove every ambiguous boundary against the filesystem.
const flatInvocation = (command: string): FlatInvocation | undefined => {
  if (process.platform === "win32" || /["'\r\n]/.test(command)) return undefined
  const spans = [...command.matchAll(/\S+/g)]
  const args = spans.map((span) => span[0])
  const joined = (start: number, end: number) => command.slice(spans[start].index,
    spans[end].index + spans[end][0].length)
  const nodeEnd = args.findIndex((_part, at) => posix.basename(joined(0, at)) === "node")
  if (nodeEnd < 0) return undefined
  const node = joined(0, nodeEnd)
  const earlierExecutables = args.slice(0, nodeEnd).map((_part, at) => joined(0, at))
  let start = nodeEnd + 1
  if (args[start] === "--import" && args[start + 1] === "tsx") start += 2
  else if (args[start] === "--import=tsx") start++
  if (!args[start] || args[start].startsWith("-")) return undefined
  const end = args.findIndex((arg, at) => at > start && (arg === "start" || arg === "restart"))
  if (end < 0) return undefined
  const program = joined(start, end - 1)
  if (!/(?:^|\/)copilot-relay(?:-[A-Za-z0-9._-]+)?\/(?:dist\/main\.js|src\/main\.ts)$/.test(program)) return undefined
  return {
    node, earlierExecutables, program,
    earlierPrograms: args.slice(start, end - 1).map((_part, at) => joined(start, start + at)),
  }
}

const verifyCommand = async (command: string, cwd: string | undefined): Promise<CommandProof> => {
  if (isRelayStartProcess(command, cwd)) return "relay"
  const packaged = packagedEntryCandidate(command, cwd)
  if (packaged && (await packageEntryProof(packaged)) === "relay") return "relay"
  const flat = flatInvocation(command)
  if (!flat) return "nonrelay"
  if (!cwd) return "unknown"
  const resolve = (value: string) => posix.resolve(cwd.replaceAll("\\", "/"), value)
  const absent = async (candidate: string): Promise<boolean> => {
    try { await fs.stat(candidate); return false }
    catch (error) {
      if (isNodeErrno(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) return true
      throw error
    }
  }
  try {
    // Any earlier executable/script/directory can own the remaining arguments.
    // Node also resolves extensionless scripts using .js/.json/.node suffixes.
    for (const candidate of flat.earlierExecutables) {
      if (!(await absent(resolve(candidate)))) return "nonrelay"
    }
    for (const candidate of flat.earlierPrograms) {
      for (const suffix of ["", ".js", ".json", ".node"]) {
        if (!(await absent(resolve(candidate) + suffix))) return "nonrelay"
      }
    }
    if (flat.earlierExecutables.length) {
      const nodePath = resolve(flat.node)
      if (!(await fs.stat(nodePath)).isFile()) return "unknown"
      if (posix.basename(await fs.realpath(nodePath)) !== "node") return "unknown"
    }
    const program = resolve(flat.program)
    if (!(await fs.stat(program)).isFile()) return "unknown"
    const canonical = (await fs.realpath(program)).replaceAll("\\", "/")
    if (!/(?:^|\/)copilot-relay(?:-[A-Za-z0-9._-]+)?\/(?:dist\/main\.js|src\/main\.ts)$/.test(canonical)) return "unknown"
    const packagePath = posix.join(posix.dirname(posix.dirname(canonical)), "package.json")
    if (!(await fs.stat(packagePath)).isFile()) return "unknown"
    const manifest: unknown = JSON.parse(await fs.readFile(packagePath, "utf8"))
    if (typeof manifest !== "object" || manifest === null || !("name" in manifest)
      || manifest.name !== "copilot-relay") return "unknown"
    return "relay"
  } catch {
    return "unknown"
  }
}

const processState = (pid: number): "alive" | "gone" | "unknown" => {
  try {
    process.kill(pid, 0)
    return "alive"
  } catch (error) {
    if (isNodeErrno(error) && error.code === "ESRCH") return "gone"
    if (isNodeErrno(error) && error.code === "EPERM") return "alive"
    return "unknown"
  }
}

// Only ESRCH proves absence; unexpected probe failures must preserve the record.
const isProcessAlive = (pid: number): boolean => processState(pid) !== "gone"

// Missing, malformed or legacy records provide no identity evidence; callers must still inspect their process/listener scope.
export const readRelayPidFileEntry = async (): Promise<
  RelayPidFile | undefined
> => {
  try {
    const content = await fs.readFile(paths.pidPath, "utf8")
    const trimmed = content.trim()
    if (!trimmed || !trimmed.startsWith("{")) {
      return undefined
    }

    const payload = JSON.parse(trimmed) as Partial<RelayPidFile>
    const pid = parsePid(payload.pid)
    if (
      pid === undefined
      || typeof payload.host !== "string"
      || !payload.host || /[\s\\/@?#%\u0000-\u001f\u007f]/.test(payload.host)
      || (payload.host.startsWith("[") && !/^\[[0-9a-fA-F:.]+\]$/.test(payload.host))
      || typeof payload.port !== "number" || !Number.isInteger(payload.port)
      || payload.port < 1 || payload.port > 65_535
    ) {
      return undefined
    }

    const address = new URL(getRelayBaseUrl(payload.host, payload.port))
    if (!address.hostname || address.username || address.password || address.pathname !== "/"
      || address.search || address.hash) return undefined

    return {
      host: payload.host,
      pid,
      port: payload.port,
      startedAt:
        typeof payload.startedAt === "string" ? payload.startedAt : "",
      ...(typeof payload.version === "string" && payload.version ?
        { version: payload.version }
      : {}),
    }
  } catch {
    return undefined
  }
}

interface PidSnapshot {
  raw: string
  stat: Stats
}

const sameFile = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size
  && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs

const readPidSnapshot = async (): Promise<PidSnapshot | undefined> => {
  try {
    const before = await fs.lstat(paths.pidPath)
    if (!before.isFile()) return undefined
    const raw = await fs.readFile(paths.pidPath, "utf8")
    const stat = await fs.lstat(paths.pidPath)
    return sameFile(before, stat) ? { raw, stat } : undefined
  } catch (error) {
    if (isNodeErrno(error) && error.code === "ENOENT") return undefined
    throw error
  }
}

const pidFromContent = (raw: string | undefined): number | undefined => {
  const trimmed = raw?.trim()
  if (!trimmed) return undefined
  try {
    return parsePid(trimmed.startsWith("{") ? JSON.parse(trimmed).pid : trimmed)
  } catch {
    return undefined
  }
}

// Do not remove a replacement daemon's record after a slow discovery/stop.
// The recheck is deliberately conservative, not an OS-wide compare-and-unlink.
const clearPidSnapshot = async (expected: PidSnapshot | undefined): Promise<void> => {
  if (!expected) return
  const current = await readPidSnapshot()
  if (!current || current.raw !== expected.raw || !sameFile(current.stat, expected.stat)) return
  await fs.unlink(paths.pidPath).catch((error: unknown) => {
    if (!isNodeErrno(error) || error.code !== "ENOENT") throw error
  })
}

export const writeRelayPidFile = async (
  config: Pick<ProxyConfig, "host" | "port">,
): Promise<void> => {
  await fs.mkdir(paths.appDir, { recursive: true })
  const payload: RelayPidFile = {
    host: config.host,
    pid: process.pid,
    port: config.port,
    startedAt: new Date().toISOString(),
    // Written by the daemon at startup, so it is the build actually serving —
    // unlike `status`, which used to report the version of whichever CLI was
    // invoked. See #43. Covers the window before the daemon answers /healthz.
    version: appVersion,
  }
  await fs.writeFile(paths.pidPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  })
}

export const clearRelayPidFile = async (
  pid = process.pid,
  options: { force?: boolean } = {},
): Promise<void> => {
  const snapshot = await readPidSnapshot()
  const currentPid = pidFromContent(snapshot?.raw)
  if (!options.force && currentPid !== undefined && currentPid !== pid) return
  await clearPidSnapshot(snapshot)
}

const getProcessCommand = async (pid: number): Promise<string | undefined> => {
  if (process.platform === "win32") {
    const output = await readCommandOutput("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine`,
    ])
    return output.trim() || undefined
  }

  const output = await readCommandOutput("ps", [
    "-p",
    String(pid),
    "-o",
    "command=",
  ])
  return output.trim() || undefined
}

const getProcessCwd = async (pid: number): Promise<string | undefined> => {
  if (process.platform === "win32") {
    return undefined
  }

  const output = await readCommandOutput("lsof", [
    "-a",
    "-p",
    String(pid),
    "-d",
    "cwd",
    "-Fn",
  ])
  return output
    .split(/\r?\n/)
    .find((line) => line.startsWith("n"))
    ?.slice(1)
}

const getPortListenerPids = async (port: number): Promise<Array<number>> => {
  if (process.platform === "win32") {
    return parsePidLines(await readCommandOutput("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
    ], true))
  }

  return parsePidLines(await readCommandOutput("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ], true))
}

const getProcessList = async (): Promise<Array<{ command: string; pid: number }>> => {
  const output =
    process.platform === "win32" ?
      await readCommandOutput("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
      ], true)
    : await readCommandOutput("ps", ["-axo", "pid=,command="], true)

  return output
    .split(/\r?\n/)
    .flatMap((line) => {
      const match =
        process.platform === "win32" ?
          line.match(/^(\d+)\t(.+)$/)
        : line.match(/^\s*(\d+)\s+(.+)$/)
      const pid = parsePid(match?.[1])
      const command = match?.[2]?.trim()
      return pid && command ? [{ command, pid }] : []
    })
}

interface RelayProcessIdentity {
  pid: number
  command: string
  cwd: string | undefined
  createdAt: string
}

const getProcessCreatedAt = async (pid: number): Promise<string> => {
  const output = process.platform === "win32"
    ? await readCommandOutput("powershell.exe", [
      "-NoProfile", "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToUniversalTime().ToString("o")`,
    ])
    : await readCommandOutput("ps", ["-p", String(pid), "-o", "lstart="])
  return output.trim()
}

type ProcessObservation =
  | { state: "present"; identity: RelayProcessIdentity }
  | { state: "gone" | "unknown" }

const observeProcess = async (pid: number): Promise<ProcessObservation> => {
  const state = processState(pid)
  if (state !== "alive") return { state }
  const createdAt = await getProcessCreatedAt(pid)
  const command = await getProcessCommand(pid)
  const cwd = await getProcessCwd(pid)
  const confirmedCreatedAt = await getProcessCreatedAt(pid)
  // A failed/empty query, including a missing POSIX cwd, says nothing about
  // whether this process exited. Only a successful, coherent snapshot is proof.
  if (!createdAt || !command || (process.platform !== "win32" && !cwd)
    || createdAt !== confirmedCreatedAt) {
    return { state: processState(pid) === "gone" ? "gone" : "unknown" }
  }
  return { state: "present", identity: { pid, command, cwd, createdAt } }
}

type RelayObservation =
  | { state: "relay"; identity: RelayProcessIdentity }
  | { state: "nonrelay" | "gone" | "unknown" }

const observeRelay = async (pid: number): Promise<RelayObservation> => {
  if (parsePid(pid) === undefined || pid === process.pid) return { state: "nonrelay" }
  const observed = await observeProcess(pid)
  if (observed.state !== "present") return observed
  const state = await verifyCommand(observed.identity.command, observed.identity.cwd)
  return state === "relay" ? { state, identity: observed.identity } : { state }
}

const isRelayPid = async (pid: number): Promise<boolean> => {
  const observed = await observeRelay(pid)
  if (observed.state === "unknown") throw new RelayInspectionError(pid)
  return observed.state === "relay"
}

// "gone" includes a verified replacement: the original process no longer
// occupies this PID. "unknown" must never count as exit or authorize a signal.
type RelayState = "same" | "gone" | "unknown"
const inspectRelay = async (expected: RelayProcessIdentity): Promise<RelayState> => {
  const observed = await observeProcess(expected.pid)
  if (observed.state !== "present") return observed.state
  const current = observed.identity
  if (current.command !== expected.command || current.cwd !== expected.cwd
    || current.createdAt !== expected.createdAt) return "gone"
  // A flattened command needs the same filesystem proof on every observation.
  // Losing that proof cannot establish exit or authorize the next signal.
  return await verifyCommand(current.command, current.cwd) === "relay" ? "same" : "unknown"
}

/**
 * The relay serving `config.port`, or undefined if nothing is.
 *
 * Deliberately narrower than findRelayProcessIds: it never consults the global
 * process list. `stop` wants "any relay anywhere" so it can clean up strays;
 * `status` is asked about one configured relay, and answering with a different
 * one is worse than answering "not running" because it looks authoritative.
 *
 * Returns pid and address as a single coherent record, so a pid discovered one
 * way can never be printed next to an address taken from another.
 */
export const findRelayOnPort = async (
  config: Pick<ProxyConfig, "host" | "port">,
): Promise<RelayPidFile | undefined> => {
  // The pid file is preferred when it describes this port: it is the only
  // source carrying host and startedAt, and its port is where the socket is
  // actually bound - hot reload changes config.port without rebinding.
  const entry = await readRelayPidFileEntry()
  if (
    entry
    && entry.port === config.port
    && isProcessAlive(entry.pid)
    && (await isRelayPid(entry.pid))
  ) {
    return entry
  }

  // No usable pid file - fall back to whoever holds the port. Covers a relay
  // started before pid files, or one whose pid file was removed. No version
  // here on purpose: nothing in this path knows the daemon's build, and
  // borrowing the caller's would recreate #43.
  for (const pid of await getPortListenerPids(config.port)) {
    if (await isRelayPid(pid)) {
      return {
        host: config.host,
        pid,
        port: config.port,
        startedAt: "",
      }
    }
  }

  return undefined
}

const findRelayProcesses = async (
  config: Partial<Pick<ProxyConfig, "port">>,
  snapshot: PidSnapshot | undefined,
): Promise<Array<RelayProcessIdentity>> => {
  const candidates = new Set<number>()
  const storedPid = pidFromContent(snapshot?.raw)
  if (storedPid) candidates.add(storedPid)

  if (typeof config.port === "number" && Number.isInteger(config.port)
    && config.port > 0 && config.port <= 65_535) {
    for (const pid of await getPortListenerPids(config.port)) candidates.add(pid)
  }

  for (const { command, pid } of await getProcessList()) {
    if (pid === process.pid) continue
    // A recognizable inventory row is only a candidate; do not discard it when
    // its subsequent cwd/command/creation query is unavailable.
    if (isRelayStartProcess(command) || flatInvocation(command)
      || isRelayStartProcess(command, "/copilot-relay") || packagedEntryCandidate(command)) candidates.add(pid)
  }

  const relays: Array<RelayProcessIdentity> = []
  for (const pid of candidates) {
    const deadline = Date.now() + stopTimeoutMs
    let observed = await observeRelay(pid)
    while (observed.state === "unknown" && Date.now() < deadline) {
      await sleep(stopPollMs)
      observed = await observeRelay(pid)
    }
    if (observed.state === "unknown") throw new RelayInspectionError(pid)
    if (observed.state === "relay") relays.push(observed.identity)
  }
  return relays.sort((left, right) => left.pid - right.pid)
}

export const findRelayProcessIds = async (
  config: Partial<Pick<ProxyConfig, "port">> = {},
): Promise<Array<number>> =>
  (await findRelayProcesses(config, await readPidSnapshot())).map(({ pid }) => pid)

const waitForRelay = async (
  identity: RelayProcessIdentity,
  until: "verified" | "gone",
): Promise<Exclude<RelayState, "unknown">> => {
  const deadline = Date.now() + stopTimeoutMs
  let state = await inspectRelay(identity)
  while ((state === "unknown" || (until === "gone" && state === "same"))
    && Date.now() < deadline) {
    await sleep(stopPollMs)
    state = await inspectRelay(identity)
  }
  if (state === "unknown") {
    throw new RelayInspectionError(identity.pid)
  }
  return state
}

const stopProcess = async (identity: RelayProcessIdentity): Promise<boolean> => {
  if (await waitForRelay(identity, "verified") === "gone") return false
  const { pid } = identity
  log.info(`Stopping existing copilot-relay process pid=${pid}`)
  try {
    process.kill(pid, "SIGTERM")
  } catch (error) {
    if (isNodeErrno(error) && error.code === "ESRCH") return false
    throw error
  }
  if (await waitForRelay(identity, "gone") === "gone") return true

  // Recheck after the grace period. An unavailable query retries then fails;
  // it neither authorizes KILL nor turns a live process into a stopped result.
  if (await waitForRelay(identity, "verified") === "gone") return true
  log.error(`copilot-relay process pid=${pid} did not stop; forcing termination`)
  try {
    process.kill(pid, "SIGKILL")
  } catch (error) {
    if (isNodeErrno(error) && error.code === "ESRCH") return true
    throw error
  }
  if (await waitForRelay(identity, "gone") !== "gone") {
    throw new Error(`Could not stop copilot-relay process pid=${pid}`)
  }
  return true
}

export const stopExistingRelay = async (
  config: Partial<Pick<ProxyConfig, "port">> = {},
): Promise<Array<number>> => {
  const snapshot = await readPidSnapshot()
  const deadline = Date.now() + stopTimeoutMs
  let relays: Array<RelayProcessIdentity>
  while (true) {
    try {
      relays = await findRelayProcesses(config, snapshot)
      break
    } catch (error) {
      if (!(error instanceof RelayInspectionError) || Date.now() >= deadline) throw error
      await sleep(stopPollMs)
    }
  }
  if (relays.length === 0) log.info("No existing copilot-relay instance found")

  const stopped: Array<number> = []
  for (const relay of relays) {
    if (await stopProcess(relay)) stopped.push(relay.pid)
  }
  // Unknown identity is not proof of exit. Preserve a live PID's record even
  // when discovery could not verify it, or the PID was reused while stopping.
  const storedPid = pidFromContent(snapshot?.raw)
  if (storedPid === undefined || !isProcessAlive(storedPid)) {
    await clearPidSnapshot(snapshot)
  }
  return stopped
}
