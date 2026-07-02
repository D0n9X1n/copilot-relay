// `copilot-relay restart`: stop stale local relay processes, then start normally.
import { defineCommand } from "citty"

import { readAppConfig } from "~/lib/app-config"
import { readProxyConfig } from "~/lib/config"
import { cleanupLogs, log, setLogLevel } from "~/lib/log"
import { stopExistingRelay } from "~/lib/lifecycle"
import { startRelay } from "./start"

export const restart = defineCommand({
  meta: {
    name: "restart",
    description: "Stop any existing copilot-relay instance and start a new one.",
  },
  async run() {
    const appConfig = await readAppConfig()
    setLogLevel(appConfig.logLevel)
    await cleanupLogs(appConfig.logRetentionDays)

    const stopped = await stopExistingRelay(readProxyConfig(appConfig))
    if (stopped.length > 0) {
      log.info(`Stopped copilot-relay pid(s): ${stopped.join(", ")}`)
    }
    log.info("Starting copilot-relay")

    await startRelay(appConfig)
  },
})
