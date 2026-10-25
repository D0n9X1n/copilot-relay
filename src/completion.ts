// `copilot-relay completion`: prints a shell completion script, and the configured models the script
// completes model options with.
import { defineCommand } from "citty"

import { auth } from "./auth"
import { cache } from "./cache"
import { models } from "./models"
import { replay } from "./replay"
import { restart } from "./restart"
import { setup } from "./setup"
import { start } from "./start"
import { status } from "./status"
import { stop } from "./stop"
import { usage } from "./usage"
import { setupTargets } from "~/lib/client-setup"
import {
  buildCompletionSpec as buildSpec,
  completionModels,
  completionShells,
  isCompletionShell,
  renderCompletion,
  type CompletionHints,
  type CompletionSource,
  type CompletionSpec,
} from "~/lib/completion"

// The values a shell can offer for an option or positional argument whose values are known.
const completionHints: CompletionHints = {
  "setup <>": { kind: "words", words: [...setupTargets] },
  "completion <>": { kind: "words", words: [...completionShells] },
  "replay <>": { kind: "directories" },
  "models --model": { kind: "models" },
  "cache --model": { kind: "models" },
  "cache --since": { kind: "words", words: ["6h", "24h", "2d", "7d"] },
}

export const completion = defineCommand({
  meta: {
    name: "completion",
    description: `Print a shell completion script for ${completionShells.join(", ")}.`,
  },
  args: {
    shell: {
      type: "positional",
      required: false,
      description: `Shell to complete: ${completionShells.join(", ")}.`,
    },
    models: {
      type: "boolean",
      description: "Print gptModel and opusModel from config.yaml, one per line, for a completion script.",
    },
  },
  async run({ args }) {
    if (args.models) {
      for (const model of await completionModels()) {
        console.log(model)
      }

      return
    }

    const shell = typeof args.shell === "string" ? args.shell : ""
    if (!isCompletionShell(shell)) {
      console.error(`Name a shell: copilot-relay completion <${completionShells.join("|")}>.`)
      process.exitCode = 1
      return
    }

    process.stdout.write(renderCompletion(shell, await buildCompletionSpec()))
  },
})

// The commands src/main.ts registers, completion included. A test checks this list against
// main.ts, which cannot be imported here because importing it runs the CLI.
const completionCommands = (): Record<string, CompletionSource> => ({
  auth,
  cache,
  models,
  replay,
  restart,
  setup,
  start,
  status,
  stop,
  usage,
  completion,
} as Record<string, CompletionSource>)

export const buildCompletionSpec = async (): Promise<CompletionSpec> =>
  buildSpec(completionCommands(), completionHints)
