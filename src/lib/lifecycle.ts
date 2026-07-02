// Process lifecycle helpers for stopping stale local relay instances.
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { promisify } from "node:util"

import type { ProxyConfig } from "~/lib/config"
import { log } from "~/lib/log"
import { paths } from "~/lib/paths"

const execFileAsync = promisify(execFile)
const stopTimeoutMs = 5_000
const stopPollMs = 100

interface RelayPidFile {
  host: string
  pid: number
  port: number
  startedAt: string
}

const isNodeErrno = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const parsePid = (value: unknown): number | undefined => {
  const pid =
    typeof value === "number" ? value
    : typeof value === "string" ? Number.parseInt(value.trim(), 10)
    : Number.NaN

  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

const readCommandOutput = async (
  file: string,
  args: Array<string>,
): Promise<string> => {
  try {
    const { stdout } = await execFileAsync(file, args, {
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    return String(stdout)
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "stdout" in error
      && (typeof error.stdout === "string" || Buffer.isBuffer(error.stdout))
    ) {
      return String(error.stdout)
    }
    return ""
  }
}

const parsePidLines = (output: string): Array<number> =>
  output
    .split(/\r?\n/)
    .map((line) => parsePid(line))
    .filter((pid): pid is number => pid !== undefined)

export const isRelayStartProcess = (
  command: string,
  cwd?: string,
): boolean => {
  const normalizedCommand = command.replaceAll("\\", "/")
  const normalizedCwd = cwd?.replaceAll("\\", "/")
  const hasStartArg = /(?:^|\s)start(?:\s|$)/.test(normalizedCommand)

  if (!hasStartArg) {
    return false
  }

  if (normalizedCommand.includes("copilot-relay")) {
    return true
  }

  const usesNode = /(?:^|\s|\/)node(?:\.exe)?(?:\s|$)/i.test(normalizedCommand)
  const usesDistMain = /(?:^|\s|\/)dist\/main\.js(?:\s|$)/.test(
    normalizedCommand,
  )

  return Boolean(
    usesNode
    && usesDistMain
    && normalizedCwd
    && normalizedCwd.split("/").some((part) => part.includes("copilot-relay")),
  )
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isNodeErrno(error) && error.code === "EPERM"
  }
}

const readRelayPidFile = async (): Promise<number | undefined> => {
  try {
    const content = await fs.readFile(paths.pidPath, "utf8")
    const trimmed = content.trim()
    if (!trimmed) {
      return undefined
    }

    if (trimmed.startsWith("{")) {
      const payload = JSON.parse(trimmed) as Partial<RelayPidFile>
      return parsePid(payload.pid)
    }

    return parsePid(trimmed)
  } catch (error) {
    if (isNodeErrno(error) && error.code === "ENOENT") {
      return undefined
    }
    throw error
  }
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
  }
  await fs.writeFile(paths.pidPath, `${JSON.stringify(payload, null, 2)}\n`, {
    mode: 0o600,
  })
}

export const clearRelayPidFile = async (
  pid = process.pid,
  options: { force?: boolean } = {},
): Promise<void> => {
  const currentPid = await readRelayPidFile()
  if (!options.force && currentPid !== undefined && currentPid !== pid) {
    return
  }

  await fs.unlink(paths.pidPath).catch((error: unknown) => {
    if (!isNodeErrno(error) || error.code !== "ENOENT") {
      throw error
    }
  })
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
    ]))
  }

  return parsePidLines(await readCommandOutput("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
    "-t",
  ]))
}

const getProcessList = async (): Promise<Array<{ command: string; pid: number }>> => {
  const output =
    process.platform === "win32" ?
      await readCommandOutput("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
      ])
    : await readCommandOutput("ps", ["-axo", "pid=,command="])

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

const isRelayPid = async (pid: number): Promise<boolean> => {
  if (pid === process.pid || !isProcessAlive(pid)) {
    return false
  }

  const command = await getProcessCommand(pid)
  if (!command) {
    return false
  }

  return isRelayStartProcess(command, await getProcessCwd(pid))
}

const findRelayProcessIds = async (
  config: Pick<ProxyConfig, "port">,
): Promise<Array<number>> => {
  const candidates = new Set<number>()
  const storedPid = await readRelayPidFile()
  if (storedPid) {
    candidates.add(storedPid)
  }

  for (const pid of await getPortListenerPids(config.port)) {
    candidates.add(pid)
  }

  for (const { command, pid } of await getProcessList()) {
    if (pid === process.pid) {
      continue
    }

    if (command.includes("copilot-relay") || command.includes("dist/main.js")) {
      const cwd = await getProcessCwd(pid)
      if (isRelayStartProcess(command, cwd)) {
        candidates.add(pid)
      }
    }
  }

  const relayPids: Array<number> = []
  for (const pid of candidates) {
    if (await isRelayPid(pid)) {
      relayPids.push(pid)
    }
  }
  return [...new Set(relayPids)].sort((left, right) => left - right)
}

const waitForExit = async (pid: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true
    }
    await sleep(stopPollMs)
  }
  return !isProcessAlive(pid)
}

const stopProcess = async (pid: number): Promise<void> => {
  if (!isProcessAlive(pid)) {
    return
  }

  log.info(`Stopping existing copilot-relay process pid=${pid}`)
  process.kill(pid, "SIGTERM")
  if (await waitForExit(pid, stopTimeoutMs)) {
    return
  }

  log.error(`copilot-relay process pid=${pid} did not stop; forcing termination`)
  process.kill(pid, "SIGKILL")
  if (!(await waitForExit(pid, stopTimeoutMs))) {
    throw new Error(`Could not stop copilot-relay process pid=${pid}`)
  }
}

export const stopExistingRelay = async (
  config: Pick<ProxyConfig, "port">,
): Promise<Array<number>> => {
  const relayPids = await findRelayProcessIds(config)
  if (relayPids.length === 0) {
    log.info("No existing copilot-relay instance found")
    await clearRelayPidFile(0, { force: true })
    return []
  }

  for (const pid of relayPids) {
    await stopProcess(pid)
  }
  await clearRelayPidFile(0, { force: true })
  return relayPids
}
