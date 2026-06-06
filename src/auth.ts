import { defineCommand } from "citty"

import { setupProxyAuth } from "~/lib/auth"
import { readAppConfig } from "~/lib/app-config"
import { readProxyConfig } from "~/lib/config"
import { log } from "~/lib/log"

export const auth = defineCommand({
  meta: {
    name: "auth",
    description: "Run GitHub device auth and cache credentials for copilot-relay.",
  },
  args: {
    "show-token": {
      type: "boolean",
      default: false,
      description: "Print GitHub and Copilot tokens during auth.",
    },
  },
  async run({ args }) {
    const config = readProxyConfig(await readAppConfig())

    config.copilotToken = undefined

    const authSession = await setupProxyAuth(config, {
      force: true,
      showToken: args["show-token"],
    })

    if (authSession.githubLogin) {
      log.info(`Logged in as ${authSession.githubLogin}`)
    }

    log.success("copilot-relay auth completed")
  },
})
