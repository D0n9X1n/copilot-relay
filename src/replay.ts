import fs from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { defineCommand } from "citty"

import type { ProxyConfig } from "./lib/config"
import { withoutLogging } from "./lib/log"
import { paths } from "./lib/paths"
import { isConfiguredReasoningEffort } from "./lib/models"
import { parseModelTokenLimits, type CopilotModel } from "./copilot/models"
import { withRecordedTransport, type CaptureManifest, type CapturedBody } from "./lib/request-trace"
import { withRuntimeState } from "./lib/state"
import { createServer } from "./server"

export interface ReplayResult {
  verdict: "MATCH" | "DIFF" | "INCOMPLETE" | "MISSING" | "MALFORMED"
  exitCode: 0 | 1 | 2
  differences: Array<{ path: string; reason: string }>
  summary?: {
    method: string; path: string; status?: number; routes: string[]; outcome: string
    exchanges: Array<{ order: number; path: string; status?: number; outcome: string; usage: Record<string, number>; refusalCategory?: string }>
    contentBlocks?: string[]; toolCalls?: number
  }
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const clientPaths = new Set(["/v1/messages", "/v1/messages/count_tokens"])
const upstreamPaths = new Set(["/models", "/chat/completions", "/responses", "/v1/messages"])
const headerNames = new Set(["content-type", "accept", "anthropic-version", "anthropic-beta", "claude-beta", "x-request-id", "x-github-request-id", "x-copilot-service-request-id", "retry-after"])
const errorNames = new Set(["Error", "AbortError", "TimeoutError", "TypeError", "SyntaxError"])
const maxMetadataBytes = 16 * 1024 * 1024
const maxBodyBytes = 256 * 1024 * 1024
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value)
const invalid = (): never => { throw new Error("Invalid capture") }
const requireValid: (condition: unknown) => asserts condition = (condition) => { if (!condition) invalid() }
const validError = (value: unknown): boolean => value === undefined || typeof value === "string" && errorNames.has(value)

const validateHeaders = (value: unknown): void => {
  requireValid(record(value) && Object.keys(value).length <= 64)
  for (const [name, content] of Object.entries(value)) {
    requireValid(headerNames.has(name) && typeof content === "string" && content.length <= 16_384 && !/[\r\n\u0000]/.test(content))
  }
  new Headers(value as Record<string, string>)
}

const validateBody = (value: unknown, file: string, complete: boolean): void => {
  requireValid(record(value) && value.file === file && integer(value.bytes) && value.bytes <= maxBodyBytes)
  requireValid(Array.isArray(value.chunks) && value.chunks.length <= 100_000 && value.chunks.every(integer))
  const total = value.chunks.reduce((sum: number, chunk: number) => sum + chunk, 0)
  requireValid(complete ? total === value.bytes : total <= value.bytes)
  requireValid(["pending", "complete", "cancelled", "error", "absent"].includes(String(value.state)) && validError(value.error))
  if (value.state === "absent") requireValid(value.bytes === 0 && value.chunks.length === 0)
}

const validateManifest = (value: unknown): CaptureManifest => {
  requireValid(record(value) && value.format === 1 && typeof value.requestId === "string" && uuid.test(value.requestId))
  requireValid(text(value.relayVersion) && typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt)))
  requireValid(value.method === "POST" && typeof value.path === "string" && clientPaths.has(value.path))
  requireValid(["pending", "complete", "incomplete"].includes(String(value.captureState)) && typeof value.handlerSettled === "boolean")
  requireValid(value.captureError === undefined || text(value.captureError))
  validateHeaders(value.headers)
  const complete = value.captureState === "complete" && !value.captureError
  validateBody(value.request, "client-request.bin", complete)
  if (value.response !== undefined) validateBody(value.response, "client-response.bin", complete)
  if (value.status !== undefined) requireValid(integer(value.status) && value.status >= 200 && value.status <= 599)
  if (value.responseHeaders !== undefined) validateHeaders(value.responseHeaders)
  requireValid(Array.isArray(value.exchanges) && Array.isArray(value.refreshes) && value.exchanges.length + value.refreshes.length <= 10_000)
  const orders: number[] = []
  for (const exchange of value.exchanges) {
    requireValid(record(exchange) && integer(exchange.order) && exchange.order > 0 && text(exchange.upstreamRequestId))
    requireValid(typeof exchange.path === "string" && upstreamPaths.has(exchange.path) && exchange.method === (exchange.path === "/models" ? "GET" : "POST"))
    validateHeaders(exchange.requestHeaders)
    validateBody(exchange.request, `upstream-${exchange.order}-request.bin`, complete)
    if (exchange.response !== undefined) validateBody(exchange.response, `upstream-${exchange.order}-response.bin`, complete)
    if (exchange.status !== undefined) requireValid(integer(exchange.status) && exchange.status >= 200 && exchange.status <= 599)
    if (exchange.responseHeaders !== undefined) validateHeaders(exchange.responseHeaders)
    requireValid(validError(exchange.error) && (exchange.discarded === undefined || typeof exchange.discarded === "boolean"))
    if (exchange.error !== undefined) requireValid(exchange.response === undefined && exchange.status === undefined)
    orders.push(exchange.order)
  }
  for (const refresh of value.refreshes) {
    requireValid(record(refresh) && integer(refresh.order) && refresh.order > 0)
    requireValid(["success", "failure", "cancelled"].includes(String(refresh.outcome)) && validError(refresh.error))
    orders.push(refresh.order)
  }
  orders.sort((a, b) => a - b)
  requireValid(orders.every((order, index) => order === index + 1))
  if (value.abort !== undefined) {
    requireValid(record(value.abort) && integer(value.abort.exchange) && integer(value.abort.upstreamBytes) && integer(value.abort.clientBytes) && validError(value.abort.error))
  }
  const config = value.config
  requireValid(record(config) && text(config.host) && integer(config.port) && config.port <= 65_535)
  requireValid(integer(config.upstreamTimeoutMs) && config.upstreamTimeoutMs <= 2_147_483_647 && text(config.vsCodeVersion))
  requireValid(config.webSearchBackend === undefined || typeof config.webSearchBackend === "string" && config.webSearchBackend.length <= 1024)
  requireValid(config.claudeUpstreamApi === undefined || ["auto", "messages", "chat-completions"].includes(String(config.claudeUpstreamApi)))
  const runtime = value.runtime
  requireValid(record(runtime) && (runtime.debug === undefined || typeof runtime.debug === "boolean"))
  requireValid(runtime.thinkEffort === undefined || isConfiguredReasoningEffort(runtime.thinkEffort))
  if (runtime.modelRouting !== undefined) requireValid(record(runtime.modelRouting) && text(runtime.modelRouting.gptModel) && text(runtime.modelRouting.opusModel))
  requireValid(runtime.catalogCurrent === undefined || typeof runtime.catalogCurrent === "boolean")
  if (runtime.models !== undefined) {
    requireValid(Array.isArray(runtime.models) && runtime.models.length <= 10_000)
    const ids = new Set<string>()
    for (const entry of runtime.models) {
      requireValid(Array.isArray(entry) && entry.length === 2 && text(entry[0]) && record(entry[1]) && !ids.has(entry[0]))
      ids.add(entry[0])
      const model = entry[1]
      requireValid(model.limits === undefined || parseModelTokenLimits(model.limits) !== undefined)
      for (const field of ["tokenizer", "type"]) requireValid(model[field] === undefined || text(model[field]))
      for (const field of ["supportedEndpoints", "reasoningEfforts"]) requireValid(model[field] === undefined || Array.isArray(model[field]) && model[field].every(text))
    }
  }
  return value as unknown as CaptureManifest
}

const safeDirectory = async (directory: string): Promise<string> => {
  const absolute = path.resolve(directory)
  const root = path.parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    const info = await fs.lstat(current)
    // macOS exposes these OS-owned aliases even for normal os.tmpdir paths.
    const systemAlias = process.platform === "darwin" && ["/var", "/tmp", "/etc"].includes(current)
      && await fs.realpath(current) === `/private${current}`
    requireValid(info.isDirectory() && !info.isSymbolicLink() || systemAlias)
  }
  return fs.realpath(absolute)
}

const resolveCapture = async (target: string): Promise<string> => {
  if (!uuid.test(target)) return safeDirectory(path.resolve(target))
  const root = await safeDirectory(path.join(paths.appDir, "captures"))
  const matches: string[] = []
  for (const date of await fs.readdir(root, { withFileTypes: true })) {
    if (!date.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(date.name)) continue
    const directory = path.join(root, date.name, target)
    try { matches.push(await safeDirectory(directory)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
  }
  if (!matches.length) throw Object.assign(new Error("Capture not found"), { code: "ENOENT" })
  requireValid(matches.length === 1)
  return matches[0]
}

const readCaptureFile = async (directory: string, file: string, maximum: number, optional = false): Promise<Buffer> => {
  const name = path.join(directory, file)
  const before = await fs.lstat(name).catch((error: NodeJS.ErrnoException) => {
    if (optional && error.code === "ENOENT") return undefined
    throw error
  })
  if (!before) return Buffer.alloc(0)
  requireValid(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maximum)
  const handle = await fs.open(name, fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW))
  try {
    const opened = await handle.stat()
    requireValid(opened.isFile() && opened.ino === before.ino && opened.dev === before.dev && opened.size === before.size)
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset)
      requireValid(read.bytesRead > 0)
      offset += read.bytesRead
    }
    const after = await fs.lstat(name)
    requireValid(!after.isSymbolicLink() && after.ino === opened.ino && after.dev === opened.dev && after.size === opened.size && after.mtimeMs === opened.mtimeMs)
    return bytes
  } finally { await handle.close() }
}

const captureBodies = (manifest: CaptureManifest): CapturedBody[] =>
  [manifest.request, manifest.response, ...manifest.exchanges.flatMap((exchange) => [exchange.request, exchange.response])].filter((body): body is CapturedBody => body !== undefined)

// Only protocol-owned keys are printed: tool schemas/inputs can use prompt text
// as property names, so unknown property names are represented by their index.
const protocolKeys = new Set("body method path status model messages role content text type id name input output arguments function tool_calls tool_call_id tool_use_id tools parameters properties required description stream max_tokens max_completion_tokens max_output_tokens reasoning reasoning_effort effort temperature top_p user system data event delta index message content_block usage input_tokens output_tokens cache_read_input_tokens cache_creation_input_tokens server_tool_use web_search_requests stop_reason stop_sequence error code query metadata request_id created created_at".split(" "))
const compare = (expected: unknown, actual: unknown, location: string, differences: ReplayResult["differences"]): void => {
  if (isDeepStrictEqual(expected, actual) || differences.length >= 100) return
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) differences.push({ path: `${location}.length`, reason: "Length differs" })
    for (let index = 0; index < Math.min(expected.length, actual.length); index++) compare(expected[index], actual[index], `${location}[${index}]`, differences)
  } else if (record(expected) && record(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()
    keys.forEach((key, index) => {
      const child = `${location}${protocolKeys.has(key) ? `.${key}` : `[field#${index}]`}`
      if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key)) differences.push({ path: child, reason: "Field presence differs" })
      else compare(expected[key], actual[key], child, differences)
    })
  } else differences.push({ path: location, reason: "Value differs" })
}

const decoded = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: true }).decode(bytes)
const parseBody = (bytes: Uint8Array, contentType: string | undefined): unknown => {
  const value = decoded(bytes)
  if (!contentType?.includes("text/event-stream")) {
    if (!value) return undefined
    try { return JSON.parse(value) } catch { return value }
  }
  const events: Array<{ event: string; data: unknown; id?: string }> = []
  let event = "message"
  let data: string[] = []
  let id: string | undefined
  for (const line of value.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    if (line === "") {
      if (data.length) {
        const raw = data.join("\n")
        let parsed: unknown = raw
        try { parsed = JSON.parse(raw) } catch { /* SSE data may be [DONE] or plain text. */ }
        events.push({ event, data: parsed, ...(id !== undefined && { id }) })
      }
      event = "message"
      data = []
      continue
    }
    if (line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon < 0 ? line : line.slice(0, colon)
    const part = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "")
    if (field === "data") data.push(part)
    else if (field === "event") event = part
    else if (field === "id" && !part.includes("\u0000")) id = part
  }
  requireValid(data.length === 0)
  return events
}

const outcomeSummary = (value: { outcome?: Record<string, unknown> }): string => {
  const outcome = value.outcome
  const stop = outcome?.stop_reason ?? outcome?.finish_reason ?? outcome?.response_status
  return typeof stop === "string" && new Set(["end_turn", "stop", "length", "max_tokens", "tool_use", "tool_calls", "completed", "failed", "cancelled", "incomplete", "refusal", "content_filter"]).has(stop) ? stop : "unreported"
}
const usageSummary = (outcome: Record<string, unknown> | undefined): Record<string, number> => Object.fromEntries(
  ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].flatMap((key) => integer(outcome?.[key]) ? [[key, outcome[key]]] : []),
)
const contentSummary = (value: unknown): { contentBlocks: string[]; toolCalls: number } => {
  const types: unknown[] = []
  if (Array.isArray(value)) {
    for (const event of value) if (record(event) && record(event.data) && event.data.type === "content_block_start" && record(event.data.content_block)) types.push(event.data.content_block.type)
  } else if (record(value) && Array.isArray(value.content)) {
    for (const block of value.content) if (record(block)) types.push(block.type)
  }
  const known = new Set(["text", "thinking", "redacted_thinking", "tool_use", "server_tool_use", "web_search_tool_result"])
  return { contentBlocks: types.slice(0, 100).map((type) => typeof type === "string" && known.has(type) ? type : "unknown"), toolCalls: types.filter((type) => type === "tool_use" || type === "server_tool_use").length }
}

// The only fresh body IDs currently emitted locally are WebSearch's message and
// server-tool IDs. Never normalize provider IDs, tool inputs, schemas, or prose.
const normalizeWebSearchIds = (value: unknown, protectedIds: Set<string>, enabled: boolean, symbols: Map<string, symbol>): unknown => {
  const copy: unknown = structuredClone(value)
  if (!enabled) return copy
  const ids = new Map<string, symbol>()
  const normalize = (id: unknown, prefix: "msg" | "srvtoolu"): unknown => {
    if (typeof id !== "string" || !new RegExp(`^${prefix}_[a-f0-9]{32}$`).test(id) || protectedIds.has(id)) return id
    if (!ids.has(id)) {
      const key = `${prefix}_${ids.size}`
      if (!symbols.has(key)) symbols.set(key, Symbol(key))
      ids.set(id, symbols.get(key)!)
    }
    return ids.get(id)!
  }
  const block = (item: unknown) => {
    if (!record(item)) return
    if (item.type === "server_tool_use" && item.name === "web_search") item.id = normalize(item.id, "srvtoolu")
    if (item.type === "web_search_tool_result") item.tool_use_id = normalize(item.tool_use_id, "srvtoolu")
  }
  const message = (item: unknown) => {
    if (!record(item) || item.type !== "message" || item.role !== "assistant") return
    item.id = normalize(item.id, "msg")
    if (Array.isArray(item.content)) item.content.forEach(block)
  }
  if (Array.isArray(copy)) {
    for (const event of copy) {
      if (!record(event) || !record(event.data)) continue
      if (event.data.type === "message_start") message(event.data.message)
      if (event.data.type === "content_block_start") block(event.data.content_block)
    }
  } else message(copy)
  return copy
}

const recordedError = (name = "Error"): Error => Object.assign(new Error("Recorded transport failure"), { name })
const bodyStream = (body: CapturedBody, bytes: Uint8Array): ReadableStream<Uint8Array> | null => {
  if (body.state === "absent") return null
  let chunk = 0
  let offset = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (chunk === body.chunks.length) { controller.close(); return }
      const length = body.chunks[chunk++]
      controller.enqueue(bytes.slice(offset, offset + length))
      offset += length
    },
  })
}

export const replayCapture = async (target: string): Promise<ReplayResult> => {
  try {
    const directory = await resolveCapture(target)
    const manifest = validateManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readCaptureFile(directory, "meta.json", maxMetadataBytes))))
    if (uuid.test(target)) requireValid(manifest.requestId === target)
    const differences: ReplayResult["differences"] = []
    const summary: NonNullable<ReplayResult["summary"]> = {
      method: manifest.method, path: manifest.path, status: manifest.status, routes: manifest.exchanges.map((exchange) => exchange.path), outcome: outcomeSummary(manifest),
      exchanges: manifest.exchanges.map((exchange) => {
        const category = exchange.outcome?.refusal_category
        return { order: exchange.order, path: exchange.path, status: exchange.status, outcome: outcomeSummary(exchange), usage: usageSummary(exchange.outcome),
          ...(typeof category === "string" && ["cyber", "bio", "reasoning_extraction", "general_harms", "frontier_llm"].includes(category) && { refusalCategory: category }),
        }
      }),
    }
    const bodies = captureBodies(manifest)
    const discarded = new Set(manifest.exchanges.filter((exchange) => (exchange as typeof exchange & { discarded?: boolean }).discarded === true).map((exchange) => exchange.response))
    if (manifest.captureState !== "complete" || !manifest.handlerSettled || manifest.captureError || manifest.abort
      || bodies.some((body) => body.state !== "complete" && body.state !== "absent" && !(body.state === "cancelled" && discarded.has(body)))) {
      return { verdict: "INCOMPLETE", exitCode: 2, summary, differences: [{ path: "capture", reason: "Only complete captures can be replayed" }] }
    }
    requireValid(manifest.response !== undefined && manifest.status !== undefined && manifest.responseHeaders !== undefined)
    requireValid(manifest.exchanges.every((exchange) => exchange.error || exchange.response && exchange.status && exchange.responseHeaders))
    requireValid(bodies.reduce((total, body) => total + body.bytes, 0) <= maxBodyBytes)
    const files = new Map<string, Buffer>()
    for (const body of bodies) {
      const bytes = await readCaptureFile(directory, body.file, body.bytes, body.bytes === 0)
      requireValid(bytes.length === body.bytes)
      files.set(body.file, bytes)
    }
    const catalog = manifest.runtime.models === undefined ? undefined : {
      baseUrl: manifest.runtime.catalogCurrent ? "https://replay.invalid" : "https://old.invalid",
      models: new Map(manifest.runtime.models as Array<[string, CopilotModel]>),
    }
    const config: ProxyConfig = {
      host: "localhost", port: 0, copilotBaseUrl: "https://replay.invalid", copilotToken: "offline-replay-token",
      upstreamTimeoutMs: manifest.config.upstreamTimeoutMs, vsCodeVersion: manifest.config.vsCodeVersion,
      webSearchBackend: manifest.config.webSearchBackend, modelCatalog: catalog,
      refreshCopilotToken: async () => { throw new Error("Unrecorded replay refresh") },
      ...(manifest.config.claudeUpstreamApi && { claudeUpstreamApi: manifest.config.claudeUpstreamApi as ProxyConfig["claudeUpstreamApi"] }),
    }
    const runtime = { modelRouting: manifest.runtime.modelRouting, thinkEffort: manifest.runtime.thinkEffort,
      debug: false, modelCatalog: catalog, upstreamBaseUrl: config.copilotBaseUrl }
    const operations = [
      ...manifest.exchanges.map((exchange) => ({ kind: "fetch" as const, order: exchange.order, exchange })),
      ...manifest.refreshes.map((refresh) => ({ kind: "refresh" as const, order: refresh.order, refresh })),
    ].sort((a, b) => a.order - b.order)
    const expectedClient = parseBody(files.get(manifest.response.file)!, manifest.responseHeaders["content-type"])
    Object.assign(summary, contentSummary(expectedClient))
    const protectedIds = new Set<string>()
    const protect = (value: unknown): void => {
      const pending = [value]
      while (pending.length) {
        const item = pending.pop()
        if (typeof item === "string") for (const match of item.matchAll(/(?:msg|srvtoolu)_[a-f0-9]{32}/g)) protectedIds.add(match[0])
        else if (Array.isArray(item)) pending.push(...item)
        else if (record(item)) pending.push(...Object.values(item))
      }
    }
    // Decode JSON/SSE before identifying provider IDs; escapes do not turn a
    // provider ID into a locally generated one. Plain text is protected too.
    protect(parseBody(files.get(manifest.request.file)!, manifest.headers["content-type"]))
    for (const exchange of manifest.exchanges) {
      protect(parseBody(files.get(exchange.request.file)!, "application/json"))
      if (exchange.response && exchange.response.state !== "cancelled") protect(parseBody(files.get(exchange.response.file)!, exchange.responseHeaders?.["content-type"]))
    }
    const hasWebSearch = manifest.exchanges.some((exchange) => {
      if (exchange.path !== "/responses") return false
      const request = parseBody(files.get(exchange.request.file)!, "application/json")
      return record(request) && Array.isArray(request.tools) && request.tools.some((tool) => record(tool) && tool.type === "web_search_preview")
    })
    const expectedRequests = new Map(manifest.exchanges.map((exchange) => [exchange.order,
      parseBody(files.get(exchange.request.file)!, "application/json")]))
    let index = 0
    const take = (kind: "fetch" | "refresh") => {
      const operation = operations[index++]
      if (!operation || operation.kind !== kind) {
        differences.push({ path: `operations[${index - 1}]`, reason: "Unexpected transport operation" })
        throw new Error("Unrecorded replay operation")
      }
      return operation
    }
    await withoutLogging(() => withRuntimeState(runtime, () => withRecordedTransport({
      requestId: manifest.requestId,
      fetch: async (request) => {
        const operation = take("fetch")
        if (operation.kind !== "fetch") throw new Error("Unrecorded replay attempt")
        const exchange = operation.exchange
        const location = `upstream[${manifest.exchanges.indexOf(exchange)}].request`
        compare(exchange.method, request.method, `${location}.method`, differences)
        compare(exchange.path, request.path, `${location}.path`, differences)
        compare(expectedRequests.get(exchange.order), parseBody(Buffer.from(request.body ?? ""), "application/json"), `${location}.body`, differences)
        if (exchange.error) throw recordedError(exchange.error)
        return new Response(bodyStream(exchange.response!, files.get(exchange.response!.file)!), { status: exchange.status, headers: exchange.responseHeaders })
      },
      refresh: async () => {
        const operation = take("refresh")
        if (operation.kind !== "refresh") throw new Error("Unrecorded replay refresh")
        if (operation.refresh.outcome !== "success") throw recordedError(operation.refresh.error ?? (operation.refresh.outcome === "cancelled" ? "AbortError" : "Error"))
      },
    }, async () => {
      try {
        const response = await createServer(config).fetch(new Request(`http://localhost${manifest.path}`, {
          method: manifest.method, headers: manifest.headers, body: files.get(manifest.request.file),
        }))
        compare(manifest.status, response.status, "client.status", differences)
        const bytes = new Uint8Array(await response.arrayBuffer())
        const symbols = new Map<string, symbol>()
        compare(normalizeWebSearchIds(expectedClient, protectedIds, hasWebSearch, symbols),
          normalizeWebSearchIds(parseBody(bytes, response.headers.get("content-type") ?? undefined), protectedIds, hasWebSearch, symbols), "client.body", differences)
      } catch {
        differences.push({ path: "client", reason: "Handler could not complete replay" })
      }
    })))
    if (index !== operations.length) differences.push({ path: "operations", reason: "Recorded operations remain" })
    return { verdict: differences.length ? "DIFF" : "MATCH", exitCode: differences.length ? 2 : 0, differences, summary }
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
    return {
      verdict: missing ? "MISSING" : "MALFORMED",
      exitCode: 1,
      differences: [{ path: "capture", reason: missing ? "Capture not found" : "Invalid capture" }],
    }
  }
}

export const replay = defineCommand({
  meta: { name: "replay", description: "Replay a captured request offline; compare current translation without network access." },
  args: { target: { type: "positional", required: true, description: "Request ID or capture directory" } },
  async run({ args }) {
    const result = await replayCapture(args.target)
    console.log(result.verdict)
    if (result.summary) {
      const { method, path, status, routes, outcome } = result.summary
      console.log(`${method} ${path} status=${status ?? "unknown"} outcome=${outcome}`)
      console.log(`upstream=${routes.join(" -> ") || "none"}`)
      for (const exchange of result.summary.exchanges) {
        const usage = Object.entries(exchange.usage).map(([key, value]) => `${key}=${value}`).join(" ")
        console.log(`exchange=${exchange.order} path=${exchange.path} status=${exchange.status ?? "unknown"} outcome=${exchange.outcome}${usage ? ` ${usage}` : ""}${exchange.refusalCategory ? ` refusal_category=${exchange.refusalCategory}` : ""}`)
      }
      if (result.summary.contentBlocks) console.log(`client_blocks=${result.summary.contentBlocks.join(",") || "none"} tool_calls=${result.summary.toolCalls ?? 0}`)
    }
    for (const difference of result.differences) console.log(`${difference.path}: ${difference.reason}`)
    process.exitCode = result.exitCode
  },
})
