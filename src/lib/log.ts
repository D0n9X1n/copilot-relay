// Central logger: writes to console and ~/.copilot-relay/logs with retention cleanup.
import fs from "node:fs/promises"
import { inspect } from "node:util"

import consola from "consola"

import type { LogLevelName } from "~/lib/app-config"
import { paths } from "~/lib/paths"

const logCleanupCheckIntervalMs = 60 * 60 * 1000
let logRetentionDays = 3
let nextLogCleanupCheckAt = 0

const consolaLevelByName: Record<LogLevelName, number> = {
  error: 0,
  warn: 1,
  info: 3,
  debug: 4,
}

const fileLevelByMethod: Record<string, number> = {
  error: consolaLevelByName.error,
  warn: consolaLevelByName.warn,
  info: consolaLevelByName.info,
  debug: consolaLevelByName.debug,
}

let currentLogLevel = consolaLevelByName.info

export const setLogLevel = (level: LogLevelName): void => {
  currentLogLevel = consolaLevelByName[level]
  consola.level = consolaLevelByName[level]
}

const formatLogValue = (value: unknown): string =>
  typeof value === "string" ? value : inspect(value, { depth: null })

const writeLogFile = async (
  level: string,
  values: Array<unknown>,
): Promise<void> => {
  await fs.mkdir(paths.logsDir, { recursive: true })
  await cleanupLogsIfDue()
  const line = [
    new Date().toISOString(),
    level,
    values.map(formatLogValue).join(" "),
  ].join(" ")
  await fs.appendFile(paths.logPath, `${line}\n`)
}

const cleanupLogsIfDue = async (): Promise<void> => {
  const now = Date.now()
  if (now < nextLogCleanupCheckAt) {
    return
  }

  nextLogCleanupCheckAt = now + logCleanupCheckIntervalMs
  await cleanupLogs(logRetentionDays)
}

const wrapFileLog = <T extends (...args: Array<unknown>) => unknown>(
  level: string,
  fn: T,
): T =>
  ((...args: Array<unknown>) => {
    if ((fileLevelByMethod[level] ?? consolaLevelByName.info) <= currentLogLevel) {
      void writeLogFile(level, args).catch(() => undefined)
    }
    return fn(...args)
  }) as T

consola.error = wrapFileLog("error", consola.error.bind(consola))
consola.warn = wrapFileLog("warn", consola.warn.bind(consola))
consola.info = wrapFileLog("info", consola.info.bind(consola))
consola.debug = wrapFileLog("debug", consola.debug.bind(consola))

export const cleanupLogs = async (retentionDays: number): Promise<void> => {
  logRetentionDays = retentionDays
  await fs.mkdir(paths.logsDir, { recursive: true })
  // Retention uses file mtime rather than per-line timestamps; the active log
  // naturally remains fresh while the long-running proxy keeps appending to it.
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const entries = await fs.readdir(paths.logsDir, { withFileTypes: true })
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map(async (entry) => {
        const filePath = `${paths.logsDir}/${entry.name}`
        const stat = await fs.stat(filePath)
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(filePath)
        }
      }),
  )
}

export const log = consola
