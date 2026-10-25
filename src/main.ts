#!/usr/bin/env node

// CLI entrypoint: wires top-level commands without owning runtime behavior.
import { defineCommand, runMain } from "citty"

import { auth } from "./auth"
import { cache } from "./cache"
import { completion } from "./completion"
import { models } from "./models"
import { replay } from "./replay"
import { restart } from "./restart"
import { setup } from "./setup"
import { start } from "./start"
import { status } from "./status"
import { stop } from "./stop"
import { usage } from "./usage"

const main = defineCommand({
  meta: {
    name: "copilot-relay",
    description:
      "Yet, just another relay for Claude Code and Codex to use a GitHub Copilot subscription.",
  },
  subCommands: { auth, cache, models, replay, restart, setup, start, status, stop, usage, completion },
})

await runMain(main)
