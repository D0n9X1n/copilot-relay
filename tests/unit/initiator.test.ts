import assert from "node:assert/strict"
import test from "node:test"

import { getClaudeRequestInitiator } from "../../src/claude/initiator"

// Request shapes Claude Code 2.1.288 sends, as read from its bundle. Every request ends with a
// system turn holding the token reminder, as tests/unit/chat-route-cache.test.ts models.
const billingLine = "x-anthropic-billing-header: cc_version=2.1.288.976; cc_entrypoint=cli;"
const mainSystem = [{ type: "text", text: billingLine }, { type: "text", text: "You are Claude Code." }]
const tokenReminder = { role: "system", content: "<total_tokens>900 tokens left</total_tokens>" }

const text = (value: string) => ({ type: "text", text: value })
const reminder = (value: string) => text(`<system-reminder>\n${value}\n</system-reminder>`)
const toolResult = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, content })
const stoppedResult = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, is_error: true, content })

const request = (messages: Array<unknown>, system: unknown = mainSystem) => ({
  model: "claude-opus-5.5",
  max_tokens: 1024,
  system,
  messages: [...messages, tokenReminder],
})

// A finished exchange, then the same conversation with the model calling Bash.
const history = [
  { role: "user", content: [reminder("Project instructions."), text("Fix the failing test.")] },
  { role: "assistant", content: [text("Fixed it.")] },
]
const working = [
  ...history,
  { role: "user", content: "Run the tests." },
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "npm test" } }] },
]

const cancelNotice =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
const midTurnMessage = "The user sent a new message while you were working:\nUse the other config.\n\n"
  + "This is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside "
  + "the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn."
const compactPrompt = "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n"
  + "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests."
const resumedSummary = "This session is being continued from a previous conversation that ran out of context. "
  + "The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Fix the failing test."
const taskNotification = reminder("<task-notification>\nThe build finished.\n</task-notification>")

const cases: Array<{ name: string; messages: Array<unknown>; expected: "agent" | "user" }> = [
  { name: "the first prompt of a session", messages: history.slice(0, 1), expected: "user" },
  {
    name: "a later prompt",
    messages: [...history, { role: "user", content: [reminder("The todo list is empty."), text("Now add a test.")] }],
    expected: "user",
  },
  { name: "a later prompt sent as a string", messages: [...history, { role: "user", content: "Now add a test." }], expected: "user" },
  {
    name: "a pasted image without text",
    messages: [...history, { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }] }],
    expected: "user",
  },
  {
    name: "an attached document without text",
    messages: [...history, { role: "user", content: [{ type: "document", source: { type: "text", media_type: "text/plain", data: "Notes" } }] }],
    expected: "user",
  },
  {
    name: "a slash command",
    messages: [...history, { role: "user", content: [text("<command-message>review</command-message>\n<command-name>/review</command-name>")] }],
    expected: "user",
  },
  {
    name: "a message the person sent while the model was working",
    messages: [...working, { role: "user", content: [toolResult("toolu_bash", "1 passing"), text(midTurnMessage)] }],
    expected: "user",
  },
  {
    name: "a prompt typed after interrupting a tool call",
    messages: [
      ...working,
      {
        role: "user",
        content: [
          stoppedResult("toolu_bash", cancelNotice),
          text("[Request interrupted by user for tool use]"),
          text("Run only the unit tests."),
        ],
      },
    ],
    expected: "user",
  },
  {
    name: "a prompt whose delivery stopped a tool call",
    messages: [
      ...working,
      {
        role: "user",
        content: [
          stoppedResult(
            "toolu_bash",
            "[Tool call did not complete: the turn was ended to deliver the message that follows. Nothing refused it; re-run it if still needed.]",
          ),
          text("Run only the unit tests."),
        ],
      },
    ],
    expected: "user",
  },
  {
    name: "a prompt typed after interrupting a reply",
    messages: [
      ...history,
      { role: "user", content: "Explain the fix." },
      { role: "assistant", content: [text("The fix changes")] },
      { role: "user", content: [text("[Request interrupted by user]"), text("Summarize it instead.")] },
    ],
    expected: "user",
  },
  {
    name: "a prompt typed after a manual compaction",
    messages: [
      {
        role: "user",
        content: [
          text(resumedSummary),
          text("<local-command-stdout>Compacted</local-command-stdout>"),
          text("Now run the tests."),
        ],
      },
    ],
    expected: "user",
  },
  { name: "a tool result", messages: [...working, { role: "user", content: [toolResult("toolu_bash", "1 passing")] }], expected: "agent" },
  {
    name: "a tool result with a reminder",
    messages: [...working, { role: "user", content: [toolResult("toolu_bash", "1 passing"), reminder("a.ts changed on disk.")] }],
    expected: "agent",
  },
  {
    name: "a skill's body after the Skill tool",
    messages: [
      ...history,
      { role: "user", content: "Review this." },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_skill", name: "Skill", input: { skill: "review" } }] },
      {
        role: "user",
        content: [
          toolResult("toolu_skill", "Launching skill: review"),
          text("Base directory for this skill: /skills/review\n\n# Review\nCheck the diff."),
        ],
      },
    ],
    expected: "agent",
  },
  { name: "a background task notification", messages: [...history, { role: "user", content: [taskNotification] }], expected: "agent" },
  {
    name: "a task notification after an interrupted tool call",
    messages: [
      ...working,
      {
        role: "user",
        content: [stoppedResult("toolu_bash", cancelNotice), text("[Request interrupted by user for tool use]"), taskNotification],
      },
    ],
    expected: "agent",
  },
  {
    name: "Stop hook feedback",
    messages: [...history, { role: "user", content: [text("Stop hook feedback:\nThe goal is not met yet.")] }],
    expected: "agent",
  },
  {
    name: "Stop hook feedback in a reminder",
    messages: [...history, { role: "user", content: [reminder("Stop hook feedback:\nThe goal is not met yet.")] }],
    expected: "agent",
  },
  {
    name: "a reminder nested in another",
    messages: [
      ...history,
      { role: "user", content: [text("<system-reminder>\nStop hook feedback:\n<system-reminder>Hook context.</system-reminder>\nRetry the check.\n</system-reminder>")] },
    ],
    expected: "agent",
  },
  {
    name: "a person's message through a bound thread",
    messages: [
      ...history,
      { role: "user", content: [text("Messages arrived in the bound thread while you were working:\nFix the failing test.\n\nAlso check Windows.")] },
    ],
    expected: "user",
  },
  {
    name: "a person's message through a bound thread beside a tool result",
    messages: [
      ...working,
      { role: "user", content: [toolResult("toolu_bash", "1 passing"), text("A message arrived in the bound thread while you were working:\nCheck Windows too.")] },
    ],
    expected: "user",
  },
  {
    name: "an instruction typed while approving a tool call",
    messages: [...working, { role: "user", content: [toolResult("toolu_bash", "1 passing"), text("Now run the integration tests too.")] }],
    expected: "user",
  },
  {
    name: "a person's message that starts like the compaction guard",
    messages: [...history, { role: "user", content: "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. Explain this traceback." }],
    expected: "user",
  },
  {
    name: "a retry nudge after Claude Code removed the failed response",
    messages: [
      { role: "user", content: "Fix the failing test." },
      { role: "user", content: "The previous response failed to produce a valid tool call. Please retry the tool call now." },
    ],
    expected: "agent",
  },
  {
    name: "a recovery after the output token limit",
    messages: [...history, { role: "user", content: "Output token limit hit. Resume directly from where you stopped." }],
    expected: "agent",
  },
  {
    name: "a recovery after a response was cut off",
    messages: [...history, { role: "user", content: "Your response above was cut off mid-stream. Resume directly from where it stopped." }],
    expected: "agent",
  },
  {
    name: "a message from another Claude session",
    messages: [...history, { role: "user", content: "Another Claude session sent a message:\n<cross-session-message>Check the build.</cross-session-message>" }],
    expected: "agent",
  },
  {
    name: "a teammate's message",
    messages: [{ role: "user", content: "<teammate-message teammate_id=\"team-lead\">Implement the parser.</teammate-message>" }],
    expected: "agent",
  },
  {
    name: "a channel notification",
    messages: [...history, { role: "user", content: "<channel source=\"ci\">The build failed.</channel>" }],
    expected: "agent",
  },
  {
    name: "a hook's blocking error",
    messages: [
      ...history,
      { role: "user", content: [text("Stop hook blocking error from command: \"./goal.sh\": The goal is not met yet.")] },
    ],
    expected: "agent",
  },
  {
    name: "a plugin's message",
    messages: [
      ...history,
      {
        role: "user",
        content: [
          text("The lint plugin sent a message:\nRun the formatter.\n\nThis is how Claude Code surfaces a prompt a plugin "
            + "submits between turns — it starts this turn in the user's place. Address the message above."),
        ],
      },
    ],
    expected: "agent",
  },
  {
    name: "a scheduled task's prompt",
    messages: [
      ...history,
      {
        role: "user",
        content: [
          text("[SCHEDULED TASK - AUTOMATED FIRING OF A CONFIGURED PROMPT]\nThis turn was started automatically by a "
            + "schedule, not typed live by the user.\n\nCheck the deploy."),
        ],
      },
    ],
    expected: "agent",
  },
  {
    name: "a message from another source",
    messages: [...history, { role: "user", content: [text("[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\nThe deploy finished.")] }],
    expected: "agent",
  },
  {
    name: "a retry nudge",
    messages: [
      ...history,
      { role: "user", content: [text("The previous response failed to produce a valid tool call. Please retry the tool call now.")] },
    ],
    expected: "agent",
  },
  {
    name: "the summary that resumes a session after compaction",
    messages: [
      {
        role: "user",
        content: [
          text(`${resumedSummary}\n\nContinue the conversation from where it left off without asking the user any further questions.`),
          reminder("Restored a.ts."),
        ],
      },
    ],
    expected: "agent",
  },
  {
    name: "a compaction request that reuses the main system prompt",
    messages: [...working, { role: "user", content: [toolResult("toolu_bash", "1 passing"), text(compactPrompt)] }],
    expected: "agent",
  },
  { name: "a compaction prompt sent as a string", messages: [...history, { role: "user", content: compactPrompt }], expected: "agent" },
  {
    name: "an assistant prefill",
    messages: [...history, { role: "user", content: "Answer in JSON." }, { role: "assistant", content: "{" }],
    expected: "agent",
  },
  { name: "an empty string", messages: [...history, { role: "user", content: "" }], expected: "agent" },
  { name: "an empty list", messages: [...history, { role: "user", content: [] }], expected: "agent" },
  {
    name: "a string holding only a reminder",
    messages: [...history, { role: "user", content: "<system-reminder>\nA note.\n</system-reminder>" }],
    expected: "agent",
  },
]

for (const { name, messages, expected } of cases) {
  test(`${name} reads as ${expected}`, () => {
    assert.equal(getClaudeRequestInitiator(request(messages)), expected)
  })
}

test("every request from a subagent reads as agent, its first one included", () => {
  const system = [text(`${billingLine} cc_is_subagent=true;`), text("You are a subagent.")]

  assert.equal(getClaudeRequestInitiator(request([{ role: "user", content: "Find the config loader." }], system)), "agent")
})

test("a subagent marker counts only on the billing line", () => {
  for (const system of [
    [text(billingLine), text("cc_is_subagent=true;")],
    [text(`${billingLine}\ncc_is_subagent=true;`)],
    `You are Claude Code. ${billingLine} cc_is_subagent=true;`,
    [text(`${billingLine} xcc_is_subagent=true;`)],
  ]) {
    assert.equal(getClaudeRequestInitiator(request([{ role: "user", content: "Find the config loader." }], system)), "user")
  }
})

test("a dedicated compaction request reads as agent", () => {
  const summarizer = "You are a helpful AI assistant tasked with summarizing conversations."

  for (const system of [[text(billingLine), text(summarizer)], `${billingLine}\n${summarizer}`]) {
    assert.equal(getClaudeRequestInitiator(request([...history, { role: "user", content: "Summarize." }], system)), "agent")
  }
})

test("system turns are skipped wherever they fall in the turn", () => {
  const effortControl = { role: "system", content: "", output_config: { effort: "high" } }

  assert.equal(getClaudeRequestInitiator(request([...history, { role: "user", content: "Now add a test." }, effortControl])), "user")
  assert.equal(
    getClaudeRequestInitiator(request([...history, { role: "system", content: "Operator note." }, { role: "user", content: "Now add a test." }])),
    "user",
  )
  assert.equal(
    getClaudeRequestInitiator(request([...working, { role: "user", content: [toolResult("toolu_bash", "1 passing")] }, effortControl])),
    "agent",
  )
})

test("a malformed body reads as agent without throwing", () => {
  for (const body of [
    undefined,
    null,
    "text",
    1,
    [],
    {},
    { messages: "x" },
    { messages: [null, 1, "x"] },
    { messages: [{ role: "user" }] },
    { system: [null, { type: "text" }], messages: [{ role: "user", content: [null, { type: "text" }] }] },
  ]) {
    assert.equal(getClaudeRequestInitiator(body), "agent")
  }
})

test("the scheduler's cron jobs and session titles read as agent", () => {
  const cron = [text(`${billingLine} cc_workload=cron;`), text("You are Claude Code.")]
  const title = [text(billingLine), text("You are naming a coding session from its first messages.")]

  assert.equal(getClaudeRequestInitiator(request([{ role: "user", content: "Check the deploy." }], cron)), "agent")
  assert.equal(getClaudeRequestInitiator(request([{ role: "user", content: "<session>Fix the failing test.</session>" }], title)), "agent")
})
