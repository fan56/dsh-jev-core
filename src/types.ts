/**
 * Wire-contract types for the TypeSafe Jev (System One) decision API.
 *
 * The shapes mirror the documented `POST /v1/systemone` request/response.
 * Anything the strict validator rejects is a shape this contract does not
 * guarantee — consumers should treat a rejection as "no judgment" (their
 * jev-optional fallback), never as a partial answer.
 */

export type JevQuestionType = 'choice' | 'score' | 'noul'

export interface JevQuestion {
  type: JevQuestionType
  /**
   * Free text, or the structured `{ true, false }` / per-option maps the
   * native backend documents. Passed through verbatim — the core never
   * rewrites instructions.
   */
  instructions?: unknown
  /**
   * `choice`: map of option name → description (string or structured).
   * `score`: ordered level names, optionally `"Name — description"` (the
   * name before the em-dash separator is the canonical level name).
   * `noul`: pass `{ true, false }` criteria — single-sided instructions
   * measurably degrade calibration.
   */
  criteria?: Record<string, unknown> | string[]
}

export type JevQuestions = Record<string, JevQuestion>

export interface JevChoiceAnswer {
  kind: 'choice'
  /** The selected criteria key. */
  value: string
  /** Probability per option name; null never occurs from `normalizeAnswers` (strict mode requires it). */
  probabilities: Record<string, number> | null
  confidence: number | null
}

export interface JevScoreAnswer {
  kind: 'score'
  /** Position on the level spectrum; may land between levels (1.4 = between L1 and L2). */
  value: number
  legend: string | null
  /** Probability per canonical level name (position-keyed responses are mapped onto names). */
  probabilities: Record<string, number> | null
  confidence: number | null
}

export interface JevNoulAnswer {
  kind: 'noul'
  /** Probability in [0, 1]. Middle values are UNCERTAINTY, not positive evidence — threshold on the high segment only. */
  value: number
}

export type JevAnswer = JevChoiceAnswer | JevScoreAnswer | JevNoulAnswer
export type JevAnswers = Record<string, JevAnswer>

export interface JevUsage {
  input_tokens?: number
  output_tokens?: number
  [key: string]: unknown
}

export interface JevClassifyResult {
  answers: JevAnswers
  /** The model the backend says answered (may differ from the requested id when aliases resolve). */
  model: string
  /** Null when the response carries no usable usage object — metadata never sinks a valid decision. */
  usage: JevUsage | null
  latencyMs: number
}
