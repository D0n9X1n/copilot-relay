import { AsyncLocalStorage } from "node:async_hooks"
import fs, { type FileHandle } from "node:fs/promises"
import type { Stats } from "node:fs"
import path from "node:path"

import type { ProxyConfig } from "./config"
import { log, registerLogSecret } from "./log"
import { formatLogDate, paths } from "./paths"
import type { RuntimeState } from "./state"
import { appVersion } from "./version"

const headerNames = new Set(["content-type", "accept", "anthropic-version", "anthropic-beta", "claude-beta", "x-request-id", "x-github-request-id", "x-copilot-service-request-id", "retry-after"])
const maxQueuedBytes = 8 * 1024 * 1024
const activeCaptures = new Set<string>()
const traceContext = new AsyncLocalStorage<RequestTrace>()
const transportContext = new AsyncLocalStorage<RecordedTransport>()
const traceObserver = new AsyncLocalStorage<(trace: RequestTrace) => void>()
const responseExchanges = new WeakMap<Response, CapturedExchange>()
const pendingCaptures = new Set<Promise<void>>()
let captureRetentionDays = 3
let nextCleanupAt = 0
let pendingCleanup: Promise<void> = Promise.resolve()
export const flushCaptures = async (): Promise<void> => {
  await pendingCleanup
  while (pendingCaptures.size) await Promise.all([...pendingCaptures])
}
export const markDiscardedResponse = (response: Response): void => {
  const exchange = responseExchanges.get(response)
  if (exchange) exchange.discarded = true
}
const credentialPattern = /(?:gh[pousr]_|github_pat_|sk-|eyJ)[A-Za-z0-9_-]+/
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const sameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
const noFollow = process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW
const safeValue = (value: unknown): string | undefined => typeof value === "string"
  && /^[A-Za-z0-9_.:/[\]-]{1,160}$/.test(value)
  && !/(?:gh[pousr]_|github_pat_|sk-|eyJ)[A-Za-z0-9_-]+/.test(value) ? value : undefined
const errorName = (error: unknown): string => error instanceof Error && ["AbortError", "TimeoutError", "TypeError", "SyntaxError"].includes(error.name) ? error.name : "Error"
const record = (value: unknown): value is Record<string, any> => typeof value === "object" && value !== null && !Array.isArray(value)

type BodyState = "pending" | "complete" | "cancelled" | "error" | "absent"
export interface CapturedBody {
  file: string
  bytes: number
  chunks: number[]
  state: BodyState
  error?: string
}
export interface CapturedExchange {
  order: number
  method: string
  path: string
  upstreamRequestId: string
  requestHeaders: Record<string, string>
  request: CapturedBody
  response?: CapturedBody
  status?: number
  responseHeaders?: Record<string, string>
  error?: string
  outcome?: Record<string, unknown>
  discarded?: boolean
}
export interface CaptureManifest {
  format: 1
  relayVersion: string
  requestId: string
  method: string
  path: string
  headers: Record<string, string>
  startedAt: string
  ownerPid?: number
  captureState: "pending" | "complete" | "incomplete"
  captureError?: string
  handlerSettled: boolean
  request: CapturedBody
  response?: CapturedBody
  status?: number
  responseHeaders?: Record<string, string>
  exchanges: CapturedExchange[]
  refreshes: Array<{ order: number; outcome: "success" | "failure" | "cancelled"; error?: string }>
  abort?: { exchange: number; upstreamBytes: number; clientBytes: number; error: string }
  config: { host: string; port: number; upstreamTimeoutMs: number; vsCodeVersion: string; webSearchBackend?: string; claudeUpstreamApi?: string }
  runtime: Omit<RuntimeState, "modelCatalog" | "upstreamBaseUrl"> & { models?: Array<[string, unknown]>; catalogCurrent?: boolean }
  outcome?: Record<string, unknown>
}

export interface RecordedRequest {
  method: string
  path: string
  headers: NonNullable<RequestInit["headers"]>
  body?: string
  upstreamRequestId: string
  signal?: AbortSignal
}
export interface RequestDiagnostic {
  requestId: string
  status?: number
  responseState?: BodyState
  stopReason?: string
  reportedModel?: string
  terminal: boolean
  failure?: "local-validation" | "invalid-tool-input" | "internal-error"
  capture: { state: "off" | "pending" | "complete" | "incomplete" | "failed" }
  exchanges: Array<{
    order: number
    path: string
    upstreamRequestId?: string
    providerRequestId?: string
    messageId?: string
    model?: string
    status?: number
    responseState?: BodyState
    finishReason?: string
    stopReason?: string
    responseStatus?: string
    refusalCategory?: string
    incompleteReason?: string
    error?: string
    discarded: boolean
  }>
  refreshes: Array<"success" | "failure" | "cancelled">
}

export interface RecordedTransport {
  fetch: (request: RecordedRequest) => Promise<Response>
  refresh: () => Promise<void>
  requestId?: string
}

export const withTraceObserver = <T>(observe: (trace: RequestTrace) => void, run: () => T): T => traceObserver.run(observe, run)
export const getReplayRequestId = (): string | undefined => {
  // Reuse only the validated internal replay identity; never trust a client's request-ID header.
  const id = transportContext.getStore()?.requestId
  return id && uuid.test(id) ? id : undefined
}

export const withRecordedTransport = <T>(transport: RecordedTransport, run: () => T): T => transportContext.run(transport, run)
export const withRequestTrace = <T>(trace: RequestTrace, run: () => T): T => traceContext.run(trace, run)
export const getRequestTrace = (): RequestTrace | undefined => traceContext.getStore()
export const isReplayTransport = (): boolean => transportContext.getStore() !== undefined

class OutcomeObserver {
  private decoder = new TextDecoder()
  private pending = ""
  private overflow = false
  readonly fields: Record<string, unknown> = {}

  private readonly sse: boolean
  private readonly metadataValue: (value: unknown) => string | undefined
  constructor(sse: boolean, metadataValue = safeValue) { this.sse = sse; this.metadataValue = metadataValue }

  push(bytes: Uint8Array): void {
    const text = this.decoder.decode(bytes, { stream: true })
    if (!this.sse) {
      if (this.pending.length + text.length <= 2 * 1024 * 1024) this.pending += text
      else this.overflow = true
      return
    }
    for (const part of text.split(/(?<=\n)/)) {
      if (this.pending.length + part.length <= 2 * 1024 * 1024 && !this.overflow) this.pending += part
      else this.overflow = true
      if (part.endsWith("\n")) {
        if (!this.overflow && this.pending.startsWith("data:")) this.parse(this.pending.slice(5).trim())
        this.pending = ""
        this.overflow = false
      }
    }
  }

  finish(): void {
    if (!this.overflow && this.pending) this.parse(this.sse ? this.pending.replace(/^data:\s*/, "").trim() : this.pending)
  }

  private parse(text: string): void {
    let payload: unknown
    try { payload = JSON.parse(text) } catch { return }
    if (!record(payload)) return
    const value = record(payload.response) ? payload.response : record(payload.message) ? payload.message : payload
    const id = this.metadataValue(value.id)
    if (id) this.fields.message_id = id
    const model = this.metadataValue(value.model)
    if (model) this.fields.model = model
    const choice = Array.isArray(value.choices) ? value.choices[0] : undefined
    const finish = this.metadataValue(choice?.finish_reason)
    if (finish && ["stop", "length", "tool_calls", "content_filter"].includes(finish)) { this.fields.finish_reason = finish; this.fields.terminal = true }
    const delta = record(payload.delta) ? payload.delta : undefined
    const stop = this.metadataValue(delta?.stop_reason ?? value.stop_reason)
    if (stop && ["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"].includes(stop)) { this.fields.stop_reason = stop; this.fields.terminal = true }
    const status = safeValue(value.status)
    if (status && ["completed", "failed", "cancelled", "incomplete"].includes(status)) {
      this.fields.response_status = status
      this.fields.terminal = true
    }
    const category = this.metadataValue((delta?.stop_details ?? value.stop_details)?.category)
    if (category) this.fields.refusal_category = ["cyber", "bio", "reasoning_extraction", "general_harms", "frontier_llm"].includes(category) ? category : "unknown"
    const incomplete = this.metadataValue(value.incomplete_details?.reason)
    if (incomplete) this.fields.incomplete_reason = ["max_output_tokens", "content_filter"].includes(incomplete) ? incomplete : "unknown"
    if (payload.type === "error" || record(payload.error)) this.fields.error = "upstream_error"
    const usage = record(payload.usage) ? payload.usage : record(value.usage) ? value.usage : undefined
    if (usage) {
      for (const [target, input] of [
        ["input_tokens", usage.input_tokens ?? usage.prompt_tokens],
        ["output_tokens", usage.output_tokens ?? usage.completion_tokens],
        ["cache_read_input_tokens", usage.cache_read_input_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens],
        ["cache_creation_input_tokens", usage.cache_creation_input_tokens],
      ] as const) if (typeof input === "number" && Number.isSafeInteger(input) && input >= 0) this.fields[target] = input
    }
  }
}

const emptyBody = (file: string, state: BodyState = "pending"): CapturedBody => ({ file, bytes: 0, chunks: [], state })
const checkedDirectory = async (directory: string, expected?: Stats): Promise<Stats> => {
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || expected && !sameFile(expected, stat)) throw new Error("Unsafe capture directory.")
  return stat
}
const privateDirectory = async (directory: string): Promise<Stats> => {
  await fs.mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
  const observed = await checkedDirectory(directory)
  if (process.platform === "win32") return observed
  const handle = await fs.open(directory, fs.constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    if (!opened.isDirectory() || !sameFile(observed, opened)) throw new Error("Capture directory changed.")
    await handle.chmod(0o700)
    return opened
  } finally { await handle.close() }
}
const createPrivateFile = async (file: string): Promise<FileHandle> => {
  const handle = await fs.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow, 0o600)
  try {
    const opened = await handle.stat()
    const current = await fs.lstat(file)
    if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink() || !sameFile(opened, current)) throw new Error("Unsafe capture file.")
    return handle
  } catch (error) { await handle.close(); throw error }
}

export class RequestTrace {
  readonly manifest: CaptureManifest
  captureDirectory?: string
  readonly finished: Promise<void>
  readonly controller = new AbortController()
  readonly signal: AbortSignal
  private resolveFinished!: () => void
  private queue: Promise<void> = Promise.resolve()
  private queuedBytes = 0
  private sequence = 0
  private openFiles = new Map<string, FileHandle>()
  private directories = new Map<string, Stats>()
  private metadataStat?: Stats
  private cancelling = new Set<Promise<void>>()
  private abortBodies = new Set<() => void>()
  private upstreamBodies = new Set<() => void>()
  private clientSettled = false
  private finalizing = false
  private deferredHandler = false
  private removeAbort?: () => void
  private readonly credentials = new Set<string>()
  private captureRequested = false
  private finishedSettling = false
  private failure?: RequestDiagnostic["failure"]

  recordFailure(failure: NonNullable<RequestDiagnostic["failure"]>): void {
    this.failure = failure
  }

  private diagnosticCaptureState(): RequestDiagnostic["capture"]["state"] {
    if (!this.captureRequested) return "off"
    if (!this.captureDirectory) return "failed"
    if (!this.finishedSettling) return "pending"
    return this.manifest.captureState === "complete" ? "complete" : "incomplete"
  }

  diagnosticSnapshot(): RequestDiagnostic {
    // The in-memory manifest is replay data, not a disclosure-safe CLI object.
    const known = (value: unknown, choices: string[]): string | undefined =>
      typeof value === "string" && choices.includes(value) ? value : undefined
    const id = (value: unknown): string | undefined => {
      const text = this.metadataValue(value)
      return text && /^[A-Za-z0-9_.:-]{1,160}$/.test(text) ? text : undefined
    }
    const modelId = (value: unknown): string | undefined => {
      const text = this.metadataValue(value)
      return text && /^[A-Za-z0-9_.\[\]-]{1,128}$/.test(text) ? text : undefined
    }
    const bodyState = (value: unknown): BodyState | undefined =>
      known(value, ["pending", "complete", "cancelled", "error", "absent"]) as BodyState | undefined
    const status = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
    const reasons = ["end_turn", "stop_sequence", "tool_use", "pause_turn", "refusal", "max_tokens"]
    return {
      requestId: this.requestId,
      status: status(this.manifest.status),
      responseState: bodyState(this.manifest.response?.state),
      stopReason: known(this.manifest.outcome?.stop_reason, reasons),
      reportedModel: modelId(this.manifest.outcome?.model),
      terminal: this.manifest.outcome?.terminal === true,
      failure: this.failure,
      capture: { state: this.diagnosticCaptureState() },
      exchanges: this.manifest.exchanges.map((exchange) => ({
        order: exchange.order,
        path: known(exchange.path, ["/models", "/chat/completions", "/responses", "/v1/messages"]) ?? "unknown",
        upstreamRequestId: id(exchange.upstreamRequestId),
        providerRequestId: ["x-copilot-service-request-id", "x-github-request-id", "x-request-id"]
          .map((key) => id(exchange.responseHeaders?.[key])).find(Boolean),
        messageId: id(exchange.outcome?.message_id),
        model: modelId(exchange.outcome?.model),
        status: status(exchange.status),
        responseState: bodyState(exchange.response?.state),
        finishReason: known(exchange.outcome?.finish_reason, ["stop", "length", "tool_calls", "content_filter"]),
        stopReason: known(exchange.outcome?.stop_reason, reasons),
        responseStatus: known(exchange.outcome?.response_status, ["completed", "failed", "cancelled", "incomplete"]),
        refusalCategory: known(exchange.outcome?.refusal_category, ["cyber", "bio", "reasoning_extraction", "general_harms", "frontier_llm", "unknown"]),
        incompleteReason: known(exchange.outcome?.incomplete_reason, ["max_output_tokens", "content_filter", "unknown"]),
        error: known(exchange.error ?? exchange.response?.error, ["AbortError", "TimeoutError", "TypeError", "SyntaxError", "Error"]),
        discarded: exchange.discarded === true,
      })),
      refreshes: this.manifest.refreshes.map((refresh) => refresh.outcome),
    }
  }

  protectCredential(value: string | undefined): void {
    if (value) this.credentials.add(value)
    registerLogSecret(value)
  }
  private containsCredential(value: string): boolean {
    return credentialPattern.test(value) || [...this.credentials].some((secret) => value.includes(secret))
  }
  private readonly metadataValue = (value: unknown): string | undefined => {
    const text = safeValue(value)
    return text && !this.containsCredential(text) ? text : undefined
  }
  private safeHeaders(headers: NonNullable<RequestInit["headers"]>): Record<string, string> {
    return Object.fromEntries([...new Headers(headers)].filter(([key, value]) =>
      headerNames.has(key) && value.length <= 16384 && !this.containsCredential(value)))
  }
  private serializeManifest(): string {
    let omitted = false
    const serialized = JSON.stringify(this.manifest, (_key, value: unknown) => {
      if (typeof value !== "string" || !this.containsCredential(value)) return value
      omitted = true
      return "[redacted]"
    })
    if (!omitted) return serialized
    this.manifest.captureError = "sensitive_metadata_omitted"
    this.manifest.captureState = "incomplete"
    return JSON.stringify({ ...JSON.parse(serialized), captureError: this.manifest.captureError, captureState: "incomplete" })
  }
  private async checkDirectories(): Promise<void> {
    for (const [directory, observed] of this.directories) await checkedDirectory(directory, observed)
  }
  private async writeManifest(file: string): Promise<void> {
    await this.checkDirectories()
    const handle = await createPrivateFile(path.join(this.captureDirectory!, file))
    try {
      await handle.writeFile(this.serializeManifest())
      await handle.sync()
      if (file === "meta.json") this.metadataStat = await handle.stat()
    } finally { await handle.close() }
  }

  readonly requestId: string
  private constructor(requestId: string, request: Request, config: ProxyConfig, runtime: RuntimeState) {
    this.requestId = requestId
    this.protectCredential(config.copilotToken)
    this.protectCredential(request.headers.get("authorization")?.replace(/^Bearer\s+/i, ""))
    this.protectCredential(request.headers.get("x-api-key") ?? undefined)
    this.signal = AbortSignal.any([request.signal, this.controller.signal])
    this.finished = new Promise((resolve) => { this.resolveFinished = resolve })
    const { modelCatalog, upstreamBaseUrl: _base, ...policy } = runtime
    const nativeMode = (config as ProxyConfig & { claudeUpstreamApi?: string }).claudeUpstreamApi
    this.manifest = {
      format: 1, relayVersion: appVersion, requestId, ownerPid: process.pid,
      method: request.method, path: new URL(request.url).pathname,
      headers: this.safeHeaders(request.headers), startedAt: new Date().toISOString(),
      captureState: "pending", handlerSettled: false,
      request: emptyBody("client-request.bin", request.body ? "pending" : "absent"),
      exchanges: [], refreshes: [],
      config: { host: config.host, port: config.port, upstreamTimeoutMs: config.upstreamTimeoutMs, vsCodeVersion: config.vsCodeVersion, webSearchBackend: config.webSearchBackend, ...(nativeMode && { claudeUpstreamApi: nativeMode }) },
      runtime: { ...policy, models: modelCatalog ? [...modelCatalog.models.entries()] : config.modelCatalog ? [...config.modelCatalog.models.entries()] : undefined,
        catalogCurrent: (modelCatalog ?? config.modelCatalog)?.baseUrl === config.copilotBaseUrl },

    }
    const abort = () => {
      const exchange = this.manifest.exchanges.at(-1)
      this.manifest.abort = { exchange: exchange?.order ?? 0, upstreamBytes: exchange?.response?.bytes ?? 0, clientBytes: this.manifest.response?.bytes ?? 0, error: errorName(this.signal.reason) }
      this.clientSettled = true
      for (const cancel of this.abortBodies) cancel()
      this.finalizeIfReady()
    }
    if (this.signal.aborted) abort()
    else { this.signal.addEventListener("abort", abort, { once: true }); this.removeAbort = () => this.signal.removeEventListener("abort", abort) }
  }

  static async create(id: string, request: Request, config: ProxyConfig, runtime: RuntimeState, capture: boolean): Promise<RequestTrace> {
    const trace = new RequestTrace(id, request, config, runtime)
    trace.captureRequested = capture
    // Observers retain a handle; awaiting settlement here would deadlock response consumption.
    traceObserver.getStore()?.(trace)
    if (!capture) return trace
    try {
      if (!uuid.test(id)) throw new Error("Invalid capture identifier.")
      const root = path.join(paths.appDir, "captures")
      trace.directories.set(paths.appDir, await privateDirectory(paths.appDir))
      trace.directories.set(root, await privateDirectory(root))
      const date = path.join(root, formatLogDate(new Date()))
      trace.directories.set(date, await privateDirectory(date))
      const directory = path.join(date, id)
      await fs.mkdir(directory, { mode: 0o700 })
      trace.directories.set(directory, await checkedDirectory(directory))
      trace.captureDirectory = directory
      activeCaptures.add(directory)
      pendingCaptures.add(trace.finished)
      void trace.finished.finally(() => pendingCaptures.delete(trace.finished))
      await trace.writeManifest("meta.json")
      log.debug(`request_id=${id} capture=${directory} privacy=full-bodies`)
    } catch {
      trace.manifest.captureState = "incomplete"
      trace.manifest.captureError = "capture_initialization_failed"
      log.error(`request_id=${id} capture initialization failed; request continues`)
    }
    return trace
  }

  captureRequest(request: Request): Request {
    if (!request.body) return new Request(request, { signal: this.signal })
    const body = this.wrapBody(request.body, this.manifest.request)
    return new Request(request, { body, signal: this.signal, duplex: "half" } as RequestInit)
  }

  captureResponse(response: Response): Response {
    this.manifest.status = response.status
    this.manifest.responseHeaders = this.safeHeaders(response.headers)
    const captured = this.manifest.response = emptyBody("client-response.bin", response.body ? "pending" : "absent")
    const observer = new OutcomeObserver(response.headers.get("content-type")?.includes("text/event-stream") ?? false, this.metadataValue)
    const done = () => {
      observer.finish()
      this.manifest.outcome = observer.fields
      this.clientSettled = true
      this.finalizeIfReady()
    }
    if (!response.body) { done(); return response }
    return new Response(this.wrapBody(response.body, captured, observer, done, true), { status: response.status, statusText: response.statusText, headers: response.headers })
  }

  deferHandler(): void { this.deferredHandler = true }

  responseReady(): void {
    if (!this.deferredHandler) this.handlerSettled()
  }

  handlerSettled(error?: unknown): void {
    this.manifest.handlerSettled = true
    if (error) this.manifest.outcome = { ...(this.manifest.outcome ?? {}), error: errorName(error) }
    for (const cancel of this.upstreamBodies) cancel()
    this.finalizeIfReady()
  }

  async fetch(input: RecordedRequest, fallback: () => Promise<Response>): Promise<Response> {
    this.signal.throwIfAborted()
    input.signal?.throwIfAborted()
    const order = ++this.sequence
    const exchange: CapturedExchange = {
      order, path: input.path, method: input.method, upstreamRequestId: input.upstreamRequestId,
      requestHeaders: this.safeHeaders(input.headers), request: emptyBody(`upstream-${order}-request.bin`, "complete"),
    }
    this.manifest.exchanges.push(exchange)
    const bytes = Buffer.from(input.body ?? "")
    this.append(exchange.request, bytes)
    try {
      const response = await (transportContext.getStore()?.fetch(input) ?? fallback())
      exchange.status = response.status
      exchange.responseHeaders = this.safeHeaders(response.headers)
      exchange.response = emptyBody(`upstream-${order}-response.bin`, response.body ? "pending" : "absent")
      const observer = new OutcomeObserver(response.headers.get("content-type")?.includes("text/event-stream") ?? false, this.metadataValue)
      const done = () => {
        observer.finish()
        exchange.outcome = observer.fields
        log.info(`request_id=${this.requestId} upstream_request_id=${input.upstreamRequestId} completion path=${input.path} http_status=${response.status} body=${exchange.response!.state} ${this.formatOutcome(observer.fields)}`)
      }
      if (!response.body) { done(); return response }
      const wrapped = new Response(this.wrapBody(response.body, exchange.response, observer, done, false, true), { status: response.status, statusText: response.statusText, headers: response.headers })
      Object.defineProperty(wrapped, "url", { value: response.url })
      responseExchanges.set(wrapped, exchange)
      return wrapped
    } catch (error) {
      exchange.error = errorName(error)
      throw error
    }
  }

  async refresh(fallback: () => Promise<void>): Promise<void> {
    this.signal.throwIfAborted()
    const refresh: CaptureManifest["refreshes"][number] = { order: ++this.sequence, outcome: "success" }
    this.manifest.refreshes.push(refresh)
    try { await (transportContext.getStore()?.refresh() ?? fallback()) }
    catch (error) {
      refresh.outcome = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name) ? "cancelled" : "failure"
      refresh.error = errorName(error)
      throw error
    }
  }

  private wrapBody(body: ReadableStream<Uint8Array>, capture: CapturedBody, observer?: OutcomeObserver, done?: () => void, client = false, upstream = false): ReadableStream<Uint8Array> {
    const reader = body.getReader()
    let closed = false
    let controller: ReadableStreamDefaultController<Uint8Array>
    let cancellation: Promise<void> | undefined
    const settle = (state: BodyState, error?: unknown) => {
      closed = true
      this.abortBodies.delete(abort)
      this.upstreamBodies.delete(discard)
      capture.state = state
      if (error) capture.error = errorName(error)
      reader.releaseLock()
      done?.()
    }
    const cancel = (reason: unknown): Promise<void> => {
      if (closed) return cancellation ?? Promise.resolve()
      closed = true
      this.abortBodies.delete(abort)
      this.upstreamBodies.delete(discard)
      capture.state = "cancelled"
      cancellation = reader.cancel(reason).catch(() => {}).then(() => settle("cancelled", reason)).finally(() => {
        this.cancelling.delete(cancellation!)
        this.finalizeIfReady()
      })
      this.cancelling.add(cancellation)
      return cancellation
    }
    const abort = () => {
      if (closed) return
      controller.error(this.signal.reason)
      void cancel(this.signal.reason)
    }
    const discard = () => {
      if (closed) return
      const reason = new DOMException("Upstream body no longer consumed.", "AbortError")
      controller.error(reason)
      void cancel(reason)
    }
    return new ReadableStream<Uint8Array>({
      start: (value) => {
        controller = value
        this.abortBodies.add(abort)
        if (upstream) this.upstreamBodies.add(discard)
        if (this.signal.aborted) abort()
      },
      pull: async () => {
        try {
          const next = await reader.read()
          if (closed) return
          if (next.done) { settle("complete"); controller.close(); return }
          this.append(capture, next.value)
          observer?.push(next.value)
          controller.enqueue(next.value)
        } catch (error) {
          if (!closed) { settle("error", error); controller.error(error) }
        }
      },
      cancel: (reason) => {
        const pending = cancel(reason)
        if (client) this.controller.abort(new DOMException("Client response cancelled.", "AbortError"))
        return pending
      },
    }, { highWaterMark: 0 })
  }

  private append(body: CapturedBody, bytes: Uint8Array): void {
    body.bytes += bytes.byteLength
    if (!this.captureDirectory || this.manifest.captureError) return
    if (body.chunks.length >= 100000 || this.queuedBytes + bytes.byteLength > maxQueuedBytes) {
      this.manifest.captureError = "capture_queue_limit"
      this.manifest.captureState = "incomplete"
      return
    }
    body.chunks.push(bytes.byteLength)
    const buffer = Buffer.from(bytes)
    this.queuedBytes += buffer.length
    this.queue = this.queue.then(async () => {
      await this.checkDirectories()
      const file = path.join(this.captureDirectory!, body.file)
      let handle = this.openFiles.get(body.file)
      if (!handle) {
        handle = await createPrivateFile(file)
        this.openFiles.set(body.file, handle)
      }
      const opened = await handle.stat()
      const current = await fs.lstat(file)
      if (!current.isFile() || current.isSymbolicLink() || opened.nlink !== 1 || !sameFile(opened, current)) throw new Error("Capture file changed.")
      await handle.writeFile(buffer)
    }).catch(() => {
      this.manifest.captureError = "capture_write_failed"
      this.manifest.captureState = "incomplete"
    }).finally(() => { this.queuedBytes -= buffer.length })
  }

  private formatOutcome(fields: Record<string, unknown>): string {
    return ["message_id", "model", "finish_reason", "stop_reason", "response_status", "terminal", "refusal_category", "incomplete_reason", "input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "error"]
      .filter((key) => fields[key] !== undefined || ["terminal", "stop_reason", "finish_reason"].includes(key))
      .map((key) => `${key}=${fields[key] ?? "unknown"}`).join(" ")
  }

  private finalizeIfReady(): void {
    if (!this.manifest.handlerSettled || !this.clientSettled || this.cancelling.size || this.finalizing) return
    this.finalizing = true
    this.removeAbort?.()
    const fields = this.manifest.outcome ?? {}
    log.info(`request_id=${this.requestId} request outcome http_status=${this.manifest.status ?? "unknown"} body=${this.manifest.response?.state ?? "unknown"} ${this.formatOutcome(fields)}`)
    void this.queue.then(async () => {
      for (const handle of this.openFiles.values()) await handle.sync()
      const bodies = [this.manifest.request, this.manifest.response, ...this.manifest.exchanges.flatMap((exchange) => [exchange.request, exchange.response])].filter((body): body is CapturedBody => body !== undefined)
      this.manifest.captureState = this.manifest.captureError || this.manifest.abort || bodies.some((body) => ["pending", "error", "cancelled"].includes(body.state)
        && !this.manifest.exchanges.some((exchange) => exchange.response === body && exchange.discarded && body.state === "cancelled")) ? "incomplete" : "complete"
      if (this.captureDirectory) {
        await this.writeManifest("meta.next.json")
        await this.checkDirectories()
        const manifest = path.join(this.captureDirectory, "meta.json")
        const current = await fs.lstat(manifest)
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || !this.metadataStat
          || !sameFile(current, this.metadataStat) || current.size !== this.metadataStat.size
          || current.mtimeMs !== this.metadataStat.mtimeMs || current.ctimeMs !== this.metadataStat.ctimeMs) throw new Error("Unsafe capture metadata.")
        await fs.rename(path.join(this.captureDirectory, "meta.next.json"), manifest)
      }
    }).catch(() => {
      this.manifest.captureState = "incomplete"
      log.error(`request_id=${this.requestId} capture finalization failed`)
    }).finally(async () => {
      await Promise.all([...this.openFiles.values()].map((handle) => handle.close().catch(() => {})))
      this.openFiles.clear()
      if (this.captureDirectory) activeCaptures.delete(this.captureDirectory)
      this.finishedSettling = true
      this.resolveFinished()
    })
  }
}

export const recordedFetch = async (input: RecordedRequest, fallback: () => Promise<Response>): Promise<Response> => {
  const trace = getRequestTrace()
  return trace ? trace.fetch(input, fallback) : transportContext.getStore()?.fetch(input) ?? fallback()
}
export const recordedRefresh = async (fallback: () => Promise<void>): Promise<void> => {
  const trace = getRequestTrace()
  return trace ? trace.refresh(fallback) : transportContext.getStore()?.refresh() ?? fallback()
}

const ownerHasExited = (pid: unknown): boolean => {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return false }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" }
}
const readRetentionManifest = async (file: string): Promise<unknown> => {
  const observed = await fs.lstat(file)
  if (!observed.isFile() || observed.nlink !== 1 || observed.size > 16 * 1024 * 1024) throw new Error("Unsafe capture metadata.")
  const handle = await fs.open(file, fs.constants.O_RDONLY | noFollow)
  try {
    const opened = await handle.stat()
    if (!sameFile(observed, opened) || opened.nlink !== 1 || opened.size !== observed.size) throw new Error("Capture metadata changed.")
    const bytes = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw new Error("Capture metadata changed.")
      offset += bytesRead
    }
    const current = await fs.lstat(file)
    if (!sameFile(opened, current) || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs) throw new Error("Capture metadata changed.")
    return JSON.parse(bytes.toString("utf8"))
  } finally { await handle.close() }
}
const sweepCaptures = async (days: number, now: Date): Promise<void> => {
  const root = path.join(paths.appDir, "captures")
  const parents = new Map<string, Stats>()
  try {
    parents.set(paths.appDir, await checkedDirectory(paths.appDir))
    parents.set(root, await checkedDirectory(root))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  const cutoff = new Date(now)
  cutoff.setHours(0, 0, 0, 0)
  cutoff.setDate(cutoff.getDate() - (days - 1))
  const cutoffName = formatLogDate(cutoff)
  const checkParents = async () => {
    for (const [directory, observed] of parents) await checkedDirectory(directory, observed)
  }
  for (const date of await fs.readdir(root, { withFileTypes: true })) {
    if (!date.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(date.name) || date.name >= cutoffName) continue
    const parsed = new Date(`${date.name}T12:00:00`)
    if (!Number.isFinite(parsed.getTime()) || formatLogDate(parsed) !== date.name) continue
    const directory = path.join(root, date.name)
    await checkParents()
    const day = await checkedDirectory(directory)
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const capture = path.join(directory, entry.name)
      if (!entry.isDirectory() || !uuid.test(entry.name) || activeCaptures.has(capture)) continue
      try {
        await checkParents()
        await checkedDirectory(directory, day)
        const captured = await checkedDirectory(capture)
        const manifest = await readRetentionManifest(path.join(capture, "meta.json"))
        if (!record(manifest) || manifest.format !== 1 || manifest.requestId !== entry.name) continue
        const settled = manifest.handlerSettled === true && ["complete", "incomplete"].includes(manifest.captureState)
        if (!settled && !ownerHasExited(manifest.ownerPid)) continue
        const entries = await fs.readdir(capture, { withFileTypes: true })
        if (entries.some((file) => !file.isFile() || !/^(?:meta(?:\.next)?\.json|client-(?:request|response)\.bin|upstream-[1-9]\d*-(?:request|response)\.bin)$/.test(file.name))) continue
        const files = await Promise.all(entries.map(async (file) => ({ file: path.join(capture, file.name), stat: await fs.lstat(path.join(capture, file.name)) })))
        if (files.some(({ stat }) => !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) continue
        files.sort((left, right) => Number(path.basename(left.file) === "meta.json") - Number(path.basename(right.file) === "meta.json"))
        for (const { file, stat } of files) {
          await checkParents()
          await checkedDirectory(directory, day)
          await checkedDirectory(capture, captured)
          const current = await fs.lstat(file)
          if (!sameFile(current, stat) || !current.isFile() || current.nlink !== 1 || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw new Error("Capture changed during retention.")
          await fs.unlink(file)
        }
        await fs.rmdir(capture)
      } catch {
        // Unknown or changing records are retained rather than recursively removed.
      }
    }
    await checkParents()
    await checkedDirectory(directory, day)
    await fs.rmdir(directory).catch(() => {})
  }
}

export const cleanupCaptures = (days: number, now = new Date()): Promise<void> => {
  captureRetentionDays = days
  nextCleanupAt = now.getTime() + 60 * 60 * 1000
  pendingCleanup = pendingCleanup.then(() => sweepCaptures(days, now)).catch(() => {
    log.error("Capture retention failed; existing captures retained.")
  })
  return pendingCleanup
}

export const cleanupCapturesIfDue = (): void => {
  if (Date.now() >= nextCleanupAt) void cleanupCaptures(captureRetentionDays)
}
