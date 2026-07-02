// `copilot-relay stop`: terminate all detected local relay server instances.
import { defineCommand } from "citty"

import { readAppConfig } from "~/lib/app-config"
import { readProxyConfig } from "~/lib/config"
import { cleanupLogs, log, setLogLevel } from "~/lib/log"
import { stopExistingRelay } from "~/lib/lifecycle"

export const stop = defineCommand({
  meta: {
    name: "stop",
    description: "Stop all detected copilot-relay server instances.",
  },
  async run() {
    const appConfig = await readAppConfig()
    setLogLevel(appConfig.logLevel)
    await cleanupLogs(appConfig.logRetentionDays)

    const stopped = await stopExistingRelay(readProxyConfig(appConfig))
    if (stopped.length > 0) {
      log.info(`Stopped copilot-relay pid(s): ${stopped.join(", ")}`)
    }
  },
})
