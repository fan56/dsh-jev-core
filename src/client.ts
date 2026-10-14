/**
 * The HTTP client: one call, N atomic questions, no cache, no fallback.
 * Transport policy is deliberately boring — a 5s total deadline covering the
 * whole exchange, `redirect: "error"` (an endpoint that redirects is a
 * misconfiguration, not a hint to follow), and the caller's signal honored
 * as-is (a caller abort rethrows as AbortError, never masquerades as a
 * timeout). Retries are opt-in and only ever re-attempt a timeout, inside the
 * SAME total deadline (see `retries`): the one failure mode they fix is a
 * pooled dead connection, where the retry's fresh connection is the cure and
 * any other error would fail the same way twice.
 */

import type { JevAnswers, JevClassifyResult, JevQuestions } from './types.ts'
import { JevHttpError, JevInvalidResponseError, JevNoKeyError, JevTimeoutError } from './errors.ts'
import { KEY_SOURCES, readKey, type KeySources } from './key.ts'
import { normalizeAnswers, normalizeUsage } from './validate.ts'

export const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
/** Pinned versioned id, never an alias — aliases drift silently across releases and invalidate thresholds and eval numbers. */
export const DEFAULT_MODEL = 'jev-1.13.0'
export const DEFAULT_TIMEOUT_MS = 5_000

export interface JevEnv {
  JEV_ENDPOINT?: string
  JEV_MODEL?: string
  TYPESAFE_API_KEY?: string
  JEV_API_KEY?: string
  JEV_KEYCHAIN?: string
}

export interface JevCallOptions extends KeySources {
  /** The exact question set sent on the wire — what is configured is what is asked. */
  questions: JevQuestions
  /** The state text under evaluation (redact before it leaves the machine — that is the caller's job, not the core's). */
  state: string
  endpoint?: string
  model?: string
  timeoutMs?: number
  /**
   * Extra attempts after a `JevTimeoutError`, inside the SAME total deadline
   * (`timeoutMs` is never exceeded — earlier attempts give up time to later
   * ones). Only a timeout retries: the failure it cures is a pooled dead
   * connection in a long-lived host process, where the abort destroys the
   * poisoned socket and the retry rides a fresh one that lands; any other
   * error (HTTP status, bad key, invalid body) would recur, so it throws
   * immediately. 0 (default) keeps the strict one-call contract.
   */
  retries?: number
  /** Total deadline override; covers connection, write, and body read. */
  signal?: AbortSignal
  /** Injectable for tests and for routing through a proxy. */
  fetchImpl?: typeof fetch
}

export interface ResolvedJevConfig {
  endpoint: string
  model: string
  timeoutMs: number
}

export function resolveConfig(options: Pick<JevCallOptions, 'endpoint' | 'model' | 'timeoutMs'>, env: JevEnv = process.env): ResolvedJevConfig {
  return {
    endpoint: options.endpoint ?? env.JEV_ENDPOINT ?? DEFAULT_ENDPOINT,
    model: options.model ?? env.JEV_MODEL ?? DEFAULT_MODEL,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  }
}

/** The exact request body — exported so contract tests and replay tooling assert the real wire shape. Deep-clones the questions. */
export function buildRequestBody(questions: JevQuestions, state: string, model: string): { state: string; model: string; questions: JevQuestions } {
  if (typeof state !== 'string' || state === '') throw new JevInvalidResponseError('state must be a non-empty string')
  return { state, model, questions: structuredClone(questions) }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/** The deadline fired (ours or a caller's AbortSignal.timeout bubbling through). */
function isDeadlineError(error: unknown): boolean {
  return isAbortError(error) || (error instanceof Error && error.name === 'TimeoutError')
}

/**
 * A `fetch` network failure arrives as `TypeError: fetch failed` with the real
 * reason (TLS, DNS, reset, proxy) buried in `.cause` — often two levels deep.
 * Flattening the chain into the message is what makes a verdict-log row
 * diagnosable; the 0.1.3 in-host investigation was blinded by exactly this
 * gap. The error object is ours to throw, so the type and `cause` stay intact.
 */
function flattenCause(error: Error): Error {
  let cause: unknown = error.cause
  let detail = ''
  for (let depth = 0; cause !== undefined && cause !== null && depth < 3; depth++) {
    detail += (detail === '' ? ' ' : ': ') + `(${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)})`
    cause = cause instanceof Error ? (cause.cause as unknown) : undefined
  }
  if (detail !== '') error.message = `${error.message}${detail}`
  return error
}

/**
 * Ask Jev one batched question set. Resolves with the strictly validated
 * answers or throws a typed JevError — there is no third outcome.
 */
export async function classify(options: JevCallOptions): Promise<JevClassifyResult> {
  // Endpoint/model resolution honors the caller's env object (tests inject one; host plugins may scope env per profile).
  const config = resolveConfig(options, options.env ?? process.env)
  const startedAt = Date.now()

  const key = readKey(options)
  if (key === null) throw new JevNoKeyError(KEY_SOURCES)

  const retries = options.retries ?? 0
  if (!Number.isInteger(retries) || retries < 0 || retries > 3) {
    throw new TypeError(`retries must be an integer in [0, 3], got ${options.retries}`)
  }
  const attempts = 1 + retries

  let response: Response
  for (let attempt = 1; ; attempt++) {
    // Later attempts are paid for by earlier ones: every non-final attempt
    // reserves half the total budget (capped at 2s — a fresh connection that
    // cannot land in 2s will not land in 5s either), so the caller's deadline
    // contract holds no matter how the attempts divide it.
    const reserveMs = attempt < attempts ? Math.min(2_000, Math.ceil(config.timeoutMs / 2)) : 0
    const remainingMs = config.timeoutMs - (Date.now() - startedAt)
    const attemptTimeoutMs = Math.max(1, remainingMs - reserveMs)
    const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs)
    const signal = options.signal !== undefined ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal

    try {
      response = await (options.fetchImpl ?? fetch)(config.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(buildRequestBody(options.questions, options.state, config.model)),
        redirect: 'error',
        signal,
      })
      break
    } catch (error) {
      if (options.signal?.aborted && isAbortError(error)) throw error
      if (isDeadlineError(error)) {
        // No backoff on purpose: the retry's value IS the fresh connection the
        // abort just freed, and any wait only eats the budget it rides on.
        if (attempt < attempts && Date.now() - startedAt < config.timeoutMs) continue
        throw new JevTimeoutError(config.timeoutMs)
      }
      throw error instanceof Error ? flattenCause(error) : error
    }
  }

  if (!response.ok) {
    const body = (await response.text().catch(() => '')).slice(0, 200)
    throw new JevHttpError(response.status, body)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new JevInvalidResponseError(`body is not JSON (${error instanceof Error ? error.message : String(error)})`)
  }

  const answers: JevAnswers = normalizeAnswers(payload, options.questions)
  const answered = payload as { model?: unknown; usage?: unknown }
  return {
    answers,
    model: typeof answered.model === 'string' && answered.model !== '' ? answered.model : config.model,
    usage: normalizeUsage(answered.usage),
    latencyMs: Date.now() - startedAt,
  }
}
