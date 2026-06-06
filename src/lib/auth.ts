import fs from "node:fs/promises"

import type { ProxyConfig } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { log } from "~/lib/log"
import { paths, ensurePaths } from "~/lib/paths"

const copilotVersion = "0.26.7"
const editorPluginVersion = `copilot-chat/${copilotVersion}`
const userAgent = `GitHubCopilotChat/${copilotVersion}`
const githubApiVersion = "2022-11-28"

const githubApiBaseUrl = "https://api.github.com"
const githubBaseUrl = "https://github.com"
const githubClientId = "Iv1.b507a08c87ecfe98"
const githubAppScopes = ["read:user"].join(" ")

interface DeviceCodeResponse {
  device_code: string
  expires_in: number
  interval: number
  user_code: string
  verification_uri: string
}

interface AccessTokenResponse {
  access_token?: string
}

interface CopilotTokenResponse {
  refresh_in: number
  token: string
}

interface StoredCopilotToken {
  refreshedAt: number
  refreshIn: number
  token: string
}

interface GitHubUserResponse {
  login: string
}

interface AuthOptions {
  force?: boolean
  showToken?: boolean
}

export interface ProxyAuthSession {
  githubLogin?: string
  source: "github-token"
}

let copilotTokenRefreshTimer: ReturnType<typeof setTimeout> | undefined

const standardHeaders = () => ({
  accept: "application/json",
  "content-type": "application/json",
})

const sleep = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const readGitHubToken = async () => {
  await ensurePaths()
  const token = await fs.readFile(paths.githubTokenPath, "utf8")
  return token.trim()
}

const writeGitHubToken = async (token: string) => {
  await ensurePaths()
  await fs.writeFile(paths.githubTokenPath, `${token.trim()}\n`, {
    mode: 0o600,
  })
}

const readStoredCopilotToken = async (): Promise<StoredCopilotToken | undefined> => {
  await ensurePaths()
  try {
    const payload = JSON.parse(
      await fs.readFile(paths.copilotTokenPath, "utf8"),
    ) as Partial<StoredCopilotToken>
    if (
      typeof payload.token === "string"
      && typeof payload.refreshedAt === "number"
      && typeof payload.refreshIn === "number"
    ) {
      return payload as StoredCopilotToken
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error
    }
  }

  for (const legacyPath of paths.legacyCopilotTokenPaths) {
    try {
      const content = await fs.readFile(legacyPath, "utf8")
      const payload = JSON.parse(content) as Partial<StoredCopilotToken>
      if (
        typeof payload.token === "string"
        && typeof payload.refreshedAt === "number"
        && typeof payload.refreshIn === "number"
      ) {
        await fs.writeFile(paths.copilotTokenPath, content, { mode: 0o600 })
        await fs.chmod(paths.copilotTokenPath, 0o600)
        return payload as StoredCopilotToken
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error
      }
    }
  }

  return undefined
}

const writeStoredCopilotToken = async (
  input: CopilotTokenResponse,
): Promise<void> => {
  await ensurePaths()
  const payload: StoredCopilotToken = {
    refreshedAt: Date.now(),
    refreshIn: input.refresh_in,
    token: input.token,
  }
  await fs.writeFile(
    paths.copilotTokenPath,
    `${JSON.stringify(payload, null, 2)}\n`,
    { mode: 0o600 },
  )
}

const getStoredTokenRemainingSeconds = (token: StoredCopilotToken): number => {
  const ageSeconds = Math.floor((Date.now() - token.refreshedAt) / 1000)
  return token.refreshIn - ageSeconds
}

const githubHeaders = (githubToken: string, vsCodeVersion: string) => ({
  ...standardHeaders(),
  authorization: `token ${githubToken}`,
  "editor-plugin-version": editorPluginVersion,
  "editor-version": `vscode/${vsCodeVersion}`,
  "user-agent": userAgent,
  "x-github-api-version": githubApiVersion,
  "x-vscode-user-agent-library-version": "electron-fetch",
})

const getDeviceCode = async (): Promise<DeviceCodeResponse> => {
  const response = await fetch(`${githubBaseUrl}/login/device/code`, {
    method: "POST",
    headers: standardHeaders(),
    body: JSON.stringify({
      client_id: githubClientId,
      scope: githubAppScopes,
    }),
  })

  if (!response.ok) {
    throw new HTTPError("Failed to get device code", response)
  }

  return (await response.json()) as DeviceCodeResponse
}

const pollAccessToken = async (
  deviceCode: DeviceCodeResponse,
): Promise<string> => {
  const sleepDuration = (deviceCode.interval + 1) * 1000

  while (true) {
    const response = await fetch(`${githubBaseUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: standardHeaders(),
      body: JSON.stringify({
        client_id: githubClientId,
        device_code: deviceCode.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })

    if (!response.ok) {
      await sleep(sleepDuration)
      continue
    }

    const json = (await response.json()) as AccessTokenResponse
    if (json.access_token) {
      return json.access_token
    }

    await sleep(sleepDuration)
  }
}

const getGitHubUser = async (
  githubToken: string,
  vsCodeVersion: string,
): Promise<GitHubUserResponse> => {
  const response = await fetch(`${githubApiBaseUrl}/user`, {
    headers: githubHeaders(githubToken, vsCodeVersion),
  })

  if (!response.ok) {
    throw new HTTPError("Failed to get GitHub user", response)
  }

  return (await response.json()) as GitHubUserResponse
}

const getCopilotToken = async (
  githubToken: string,
  vsCodeVersion: string,
): Promise<CopilotTokenResponse> => {
  const response = await fetch(
    `${githubApiBaseUrl}/copilot_internal/v2/token`,
    {
      headers: githubHeaders(githubToken, vsCodeVersion),
    },
  )

  if (!response.ok) {
    throw new HTTPError("Failed to get Copilot token", response)
  }

  return (await response.json()) as CopilotTokenResponse
}

const isCopilotTokenError = (error: unknown): boolean =>
  error instanceof HTTPError && error.message === "Failed to get Copilot token"

const ensureGitHubToken = async (options: AuthOptions = {}) => {
  const existingToken = options.force ? "" : await readGitHubToken()
  if (existingToken) {
    log.debug(`Using cached GitHub token at ${paths.githubTokenPath}`)
    return existingToken
  }

  const deviceCode = await getDeviceCode()
  log.info(
    `Open ${deviceCode.verification_uri} and enter code ${deviceCode.user_code}`,
  )

  const githubToken = await pollAccessToken(deviceCode)
  await writeGitHubToken(githubToken)
  log.success(`GitHub token synced to ${paths.githubTokenPath}`)

  if (options.showToken) {
    log.info("GitHub token:", githubToken)
  }

  return githubToken
}

const loadGitHubLogin = async (
  githubToken: string,
  vsCodeVersion: string,
): Promise<string | undefined> => {
  try {
    const user = await getGitHubUser(githubToken, vsCodeVersion)
    return user.login
  } catch (error) {
    log.warn("Could not load GitHub user:", error)
    return undefined
  }
}

export const setupProxyAuth = async (
  config: ProxyConfig,
  options: AuthOptions = {},
): Promise<ProxyAuthSession> => {
  let githubToken = await ensureGitHubToken(options)
  const applyCopilotToken = async () => {
    const tokenResponse = await getCopilotToken(
      githubToken,
      config.vsCodeVersion,
    )

    config.copilotToken = tokenResponse.token
    await writeStoredCopilotToken(tokenResponse)
    if (options.showToken) {
      log.info("Copilot token:", tokenResponse.token)
    }

    return tokenResponse.refresh_in
  }

  const scheduleCopilotTokenRefresh = (refreshIn: number) => {
    if (copilotTokenRefreshTimer) {
      clearTimeout(copilotTokenRefreshTimer)
    }

    const refreshMs = Math.max(refreshIn - 60, 60) * 1000
    log.debug(
      `Next Copilot token refresh in ${Math.round(refreshMs / 1000)}s`,
    )

    copilotTokenRefreshTimer = setTimeout(async () => {
      try {
        const nextRefreshIn = await applyCopilotToken()
        log.debug("Refreshed Copilot token")
        scheduleCopilotTokenRefresh(nextRefreshIn)
      } catch (error) {
        log.error("Failed to refresh Copilot token:", error)
        scheduleCopilotTokenRefresh(60)
      }
    }, refreshMs)

    if (typeof copilotTokenRefreshTimer.unref === "function") {
      copilotTokenRefreshTimer.unref()
    }
  }

  const storedToken = await readStoredCopilotToken()
  let refreshIn: number
  if (storedToken && getStoredTokenRemainingSeconds(storedToken) > 60) {
    config.copilotToken = storedToken.token
    refreshIn = getStoredTokenRemainingSeconds(storedToken)
    log.debug(`Using cached Copilot token at ${paths.copilotTokenPath}`)
  } else {
  try {
    refreshIn = await applyCopilotToken()
  } catch (error) {
    if (options.force || !isCopilotTokenError(error)) {
      throw error
    }

    log.warn(
      "Cached GitHub auth could not get a Copilot token; running device auth again.",
    )
    githubToken = await ensureGitHubToken({
      ...options,
      force: true,
    })
    refreshIn = await applyCopilotToken()
  }
  }
  scheduleCopilotTokenRefresh(refreshIn)

  return {
    githubLogin: await loadGitHubLogin(githubToken, config.vsCodeVersion),
    source: "github-token",
  }
}

export const runProxyAuth = async (
  config: ProxyConfig,
  options: AuthOptions = {},
) => {
  const githubToken = await ensureGitHubToken({
    ...options,
    force: true,
  })

  const user = await getGitHubUser(githubToken, config.vsCodeVersion)
  log.success(`GitHub token written to ${paths.githubTokenPath}`)
  log.info(`Logged in as ${user.login}`)
}