// `copilot-relay usage`: the Copilot plan and quota GitHub reports for the stored GitHub token.
import { defineCommand } from "citty"

import { colorEnabled, terminalText } from "~/lib/terminal"
import { CopilotUsageError, loadCopilotUsage, renderCopilotUsage } from "~/lib/usage"

export const usage = defineCommand({
  meta: {
    name: "usage",
    description: "Show the Copilot plan and quota GitHub reports for the stored GitHub token.",
  },
  args: {
    json: {
      description: "Print the plan and quota fields as a JSON object.",
      type: "boolean",
    },
  },
  async run({ args }) {
    try {
      const report = await loadCopilotUsage()

      // stdout, never the logger: this command writes no file, the log included.
      if (args.json) {
        console.log(JSON.stringify(report, null, 2))
      } else {
        console.log(renderCopilotUsage(report, colorEnabled()).join("\n"))
      }
    } catch (error) {
      // Reported here rather than thrown. citty prints a thrown error with consola.error, which
      // src/lib/log.ts also writes to the log file. loadCopilotUsage turns every failure it expects
      // into a CopilotUsageError. Any other error is named but not quoted, so no text it carries
      // reaches the terminal.
      if (error instanceof CopilotUsageError) {
        console.error(error.message)
      } else {
        const name = error instanceof Error ? error.name : typeof error
        console.error(terminalText(`Could not show the Copilot usage: unexpected ${name}.`))
      }

      process.exitCode = 1
    }
  },
})
