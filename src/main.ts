#!/usr/bin/env node

// CLI entrypoint: wires top-level commands without owning runtime behavior.
import { defineCommand, runMain } from "citty"

import { auth } from "./auth"
import { start } from "./start"

const main = defineCommand({
  meta: {
    name: "copilot-relay",
    description:
      "Yet, just another relay for Claude Code to use a GitHub Copilot subscription.",
  },
  subCommands: { auth, start },
})

await runMain(main)
