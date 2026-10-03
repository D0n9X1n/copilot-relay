// `copilot-relay cache`: prompt-cache hit rate per model and upstream route, read from local logs.
import { defineCommand } from "citty"

import {
  buildCacheReport,
  CacheUsageError,
  defaultGoal,
  renderCacheReport,
  resolveCacheOptions,
} from "~/lib/cache-report"
import { paths } from "~/lib/paths"
import { colorEnabled, terminalText } from "~/lib/terminal"

export const cache = defineCommand({
  meta: {
    name: "cache",
    description: "Show prompt-cache hit rates per model and upstream route, read from local logs.",
  },
  args: {
    hourly: {
      description: "Show the trend by local hour. Covers the last 24 hours unless --since is given.",
      type: "boolean",
    },
    daily: {
      description: "Show the trend by local day. Covers every retained day unless --since is given.",
      type: "boolean",
    },
    since: {
      description:
        "Start of the window: a duration such as 6h or 2d, or an ISO date or time. Without it, the summary covers the last 24 hours.",
      type: "string",
    },
    model: {
      description: "Only count models whose name contains this text, ignoring case.",
      type: "string",
    },
    json: {
      description: "Print the rows as a JSON array.",
      type: "boolean",
    },
    goal: {
      default: String(defaultGoal),
      description: "Hit-rate goal in percent. Rows below it are flagged.",
      type: "string",
    },
  },
  async run({ args }) {
    try {
      const options = resolveCacheOptions(args, new Date())
      const rows = await buildCacheReport(options)

      // stdout, never the logger: this command reads the log file and must not append to it.
      if (args.json) {
        console.log(JSON.stringify(rows, null, 2))
      } else {
        console.log(renderCacheReport(rows, options, colorEnabled()).join("\n"))
      }
    } catch (error) {
      // Reported here rather than thrown. citty prints a thrown error with consola.error, which
      // src/lib/log.ts also writes to the log file, and this command only reads that file.
      if (error instanceof CacheUsageError) {
        console.error(error.message)
      } else {
        const detail = error instanceof Error ? error.message : String(error)
        console.error(terminalText(`Could not build the cache report from ${paths.logsDir}: ${detail}`))
      }

      process.exitCode = 1
    }
  },
})
