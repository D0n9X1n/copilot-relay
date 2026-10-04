// The relay's log entries, read the way a test needs them. The logger files each entry under the
// local date when it is logged, so an entry logged just before midnight stays in that day's file
// while getLogPath() already names the next day's.
import fs from "node:fs/promises"
import path from "node:path"

const datedLogFile = /^copilot-relay\.\d{4}-\d{2}-\d{2}\.log$/

// A file or folder that does not exist yet reads as the fallback, as if nothing were logged there.
const fallbackIfMissing = <T>(fallback: T) => (error: NodeJS.ErrnoException): T => {
  if (error.code !== "ENOENT") {
    throw error
  }

  return fallback
}

/**
 * Every dated log file, oldest first, joined into one string; empty when nothing has been logged.
 *
 * paths.ts loads at the first call rather than with this module, so a suite that redirects its home
 * directory before importing src/ reads its own logs.
 */
export const readLogs = async (): Promise<string> => {
  const { paths } = await import("../../src/lib/paths")
  const names = await fs.readdir(paths.logsDir).catch(fallbackIfMissing<Array<string>>([]))
  const contents = await Promise.all(
    names
      .filter((name) => datedLogFile.test(name))
      .sort()
      .map((name) => fs.readFile(path.join(paths.logsDir, name), "utf8").catch(fallbackIfMissing(""))),
  )

  return contents.join("")
}
