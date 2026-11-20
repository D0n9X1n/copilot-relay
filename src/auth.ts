// `copilot-relay auth`: performs an explicit device-login flow and syncs tokens.
import { defineCommand } from "citty"

import { setupProxyAuth } from "~/lib/auth"
import { readAppConfig } from "~/lib/app-config"
import { readProxyConfig } from "~/lib/config"
import { log } from "~/lib/log"
import { configureUpstreamDispatcher } from "~/lib/upstream-dispatcher"

// The user lookup is best effort: sign-in has already succeeded when it fails or times out.
export const authOutcomeLine = (login: string | undefined): string =>
  login ? `Logged in as ${login}` : "Logged in; GitHub user unavailable"

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Run GitHub device auth and cache credentials for copilot-relay.",
  },
  async run() {
    const appConfig = await readAppConfig()

    // Before the first GitHub call: device login is how a user behind a proxy first signs in.
    configureUpstreamDispatcher(appConfig.upstreamProxy)

    const config = readProxyConfig(appConfig)

    config.copilotToken = undefined

    const authSession = await setupProxyAuth(config, {
      force: true,
    })

    log.info(authOutcomeLine(await authSession.githubLogin))
    log.info("copilot-relay auth completed")
  },
})
