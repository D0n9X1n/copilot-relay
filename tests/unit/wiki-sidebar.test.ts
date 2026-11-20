import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

// GitHub shows wiki/_Sidebar.md beside every page of the Wiki tab. It is the one page with no
// EN/ZH pair: an English group, open, and a 中文 group, folded, each linking every page of its
// language and Home once, so a reader reaches every page from any page.
const wikiDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../wiki")

const pages = fs.readdirSync(wikiDir).filter((name) => name.endsWith(".md") && name !== "_Sidebar.md").sort()
const sidebar = fs.readFileSync(path.join(wikiDir, "_Sidebar.md"), "utf8")

// The <details> blocks in order, each with its opening tag and its body.
const groups = [...sidebar.matchAll(/(<details[^>]*>)\s*<summary><b>([^<]+)<\/b><\/summary>([\s\S]*?)<\/details>/g)]
  .map((match) => ({ tag: match[1], title: match[2], body: match[3] }))

// Every link target in a group, in order, duplicates kept so a repeat fails the test.
const targets = (body: string): Array<string> =>
  [...body.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1])

test("the sidebar has an English group, open, then a 中文 group, folded", () => {
  assert.deepEqual(groups.map((group) => group.title), ["English", "中文"])
  assert.equal(groups[0].tag, "<details open>")
  assert.equal(groups[1].tag, "<details>")
})

test("the English group links Home and every EN- page exactly once", () => {
  const expected = ["README.md", ...pages.filter((name) => name.startsWith("EN-"))].sort()

  assert.deepEqual([...targets(groups[0].body)].sort(), expected)
})

test("the 中文 group links Home and every ZH- page exactly once", () => {
  const expected = ["README.md", ...pages.filter((name) => name.startsWith("ZH-"))].sort()

  assert.deepEqual([...targets(groups[1].body)].sort(), expected)
})

test("every wiki page is reachable from the sidebar", () => {
  const linked = new Set(groups.flatMap((group) => targets(group.body)))

  assert.deepEqual(pages.filter((name) => !linked.has(name)), [])
})
