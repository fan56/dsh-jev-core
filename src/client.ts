/**
 * The HTTP client: one call, N atomic questions, no retries, no cache, no
 * fallback. Transport policy is deliberately boring — a 5s total deadline
 * covering the whole exchange, `redirect: "error"` (an endpoint that
 * redirects is a misconfiguration, not a hint to follow), and the caller's
 * signal honored as-is (a caller abort rethrows as AbortError, never
 * masquerades as a timeout).
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

  const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
  const signal = options.signal !== undefined ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal

  let response: Response
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
  } catch (error) {
    if (options.signal?.aborted && isAbortError(error)) throw error
    if (isAbortError(error) || (error instanceof Error && error.name === 'TimeoutError')) {
      throw new JevTimeoutError(config.timeoutMs)
    }
    throw error
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
