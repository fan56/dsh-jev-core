/**
 * Strict single-level response validation — the reason this package exists.
 *
 * Community implementations validate answer TYPES and stop there; that lets
 * a well-typed but wrong distribution through (a non-argmax choice, a
 * probability set that doesn't cover the criteria, a missing answer that a
 * policy then reads as "no gate"). Here every rule is always on — there is
 * no lenient mode to reach for, and a rejection is a typed error that sends
 * the caller down its jev-optional fallback with nothing silently applied.
 *
 * Strictness has no cost by construction: validation failures are exactly
 * the cases where the caller was going to do nothing anyway.
 */

import type { JevAnswer, JevChoiceAnswer, JevNoulAnswer, JevQuestion, JevQuestions, JevScoreAnswer } from './types.ts'
import { JevInvalidResponseError } from './errors.ts'

/**
 * Rounding tolerance for probability sums: responses are rounded to two
 * decimals, so n options may miss 1.0 by up to 0.005 each. Derived from the
 * distribution size, not a global constant.
 */
export function sumTolerance(optionCount: number): number {
  return 0.005 * optionCount + 0.0001
}

function isUnitNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** The canonical level name for a score criterion — the text before the em-dash separator, if any. */
function levelName(entry: string): string {
  return String(entry).split(' — ')[0].trim()
}

function scoreLevelNames(question: JevQuestion): string[] {
  if (!Array.isArray(question.criteria) || question.criteria.length === 0) {
    throw new JevInvalidResponseError(`score question has no ordered criteria levels`)
  }
  return question.criteria.map((entry) => levelName(String(entry)))
}

function choiceOptionNames(question: JevQuestion): string[] {
  if (question.criteria === undefined || question.criteria === null || Array.isArray(question.criteria) || typeof question.criteria !== 'object') {
    throw new JevInvalidResponseError(`choice question has no criteria option map`)
  }
  const names = Object.keys(question.criteria)
  if (names.length === 0) throw new JevInvalidResponseError(`choice question has an empty criteria map`)
  return names
}

interface ProbabilityCheck {
  probabilities: Record<string, number>
}

/**
 * Normalize a choice response's probabilities onto the criteria names and
 * run the full rule set: key-set exact equality, unit range, sum tolerance,
 * and the argmax rule — the claimed choice must be the distribution's
 * maximum (within rounding slack ±0.001).
 */
function checkedChoiceProbabilities(
  raw: unknown,
  optionNames: readonly string[],
  claimed: string,
  questionId: string,
): ProbabilityCheck {
  if (raw === undefined || raw === null) {
    throw new JevInvalidResponseError(`${questionId}: choice answer carries no probabilities`)
  }
  let mapped: Record<string, number>
  if (Array.isArray(raw)) {
    mapped = {}
    optionNames.forEach((name, index) => {
      mapped[name] = raw[index]
    })
  } else if (typeof raw === 'object') {
    mapped = { ...(raw as Record<string, unknown>) } as Record<string, number>
  } else {
    throw new JevInvalidResponseError(`${questionId}: probabilities are neither a map nor an ordered array`)
  }

  const received = Object.keys(mapped)
  const missing = optionNames.filter((name) => !received.includes(name))
  const extra = received.filter((name) => !optionNames.includes(name))
  if (missing.length > 0 || extra.length > 0) {
    throw new JevInvalidResponseError(
      `${questionId}: probability key set must exactly equal the criteria`
        + `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}`
        + `${extra.length > 0 ? `; unexpected: ${extra.join(', ')}` : ''}`,
    )
  }
  for (const [name, value] of Object.entries(mapped)) {
    if (!isUnitNumber(value)) {
      throw new JevInvalidResponseError(`${questionId}: probability for "${name}" is not a number in [0, 1]`)
    }
  }
  const sum = optionNames.reduce((total, name) => total + (mapped[name] as number), 0)
  if (Math.abs(sum - 1) > sumTolerance(optionNames.length)) {
    throw new JevInvalidResponseError(`${questionId}: probabilities sum to ${sum.toFixed(4)}, outside rounding tolerance`)
  }
  const top = Math.max(...optionNames.map((name) => mapped[name] as number))
  if ((mapped[claimed] as number) < top - 0.001) {
    throw new JevInvalidResponseError(
      `${questionId}: claimed "${claimed}" (${mapped[claimed]}) is not the distribution's argmax (${top})`,
    )
  }
  return { probabilities: mapped }
}

/** Score probabilities may arrive positionally (array, or object keyed by stringified index) — map onto level names, then enforce key-set equality and the sum rule. */
function checkedScoreProbabilities(raw: unknown, question: JevQuestion, questionId: string): ProbabilityCheck {
  const names = scoreLevelNames(question)
  if (raw === undefined || raw === null) {
    throw new JevInvalidResponseError(`${questionId}: score answer carries no probabilities`)
  }
  let mapped: Record<string, number>
  if (Array.isArray(raw)) {
    mapped = {}
    names.forEach((name, index) => {
      mapped[name] = raw[index]
    })
  } else if (typeof raw === 'object') {
    mapped = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const position = Number.parseInt(key, 10)
      const isPositionalKey = Number.isSafeInteger(position) && String(position) === key && position >= 0 && position < names.length
      const name = isPositionalKey ? names[position] as string : key
      mapped[name] = value as number
    }
  } else {
    throw new JevInvalidResponseError(`${questionId}: probabilities are neither a map nor an ordered array`)
  }

  const received = Object.keys(mapped)
  const missing = names.filter((name) => !received.includes(name))
  const extra = received.filter((name) => !names.includes(name))
  if (missing.length > 0 || extra.length > 0) {
    throw new JevInvalidResponseError(
      `${questionId}: probability key set must exactly equal the criteria levels`
        + `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}`
        + `${extra.length > 0 ? `; unexpected: ${extra.join(', ')}` : ''}`,
    )
  }
  for (const [name, value] of Object.entries(mapped)) {
    if (!isUnitNumber(value)) {
      throw new JevInvalidResponseError(`${questionId}: probability for level "${name}" is not a number in [0, 1]`)
    }
  }
  const sum = names.reduce((total, name) => total + (mapped[name] as number), 0)
  if (Math.abs(sum - 1) > sumTolerance(names.length)) {
    throw new JevInvalidResponseError(`${questionId}: level probabilities sum to ${sum.toFixed(4)}, outside rounding tolerance`)
  }
  return { probabilities: mapped }
}

function checkedConfidence(raw: unknown, questionId: string): number | null {
  if (raw === undefined || raw === null) return null
  if (!isUnitNumber(raw)) throw new JevInvalidResponseError(`${questionId}: confidence is not a number in [0, 1]`)
  return raw
}

function normalizeChoice(id: string, question: JevQuestion, raw: Record<string, unknown>): JevChoiceAnswer {
  const claimed = raw['choice']
  if (typeof claimed !== 'string' || claimed === '') {
    throw new JevInvalidResponseError(`${id}: choice answer is not an option name`)
  }
  const optionNames = choiceOptionNames(question)
  if (!optionNames.includes(claimed)) {
    throw new JevInvalidResponseError(`${id}: claimed option "${claimed}" is not in this request's criteria`)
  }
  const { probabilities } = checkedChoiceProbabilities(raw['probabilities'], optionNames, claimed, id)
  const confidence = checkedConfidence(raw['confidence'], id) ?? probabilities[claimed] as number
  return { kind: 'choice', value: claimed, probabilities, confidence }
}

function normalizeScore(id: string, question: JevQuestion, raw: Record<string, unknown>): JevScoreAnswer {
  const value = raw['score']
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new JevInvalidResponseError(`${id}: score answer is not a non-negative number`)
  }
  const { probabilities } = checkedScoreProbabilities(raw['probabilities'], question, id)
  const confidence = checkedConfidence(raw['confidence'], id)
  const legend = typeof raw['legend'] === 'string' ? raw['legend'] : null
  return { kind: 'score', value, legend, probabilities, confidence }
}

function normalizeNoul(id: string, raw: Record<string, unknown>): JevNoulAnswer {
  const value = raw['noul']
  if (!isUnitNumber(value)) {
    throw new JevInvalidResponseError(`${id}: noul answer is not a number in [0, 1]`)
  }
  return { kind: 'noul', value }
}

/**
 * Validate a raw System One response payload against the exact question set
 * that was sent. Every asked question must be answered; anything less is a
 * typed rejection, never a partial answer map.
 */
export function normalizeAnswers(payload: unknown, questions: JevQuestions): Record<string, JevAnswer> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new JevInvalidResponseError('response is not an object')
  }
  const raw = (payload as Record<string, unknown>)['answers']
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new JevInvalidResponseError('response carries no answers map')
  }
  const answers = raw as Record<string, unknown>

  const out: Record<string, JevAnswer> = {}
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id]
    if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
      throw new JevInvalidResponseError(`${id}: every asked question must be answered; got ${answer === undefined ? 'no answer' : 'a non-object'}`)
    }
    const record = answer as Record<string, unknown>
    if (question.type === 'choice') out[id] = normalizeChoice(id, question, record)
    else if (question.type === 'score') out[id] = normalizeScore(id, question, record)
    else out[id] = normalizeNoul(id, record)
  }
  // Answers to questions we never asked are ignored — they carry no vote.
  return out
}

/** Validate the usage object; metadata problems never sink a valid decision, so violations degrade to null. */
export function normalizeUsage(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const usage = raw as Record<string, unknown>
  for (const key of ['input_tokens', 'output_tokens']) {
    if (usage[key] !== undefined && !isNonNegativeInteger(usage[key])) return null
  }
  return usage
}
