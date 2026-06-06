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
}

export async function ensurePaths(): Promise<void> {
  await fs.mkdir(paths.appDir, { recursive: true })
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