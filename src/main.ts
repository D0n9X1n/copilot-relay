#!/usr/bin/env node

// CLI entrypoint: wires top-level commands without owning runtime behavior.
import { defineCommand, runMain } from "citty"

import { auth } from "./auth"
import { cache } from "./cache"
import { models } from "./models"
import { replay } from "./replay"
import { restart } from "./restart"
import { start } from "./start"
import { status } from "./status"
import { stop } from "./stop"
import { usage } from "./usage"

const main = defineCommand({
  meta: {
    name: "copilot-relay",
    description:
      "Yet, just another relay for Claude Code to use a GitHub Copilot subscription.",
  },
  subCommands: { auth, cache, models, replay, restart, start, status, stop, usage },
})

await runMain(main)
