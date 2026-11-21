import assert from "node:assert/strict"
import test from "node:test"

import { terminalSvg } from "../../scripts/readme-screenshot"

test("terminalSvg draws each colored or bold run as its own span, in a terminal window", () => {
  const svg = terminalSvg(["$ copilot-relay models", "\u001b[1mMODEL\u001b[22m  \u001b[38;2;215;58;58m$10/$50\u001b[0m"], "copilot-relay")

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /<tspan font-weight="bold">MODEL<\/tspan>/)
  assert.match(svg, /<tspan fill="#d73a3a">\$10\/\$50<\/tspan>/)
  assert.ok(svg.includes(">copilot-relay</text>"))
  assert.doesNotMatch(svg, /\u001b/)
})

test("terminalSvg escapes XML and keeps spaces, and maps the 16 named colors and gray", () => {
  const svg = terminalSvg(["a <b> & \"c\"   \u001b[32mok\u001b[0m \u001b[90mnote\u001b[0m \u001b[31mred\u001b[0m"], "t")

  assert.ok(svg.includes("a &lt;b&gt; &amp; &quot;c&quot;"))
  assert.match(svg, /xml:space="preserve"/)
  assert.match(svg, /<tspan fill="#[0-9a-f]{6}">ok<\/tspan>/)
  assert.match(svg, /<tspan fill="#[0-9a-f]{6}">note<\/tspan>/)
})

test("terminalSvg maps 256-color cube indices to their RGB", () => {
  assert.match(terminalSvg(["\u001b[38;5;160mred\u001b[0m"], "t"), /<tspan fill="#d70000">red<\/tspan>/)
  assert.match(terminalSvg(["\u001b[38;5;28mgreen\u001b[0m"], "t"), /<tspan fill="#008700">green<\/tspan>/)
})
