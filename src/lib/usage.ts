// The Copilot plan and quota for `copilot-relay usage`, as GitHub's copilot_internal/user reports
// them.
//
// The request is made with the stored GitHub token, so no relay needs to run and no Copilot token
// is exchanged. This module writes no file and never logs. GitHub's answer also identifies the
// account, with fields such as the login, organization lists and tracking ids, so only the plan
// and quota fields are kept. Printed text is checked for the stored token: a failure line has it
// redacted or loses its reason, and an answer that would show it is refused. showsToken says how
// far the check reaches.
import { getCopilotUsage, readStoredGitHubToken } from "~/lib/auth"
import { vscodeVersion } from "~/lib/config"
import { HTTPError } from "~/lib/error"
import { paths } from "~/lib/paths"
import { colorText, terminalText } from "~/lib/terminal"

// The quota ids GitHub sends today. They are always listed first, in this order; any other id the
// response carries follows them.
const knownQuotaIds = ["chat", "completions", "premium_interactions"] as const

/** One quota as GitHub reports it. A field that is absent, or not of the type GitHub sends, is null. */
export interface QuotaSnapshot {
  unlimited: boolean | null
  entitlement: number | null
  remaining: number | null
  percent_remaining: number | null
  overage_permitted: boolean | null
  overage_count: number | null
  token_based_billing: boolean | null
  credits_used: number | null
}

/**
 * The plan and quota fields of GitHub's answer, under GitHub's own names, and nothing else.
 *
 * Every key is always present, null when GitHub did not report it, so `--json` prints the same keys
 * for every account. Strings are terminal-safe.
 */
export interface CopilotUsage {
  copilot_plan: string | null
  access_type_sku: string | null
  quota_reset_date: string | null
  /** Every known quota id, null when not reported, and any other id the answer carries. */
  quota_snapshots: Record<string, QuotaSnapshot | null>
}

/** A failure the command reports. The message is one printable line and never holds the token. */
export class CopilotUsageError extends Error {}

const notAnObject = "GitHub's answer to the usage request was not a JSON object."

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// GitHub's value when it has the type GitHub sends. Anything else counts as not reported rather
// than being converted into a guess.
const stringField = (value: unknown): string | null =>
  typeof value === "string" ? terminalText(value) : null

const numberField = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null

const booleanField = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null

const parseSnapshot = (value: unknown): QuotaSnapshot | null => {
  if (!isRecord(value)) {
    return null
  }

  return {
    unlimited: booleanField(value.unlimited),
    entitlement: numberField(value.entitlement),
    remaining: numberField(value.remaining),
    percent_remaining: numberField(value.percent_remaining),
    overage_permitted: booleanField(value.overage_permitted),
    overage_count: numberField(value.overage_count),
    token_based_billing: booleanField(value.token_based_billing),
    credits_used: numberField(value.credits_used),
  }
}

/**
 * The plan and quota fields of a copilot_internal/user answer, each checked on its own.
 *
 * Throws CopilotUsageError when the answer is not a JSON object at all.
 */
export const parseCopilotUsage = (body: unknown): CopilotUsage => {
  if (!isRecord(body)) {
    throw new CopilotUsageError(notAnObject)
  }

  const quota = body.quota_snapshots
  const reported: Record<string, unknown> = isRecord(quota) ? quota : {}
  const snapshots = new Map<string, QuotaSnapshot | null>()

  for (const id of knownQuotaIds) {
    snapshots.set(id, parseSnapshot(reported[id]))
  }

  for (const [rawId, value] of Object.entries(reported)) {
    const id = terminalText(rawId)

    // An id that is blank once made terminal-safe, or that then reads as one already listed, would
    // print as a row that cannot be told apart from another.
    if (id === "" || snapshots.has(id)) {
      continue
    }

    snapshots.set(id, parseSnapshot(value))
  }

  return {
    copilot_plan: stringField(body.copilot_plan),
    access_type_sku: stringField(body.access_type_sku),
    quota_reset_date: stringField(body.quota_reset_date),
    quota_snapshots: Object.fromEntries(snapshots),
  }
}

const notReported = "not reported"

// GitHub's number exactly as it arrived: no rounding, no separators, nothing derived from it.
const formatNumber = (value: number | null): string => (value === null ? "?" : String(value))

const formatAllowance = (snapshot: QuotaSnapshot): string => {
  if (snapshot.unlimited === true) {
    return "unlimited"
  }

  const remaining = `${formatNumber(snapshot.remaining)} of ${formatNumber(snapshot.entitlement)} remaining`

  return `${remaining} (${formatNumber(snapshot.percent_remaining)}%)`
}

const formatOverage = (snapshot: QuotaSnapshot): string => {
  let permitted = "overage ?"

  if (snapshot.overage_permitted === true) {
    permitted = "overage permitted"
  } else if (snapshot.overage_permitted === false) {
    permitted = "overage not permitted"
  }

  return `${permitted}, overage count ${formatNumber(snapshot.overage_count)}`
}

const formatQuota = (snapshot: QuotaSnapshot): string => {
  const parts = [formatAllowance(snapshot), formatOverage(snapshot)]

  if (snapshot.credits_used !== null) {
    parts.push(`credits used ${formatNumber(snapshot.credits_used)}`)
  }

  return parts.join("; ")
}

/** The report as text lines. Kept free of IO, so it is tested without a terminal. */
export const renderCopilotUsage = (usage: CopilotUsage, color = false): Array<string> => {
  const shown = (value: string | null): string => value ?? colorText(notReported, "muted", color)

  const headings: Array<[string, string | null]> = [
    ["Plan", usage.copilot_plan],
    ["SKU", usage.access_type_sku],
    ["Quota reset", usage.quota_reset_date],
  ]
  const labelWidth = Math.max(...headings.map(([label]) => label.length))

  // The known ids first, in their fixed order, whatever order the object holds its keys in.
  const known: Array<string> = [...knownQuotaIds]
  const ids = [...known, ...Object.keys(usage.quota_snapshots).filter((id) => !known.includes(id))]
  const idWidth = Math.max(...ids.map((id) => id.length))

  const quotaLines = ids.map((id) => {
    const snapshot = usage.quota_snapshots[id] ?? null
    const text = snapshot === null ? colorText(notReported, "muted", color) : formatQuota(snapshot)

    return `${id.padEnd(idWidth)}  ${text}`
  })

  return [
    ...headings.map(([label, value]) => `${label.padEnd(labelWidth)}  ${shown(value)}`),
    "",
    ...quotaLines,
  ]
}

// A stalled connection fails with a clear line instead of waiting for the socket timeouts.
const requestTimeoutSeconds = 30

const tokenInAnswer = "GitHub's answer to the usage request contains the stored token, so none of it is printed."

// The token as a terminal shows it. Text is searched only after terminalText has run, because
// removing a hidden character can join a split token back up. A token with no visible character
// cannot show in printed text, and every text would contain its empty visible form.
const visibleToken = (token: string): string => terminalText(token)

// fetch can quote a header value in its error, so a failure line loses the token before it is
// shown.
const withoutToken = (line: string, token: string): string => {
  const visible = visibleToken(token)

  return visible === "" ? line : line.replaceAll(visible, "[redacted]")
}

// The ASCII letters and digits of a text, in order. Any other character, a space or a letter of
// another script included, counts as a separator, so inserting one cannot hide the token.
const lettersAndDigits = (text: string): string => text.replace(/[^A-Za-z0-9]/g, "")

// A token is matched by its letters and digits alone only when it has at least this many: a
// shorter run could occur in ordinary text by chance. A GitHub token has far more.
const minimumSpelledLength = 16

// True when the text holds the token's letters and digits in order, with only other characters
// between them.
const spellsToken = (text: string, token: string): boolean => {
  const spelled = lettersAndDigits(visibleToken(token))

  return spelled.length >= minimumSpelledLength && lettersAndDigits(text).includes(spelled)
}

// True when the report or --json would show the token. terminalText makes the answer's strings
// safe but does not redact them, and GitHub, or a proxy in the way, can echo credentials back.
//
// The check is bounded. It finds the token written exactly, written with other characters between
// its letters and digits, or spread over the plan, SKU, reset date and quota ids, which are joined
// in the order --json prints them. A token written any other way, such as in another case or
// encoding, is not found. The answer's numbers and booleans are not searched; they print in the
// command's own format.
const showsToken = (usage: CopilotUsage, token: string): boolean => {
  const visible = visibleToken(token)
  const printed = [
    usage.copilot_plan,
    usage.access_type_sku,
    usage.quota_reset_date,
    ...Object.keys(usage.quota_snapshots),
  ].filter((text) => text !== null)

  if (visible !== "" && printed.some((text) => text.includes(visible))) {
    return true
  }

  return spellsToken(printed.join(""), token)
}

// The most specific reason a request failed. fetch rejects with a bare "fetch failed" and keeps the
// reason in `cause`; a refused connection's cause can be an AggregateError with an empty message
// and only a code.
const failureReason = (error: unknown): string => {
  const cause = error instanceof Error ? error.cause : undefined

  if (cause instanceof Error && cause.message !== "") {
    return cause.message
  }

  const code = (cause as NodeJS.ErrnoException | undefined)?.code

  if (typeof code === "string") {
    return code
  }

  return error instanceof Error && error.message !== "" ? error.message : String(error)
}

// AbortSignal.timeout aborts the request, or the read of its body, with a DOMException named
// TimeoutError.
const isTimeout = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "TimeoutError"

// One line for each way the request can fail. It never holds the token or the request headers.
const describeRequestFailure = async (error: unknown, token: string): Promise<CopilotUsageError> => {
  if (error instanceof HTTPError) {
    // An unread body can hold its connection open; release it before exiting.
    await error.response.body?.cancel().catch(() => {})

    const status = error.response.status

    if (status === 401 || status === 403) {
      return new CopilotUsageError(
        `GitHub rejected the stored token (HTTP ${status}). Sign in again with copilot-relay auth.`,
      )
    }

    return new CopilotUsageError(`GitHub answered the usage request with HTTP ${status}.`)
  }

  if (isTimeout(error)) {
    return new CopilotUsageError(`GitHub did not answer within ${requestTimeoutSeconds} seconds.`)
  }

  // response.json() could not parse the body.
  if (error instanceof SyntaxError) {
    return new CopilotUsageError(notAnObject)
  }

  const line = withoutToken(terminalText(`Could not reach GitHub: ${failureReason(error)}`), token)

  // A reason that still spells the token, with a separator inside it, cannot be cut out the way an
  // exact copy is, so the reason is left out.
  return new CopilotUsageError(spellsToken(line, token) ? "Could not reach GitHub." : line)
}

// A read failure is reported by its error code, such as EACCES. The message of a file error only
// repeats the path, and any other error could carry anything.
const readToken = async (): Promise<string> => {
  let token: string | undefined

  try {
    token = await readStoredGitHubToken()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    const reason = typeof code === "string" ? `: ${code}` : ""

    throw new CopilotUsageError(terminalText(`Could not read the GitHub token at ${paths.githubTokenPath}${reason}.`))
  }

  if (token === undefined) {
    throw new CopilotUsageError(
      terminalText(`No GitHub token is stored at ${paths.githubTokenPath}. Sign in with copilot-relay auth.`),
    )
  }

  return token
}

/**
 * The Copilot plan and quota of the stored GitHub token's account.
 *
 * Reads the token file and asks GitHub; writes nothing. Every failure becomes a CopilotUsageError
 * whose message is the line to print.
 */
export const loadCopilotUsage = async (): Promise<CopilotUsage> => {
  const token = await readToken()
  let body: unknown

  try {
    // The editor version every GitHub call sends, taken from the constant rather than through
    // readProxyConfig(readAppConfig()): readAppConfig creates or completes config.yaml, and this
    // command writes nothing.
    body = await getCopilotUsage(token, vscodeVersion, AbortSignal.timeout(requestTimeoutSeconds * 1000))
  } catch (error) {
    throw await describeRequestFailure(error, token)
  }

  const usage = parseCopilotUsage(body)

  // Refused rather than redacted: an answer that echoes the credentials back is not one to trust,
  // and a redacted plan or quota id would print as if it were data.
  if (showsToken(usage, token)) {
    throw new CopilotUsageError(tokenInAnswer)
  }

  return usage
}
