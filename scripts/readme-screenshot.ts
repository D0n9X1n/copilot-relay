// Draws the README's terminal screenshot from real `copilot-relay models` output.
//
// Run it with `npm run screenshot`. It starts a stand-in Copilot catalog and GitHub on loopback,
// runs the CLI from src/ in a throwaway home with color forced to 24-bit, and writes the output as an
// SVG terminal window to .github/assets/models.svg. Nothing reaches the network or the real home.
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// GitHub's dark theme, so the window reads as a terminal on a light page or a dark one.
const theme = {
  background: "#0d1117",
  frame: "#161b22",
  border: "#30363d",
  title: "#8b949e",
  text: "#e6edf3",
}

// The 16 named colors as GitHub's dark theme draws them.
const namedColors: Record<number, string> = {
  30: "#484f58", 31: "#ff7b72", 32: "#3fb950", 33: "#d29922", 34: "#58a6ff", 35: "#bc8cff", 36: "#39c5cf", 37: "#b1bac4",
  90: "#6e7681", 91: "#ffa198", 92: "#56d364", 93: "#e3b341", 94: "#79c0ff", 95: "#d2a8ff", 96: "#56d4dd", 97: "#ffffff",
}

const hex = (red: number, green: number, blue: number): string =>
  `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`

// A 256-color index from the 6×6×6 cube or the gray ramp, as xterm defines them.
const cubeColor = (index: number): string => {
  if (index >= 232) {
    const level = 8 + (index - 232) * 10
    return hex(level, level, level)
  }

  const cube = index - 16
  const level = (step: number): number => step === 0 ? 0 : step * 40 + 55
  return hex(level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6))
}

interface Style {
  bold: boolean
  fill?: string
}

// Applies one SGR sequence's parameters to the current style.
const applySgr = (style: Style, parameters: Array<number>): Style => {
  let next = { ...style }

  for (let index = 0; index < parameters.length; index++) {
    const code = parameters[index]

    if (code === 0) {
      next = { bold: false }
    } else if (code === 1) {
      next.bold = true
    } else if (code === 22) {
      next.bold = false
    } else if (code === 39) {
      next.fill = undefined
    } else if (code === 38 && parameters[index + 1] === 5) {
      next.fill = cubeColor(parameters[index + 2])
      index += 2
    } else if (code === 38 && parameters[index + 1] === 2) {
      next.fill = hex(parameters[index + 2], parameters[index + 3], parameters[index + 4])
      index += 4
    } else if (namedColors[code] !== undefined) {
      next.fill = namedColors[code]
    }
  }

  return next
}

const escapeXml = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;")

// One line of terminal text as tspans: each run of text in one style is one span.
const lineSpans = (line: string): string => {
  let style: Style = { bold: false }
  let spans = ""

  for (const part of line.split(/(\u001b\[[\d;]*m)/)) {
    const sgr = /^\u001b\[([\d;]*)m$/.exec(part)

    if (sgr !== null) {
      style = applySgr(style, sgr[1] === "" ? [0] : sgr[1].split(";").map(Number))
    } else if (part !== "") {
      const fill = style.fill === undefined ? "" : ` fill="${style.fill}"`
      const weight = style.bold ? " font-weight=\"bold\"" : ""
      spans += fill === "" && weight === "" ? escapeXml(part) : `<tspan${fill}${weight}>${escapeXml(part)}</tspan>`
    }
  }

  return spans
}

const characterWidth = 8.4
const lineHeight = 19
const padding = 20
const titleBar = 34

/** Terminal lines, with their SGR styling, as an SVG drawing of a terminal window. */
export const terminalSvg = (lines: Array<string>, title: string): string => {
  const columns = Math.max(...lines.map((line) => line.replace(/\u001b\[[\d;]*m/g, "").length))
  const width = Math.ceil(columns * characterWidth + padding * 2)
  const height = titleBar + padding + lines.length * lineHeight + padding / 2
  const dots = ["#ff5f57", "#febc2e", "#28c840"]
    .map((color, index) => `<circle cx="${padding + index * 20}" cy="${titleBar / 2}" r="6" fill="${color}"/>`)
    .join("")
  const text = lines
    .map((line, index) => `<text x="${padding}" y="${titleBar + padding + index * lineHeight}">${lineSpans(line)}</text>`)
    .join("\n    ")

  // The title bar fills the top of the window, and the border is drawn last so nothing covers it.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `  <rect width="${width}" height="${height}" rx="10" fill="${theme.background}"/>`,
    `  <path d="M0 10a10 10 0 0 1 10-10h${width - 20}a10 10 0 0 1 10 10v${titleBar - 10}h-${width}z" fill="${theme.frame}"/>`,
    `  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="none" stroke="${theme.border}"/>`,
    `  ${dots}`,
    `  <text x="${width / 2}" y="${titleBar / 2 + 4}" text-anchor="middle" fill="${theme.title}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="12">${escapeXml(title)}</text>`,
    `  <g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="14" fill="${theme.text}" xml:space="preserve">`,
    `    ${text}`,
    "  </g>",
    "</svg>",
    "",
  ].join("\n")
}

// A catalog shaped like Copilot's, with real prices: hundredths of a dollar per million tokens.
const catalogModel = (id: string, name: string, input: number, output: number, context: number) => ({
  id,
  name,
  supported_endpoints: ["/chat/completions"],
  billing: { token_prices: { batch_size: input === 0 ? 0 : 1_000_000, default: { input_price: input, output_price: output } } },
  capabilities: { type: "chat", limits: { max_context_window_tokens: context, max_prompt_tokens: context - 64_000, max_output_tokens: 64_000 } },
})

const catalog = [
  catalogModel("claude-haiku-5.5", "Claude Haiku 5.5", 10, 50, 200_000),
  catalogModel("claude-opus-5.5", "Claude Opus 5.5", 400, 2000, 1_000_000),
  catalogModel("claude-sonnet-5.5", "Claude Sonnet 5.5", 200, 1000, 1_000_000),
  catalogModel("gpt-4.1", "GPT-4.1", 0, 0, 128_000),
  catalogModel("gpt-5.3-codex", "GPT-5.3 Codex", 175, 1400, 400_000),
  catalogModel("gpt-6-luna", "GPT-6 Luna", 10, 50, 400_000),
  catalogModel("gpt-6.1-terra", "GPT-6.1 Terra", 100, 500, 400_000),
  catalogModel("gpt-6.2-astra", "GPT-6.2 Astra", 800, 4000, 1_050_000),
  catalogModel("grok-4.7", "Grok 4.7", 200, 600, 500_000),
]

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

// The CLI's stdout for `models`, run against the stand-in catalog in a throwaway home.
const modelsOutput = async (): Promise<string> => {
  const network = await import(pathToFileURL(path.join(repoRoot, "tests/fixtures/network.ts")).href)
  const upstream = createServer((_request, response) => {
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ data: catalog }))
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const address = upstream.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  const github = await network.startFakeGitHub((url: URL, _request: unknown, response: unknown) =>
    network.replyJson(response, url.pathname.endsWith("/v2/token") ? { token: "screenshot-fixture-token-000000", refresh_in: 86_400 } : { login: "you" }))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "relay-screenshot-"))

  try {
    const appDir = path.join(home, ".copilot-relay")
    await fs.mkdir(appDir, { recursive: true })
    await fs.writeFile(path.join(appDir, "config.yaml"), [
      `copilotBaseUrl: http://127.0.0.1:${port}`,
      "gptModel: gpt-6.2-astra",
      "opusModel: claude-opus-5.5",
      "claudeSetup: false",
      "codexSetup: false",
      "",
    ].join("\n"))
    await fs.writeFile(path.join(appDir, "github_token"), "screenshot-github-fixture-token-0000\n")
    await fs.writeFile(path.join(appDir, "copilot_token.json"), JSON.stringify({ token: "screenshot-fixture-token-000000", refreshedAt: Date.now(), refreshIn: 86_400 }))

    const entry = path.join(repoRoot, "src/main.ts")
    const script = [
      `const network = await import(${JSON.stringify(pathToFileURL(path.join(repoRoot, "tests/fixtures/network.ts")).href)})`,
      `network.redirectGitHubTo(${JSON.stringify(github.origin)})`,
      "network.refuseExternalConnections()",
      `process.argv = [process.execPath, ${JSON.stringify(entry)}, "models"]`,
      `await import(${JSON.stringify(pathToFileURL(entry).href)})`,
    ].join("\n")
    const env = { ...network.withoutProxyVariables(process.env), HOME: home, USERPROFILE: home, FORCE_COLOR: "3", CONSOLA_LEVEL: "0", LANG: "en_US.UTF-8" }
    delete env.NO_COLOR

    return await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { cwd: repoRoot, env }, (error, stdout) => {
        if (error !== null) {
          reject(error)
          return
        }

        resolve(stdout)
      })
    })
  } finally {
    upstream.close()
    await github.close()
    await fs.rm(home, { recursive: true, force: true })
  }
}

const main = async (): Promise<void> => {
  const output = await modelsOutput()
  // The listing and its config guide, without the trailing blank line.
  const lines = ["\u001b[1m$\u001b[22m copilot-relay models", ...output.trimEnd().split("\n")]
  const target = path.join(repoRoot, ".github/assets/models.svg")

  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, terminalSvg(lines, "copilot-relay models"))
  console.log(`Wrote ${path.relative(repoRoot, target)}`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
