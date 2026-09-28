/**
 * Typed failure surface. The core NEVER falls back: every failure throws one
 * of these and the caller's jev-optional policy decides what happens next
 * (dispatch stays silent, attention ranks heuristically). A `JevError.code`
 * is a stable string — match on it, not on message text.
 */

export type JevErrorCode = 'no-key' | 'timeout' | 'http' | 'invalid-response'

export class JevError extends Error {
  readonly code: JevErrorCode

  constructor(code: JevErrorCode, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
  }
}

/** No API key from any configured source. Message names every source tried. */
export class JevNoKeyError extends JevError {
  constructor(sourcesTried: readonly string[]) {
    super('no-key', `no jev API key found (tried: ${sourcesTried.join(', ')})`)
  }
}

/** The call blew its total deadline (default 5s). Caller aborts rethrow as-is, never as this. */
export class JevTimeoutError extends JevError {
  constructor(timeoutMs: number) {
    super('timeout', `jev call exceeded its ${timeoutMs}ms deadline`)
  }
}

/** Non-2xx HTTP. `status` is exact; the body snippet (≤200 chars) is diagnostic only. */
export class JevHttpError extends JevError {
  readonly status: number

  constructor(status: number, bodySnippet: string) {
    super('http', `jev endpoint returned HTTP ${status}${bodySnippet ? ` — ${bodySnippet}` : ''}`)
    this.status = status
  }
}

/** The response arrived but is not a judgment we can trust: wrong shape, unknown option, non-argmax probabilities, missing answers. */
export class JevInvalidResponseError extends JevError {
  constructor(detail: string) {
    super('invalid-response', `jev response failed strict validation: ${detail}`)
  }
}
