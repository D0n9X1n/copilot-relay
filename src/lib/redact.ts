// Disclosure-safe rendering of URLs and terminal strings.
//
// Exists because copilotBaseUrl is user-supplied and may legitimately carry a
// credential in its path — `https://gateway.example/tenant/token-ABC` is a
// working custom-gateway config, used as `${base}/models`. That value was
// written verbatim to the log on every start and into `status` output, which is
// the one file docs/logging.md asks users to paste into an issue. See #47.
//
// Pure and dependency-free on purpose: it sits on the logging path, so anything
// that could throw or block here would take a request down with it.

/**
 * Origins known to carry a secret somewhere after the origin.
 *
 * Process-lifetime and append-only. Never pruned, because config hot-reload can
 * change copilotBaseUrl while a request against the previous one is still in
 * flight; dropping the old policy would un-redact that request's error on its
 * way to the log.
 */
const sensitiveOrigins = new Set<string>()

/** Marker written in place of everything after the origin. */
const redactedMarker = "[redacted]"

/**
 * ANSI escape sequences: CSI (`ESC [ … final`), OSC (`ESC ] … BEL/ST`), and the
 * two-byte Fe forms. Matched whole rather than stripping the ESC byte alone,
 * which would leave the printable remainder (`[2K`) in the output.
 *
 * Written with \x escapes rather than literal bytes: an invisible ESC in the
 * source survives no round trip through an editor, a diff view, or a paste.
 */
const ansiEscapePattern =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1B\\)|[@-Z\\-_])/g

/** C0 controls and DEL, including CR/LF: one config value is one row. */
const controlBytePattern = /[\x00-\x1F\x7F]/g

/**
 * Absolute http(s) URLs inside arbitrary text.
 *
 * Stops at whitespace, quotes, backticks and angle brackets so a URL embedded
 * in inspect() output — `url: 'https://host/x'` — matches without swallowing
 * the surrounding punctuation.
 *
 * Backslashes are consumed rather than terminating the match. WHATWG folds `\`
 * into `/` for http(s), so `https://host\tenant\TOKEN` parses with the tail in
 * the path, carries no userinfo, and is therefore accepted and stored verbatim
 * by normalizeCopilotBaseUrl — and inspect() doubles each backslash on the way
 * to both sinks. Stopping at the first one matched only the origin, which then
 * looked origin-only and left the entire tail in the log.
 */
const absoluteUrlPattern = /https?:\/\/[^\s'"`<>]+/gi

const parseHttpUrl = (value: string): URL | undefined => {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return undefined
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ?
      parsed
    : undefined
}

/** True when the URL carries nothing after the origin worth hiding. */
const isOriginOnly = (parsed: URL): boolean =>
  (parsed.pathname === "" || parsed.pathname === "/")
  && !parsed.search
  && !parsed.hash

/**
 * Renders a URL for display, keeping the origin and hiding the rest.
 *
 * The origin is the operationally useful half — it answers "which gateway am I
 * talking to" — while path, query and fragment are where a credential ends up.
 * An explicit marker rather than silent truncation, so a reader can tell the
 * difference between a base URL that has no path and one whose path was
 * withheld.
 *
 * Never throws: it also runs on values that failed validation.
 */
export const formatUrlForDisplay = (raw: string): string => {
  const parsed = parseHttpUrl(raw)
  if (!parsed) {
    return "(invalid url)"
  }

  // Returned as written, not re-serialized, so a trailing slash the user
  // configured still reads back the way their config file has it.
  return isOriginOnly(parsed) ?
      raw
    : `${parsed.origin} (path/query/fragment hidden)`
}

/**
 * Strips ANSI escapes and control bytes from a string bound for the terminal.
 *
 * `status` prints config values directly to stdout. A config string carrying
 * raw control bytes could clear the line and paint status rows the relay never
 * produced. The config file is user-owned, so this is hardening rather than a
 * vulnerability — but it costs nothing to make the output non-forgeable. #47.
 */
export const sanitizeTerminalString = (text: string): string =>
  text.replace(ansiEscapePattern, "").replace(controlBytePattern, "")

/**
 * Marks a URL's origin as secret-bearing, if it has anything after the origin.
 *
 * An origin-only URL registers nothing: there is no tail to hide, and marking
 * the origin would redact every unrelated URL on that host for no benefit.
 *
 * Additive and idempotent. Never throws on an unparseable value.
 */
export const registerSensitiveOrigin = (raw: string): void => {
  const parsed = parseHttpUrl(raw)
  if (!parsed || isOriginOnly(parsed)) {
    return
  }

  sensitiveOrigins.add(parsed.origin)
}

/**
 * Rewrites URLs on registered origins to `origin[redacted]`.
 *
 * Anchored on the parsed origin rather than on the configured string, which is
 * what makes the variants match: fetch reports back a canonicalized URL (host
 * case-folded, default port dropped) with the fragment already stripped, and
 * clients append their own endpoint to the base. All of those share an origin.
 *
 * Deliberately not a substring substitution of the secret path. Replacing that
 * text wherever it appeared would also rewrite unrelated prose and detached
 * paths; only an absolute URL on a registered origin is rewritten here.
 */
export const scrubSensitiveUrls = (text: string): string => {
  if (sensitiveOrigins.size === 0) {
    return text
  }

  return text.replace(absoluteUrlPattern, (match) => {
    // The whole match is treated as the URL - nothing is trimmed off the end
    // and nothing is restored after the marker.
    //
    // Trailing punctuation used to be trimmed as presumed prose and put back
    // afterwards. In a query string it is not prose, it is the value:
    // `?token=!!!` is a valid configured URL whose secret is punctuation and
    // nothing else, and the restore handed that token back whole. Arbitrary
    // log text cannot tell a token made of punctuation from a sentence that
    // ends in one, so the ambiguity is resolved toward disclosure safety: a
    // sentence-ending period after a sensitive URL is absorbed into the
    // marker. That costs a character of prose on origins already known to
    // carry a secret; the alternative cost was the secret.
    //
    // Unregistered origins are returned untouched below, so ordinary
    // diagnostic URLs keep their punctuation byte-for-byte.
    //
    // There is also no text-level shortcut for already-scrubbed input.
    // Skipping anything that *ended* with the marker was a bypass, not an
    // optimization: `https://host/tenant/SECRET[redacted]` is a valid
    // configured value, and that check handed it back with the secret intact.
    // Idempotence is structural instead - `origin[redacted]` is not a
    // parseable URL, because a bracket is illegal in a hostname unless it
    // delimits an IPv6 literal, so parseHttpUrl rejects it and a second pass
    // finds nothing to rewrite, for a bare host, a host with a port, and an
    // IPv6 literal alike.
    const parsed = parseHttpUrl(match)
    if (!parsed || !sensitiveOrigins.has(parsed.origin)) {
      return match
    }

    // Where the authority ends in the *matched text*, which may differ from
    // the canonical origin in case or port. Nothing after it means nothing to
    // hide.
    //
    // Backslash ends the authority exactly as "/" does: WHATWG normalizes it
    // to "/" for http(s), so `https://host\tenant` has "tenant" in its path,
    // not its host. Omitting it here would classify that URL as origin-only
    // and return it unredacted.
    const authorityStart = match.indexOf("://") + 3
    let authorityEnd = match.length
    for (let index = authorityStart; index < match.length; index += 1) {
      const character = match[index]
      if (
        character === "/"
        || character === "\\"
        || character === "?"
        || character === "#"
      ) {
        authorityEnd = index
        break
      }
    }

    return authorityEnd === match.length ?
        match
      : `${parsed.origin}${redactedMarker}`
  })
}
