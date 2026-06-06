#!/usr/bin/env node

import { defineCommand, runMain } from "citty"

import { auth } from "./auth"
import { start } from "./start"

const main = defineCommand({
  meta: {
    name: "copilot-relay",
    description:
      "Small GitHub Copilot proxy for Claude Code.",
  },
  subCommands: { auth, start },
})

await runMain(main)
