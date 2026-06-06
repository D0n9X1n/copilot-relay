// Reads package.json version from either source or bundled dist layouts.
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

interface PackageJson {
  name?: string
  version?: string
}

const packageName = "copilot-relay"

const readPackageVersion = (): string => {
  let currentDir = dirname(fileURLToPath(import.meta.url))

  while (true) {
    try {
      const packageJsonPath = resolve(currentDir, "package.json")
      const packageJson = JSON.parse(
        readFileSync(packageJsonPath, "utf8"),
      ) as PackageJson

      if (
        packageJson.name === packageName
        && typeof packageJson.version === "string"
      ) {
        return packageJson.version
      }
    } catch {
      // Keep walking upward; source and dist builds sit at different depths.
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      return "unknown"
    }

    currentDir = parentDir
  }
}

export const appVersion = readPackageVersion()
