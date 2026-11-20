// `copilot-relay stop`: terminate all detected local relay server instances.
import { defineCommand } from "citty"

import { readAppConfig } from "~/lib/app-config"
import { readProxyConfig } from "~/lib/config"
import { cleanupLogs, log, setLogLevel } from "~/lib/log"
import { stopExistingRelay } from "~/lib/lifecycle"

// The outcome line. When nothing was stopped there is none: the search has already said it found
// no relay.
export const describeStopped = (pids: Array<number>): string | undefined => {
  if (pids.length === 0) {
    return undefined
  }

  return `Stopped copilot-relay (${pids.length === 1 ? "pid" : "pids"} ${pids.join(", ")})`
}

export const stop = defineCommand({
  meta: {
    name: "stop",
    description: "Stop all detected copilot-relay server instances.",
  },
  async run() {
    // A daemon can still be serving its last valid settings after a bad edit.
    // Config is only a port hint for stop; never let it block verified discovery.
    const appConfig = await readAppConfig().catch(() => {
      log.error("Could not read config; stopping only verified relay processes without a port hint.")
      return undefined
    })

    if (appConfig) {
      setLogLevel(appConfig.logLevel)
      await cleanupLogs(appConfig.logRetentionDays).catch(() => {
        log.error("Could not clean up logs; continuing to stop verified relay processes.")
      })
    }

    const stopped = await stopExistingRelay(appConfig ? readProxyConfig(appConfig) : {})
    const outcome = describeStopped(stopped)
    if (outcome !== undefined) {
      log.info(outcome)
    }
  },
})
