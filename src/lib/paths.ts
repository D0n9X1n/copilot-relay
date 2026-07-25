// File-system layout for config, token cache, logs, and legacy migration paths.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const homeDir = os.homedir()

const appDir = path.join(homeDir, ".copilot-relay")

const legacyGithubTokenPaths = [
  path.join(homeDir, ".copilot-tennel", "github_token"),
  path.join(homeDir, "Library", "Application Support", "copilot-tennel", "github_token"),
  path.join(homeDir, ".local", "share", "copilot-tennel", "github_token"),
  path.join(homeDir, "Library", "Application Support", "copilot-relay", "github_token"),
  path.join(homeDir, ".local", "share", "copilot-relay", "github_token"),
  path.join(homeDir, ".local", "share", "copilot-bridge", "github_token"),
]

const legacyCopilotTokenPaths = [
  path.join(homeDir, ".copilot-tennel", "copilot_token.json"),
  path.join(homeDir, "Library", "Application Support", "copilot-tennel", "copilot_token.json"),
  path.join(homeDir, ".local", "share", "copilot-tennel", "copilot_token.json"),
  path.join(homeDir, "Library", "Application Support", "copilot-relay", "copilot_token.json"),
  path.join(homeDir, ".local", "share", "copilot-relay", "copilot_token.json"),
]

const configPath = path.join(appDir, "config.yaml")
const copilotTokenPath = path.join(appDir, "copilot_token.json")
const githubTokenPath = path.join(appDir, "github_token")
const logsDir = path.join(appDir, "logs")
const logFileBaseName = "copilot-relay"
// Pre-rotation installs wrote every line to this single undated file. Retention
// still sweeps it, so upgrading installs drain themselves without manual steps.
const legacyLogPath = path.join(logsDir, `${logFileBaseName}.log`)
const pidPath = path.join(appDir, "copilot-relay.pid")

/**
 * Local-date stamp used in log file names.
 *
 * Local rather than UTC on purpose: `logRetentionDays` is a human-facing "how
 * many days do I keep" setting, and a UTC stamp would roll the active file over
 * in the middle of the local afternoon for anyone west of Greenwich.
 */
export const formatLogDate = (date: Date): string =>
  [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-")

/**
 * Path of the log file that owns `date`. Resolved per write rather than cached,
 * so a long-running relay rotates at local midnight with no timer to drift.
 */
export const getLogPath = (date: Date = new Date()): string =>
  path.join(logsDir, `${logFileBaseName}.${formatLogDate(date)}.log`)

export const paths = {
  appDir,
  configPath,
  copilotTokenPath,
  githubTokenPath,
  legacyConfigPaths: [
    path.join(homeDir, ".copilot-relay.yaml"),
    path.join(homeDir, ".copilot-tennel", "config.yaml"),
    path.join(homeDir, ".copilot-tennel.yaml"),
  ],
  legacyCopilotTokenPaths,
  legacyLogPath,
  logFileBaseName,
  logsDir,
  pidPath,
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(paths.appDir, { recursive: true })
  // GitHub tokens are plain text and safe to migrate here. Copilot token
  // migration is handled in auth.ts because that cache has a JSON schema.
  await ensureFile(paths.githubTokenPath, {
    legacyPaths: legacyGithubTokenPaths,
  })
}

async function ensureFile(
  filePath: string,
  options: { legacyPaths?: Array<string> } = {},
): Promise<void> {
  try {
    await fs.access(filePath, fs.constants.W_OK)
  } catch {
    for (const legacyPath of options.legacyPaths ?? []) {
      if (legacyPath === filePath) {
        continue
      }

      try {
        const content = await fs.readFile(legacyPath, "utf8")
        if (content.trim()) {
          await fs.writeFile(filePath, content, { mode: 0o600 })
          await fs.chmod(filePath, 0o600)
          return
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error
        }
      }
    }

    await fs.writeFile(filePath, "")
    await fs.chmod(filePath, 0o600)
  }
}