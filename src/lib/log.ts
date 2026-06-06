import consola from "consola"

import type { LogLevelName } from "~/lib/app-config"

const consolaLevelByName: Record<LogLevelName, number> = {
  silent: -Infinity,
  error: 0,
  warn: 1,
  info: 3,
  debug: 4,
  trace: 5,
}

export const setLogLevel = (level: LogLevelName): void => {
  consola.level = consolaLevelByName[level]
}

export const log = consola
