import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAnswers, normalizeUsage, sumTolerance } from '../lib/index.js'

const choiceQuestion = {
  type: 'choice',
  instructions: 'pick one',
  criteria: {
    alpha: 'first option',
    beta: 'second option',
    gamma: 'third option',
  },
}

const scoreQuestion = {
  type: 'score',
  criteria: ['S — small', 'M — medium', 'L — large'],
}

const noulQuestion = { type: 'noul', criteria: { true: 'yes', false: 'no' } }

test('tolerance scales with distribution size', () => {
  assert.ok(sumTolerance(4) > sumTolerance(2))
  assert.equal(sumTolerance(1), 0.005 + 0.0001)
})

test('choice: happy path with name-keyed probabilities', () => {
  const answers = normalizeAnswers(
    { answers: { q: { choice: 'beta', probabilities: { alpha: 0.2, beta: 0.5, gamma: 0.3 }, confidence: 0.5 } } },
    { q: choiceQuestion },
  )
  assert.equal(answers.q.kind, 'choice')
  assert.equal(answers.q.value, 'beta')
  assert.equal(answers.q.confidence, 0.5)
})

test('choice: positional probability array maps onto criteria order', () => {
  const answers = normalizeAnswers(
    { answers: { q: { choice: 'alpha', probabilities: [0.5, 0.3, 0.2] } } },
    { q: choiceQuestion },
  )
  assert.deepEqual(answers.q.probabilities, { alpha: 0.5, beta: 0.3, gamma: 0.2 })
})

test('choice: confidence falls back to the claimed option probability', () => {
  const answers = normalizeAnswers(
    { answers: { q: { choice: 'gamma', probabilities: { alpha: 0.1, beta: 0.2, gamma: 0.7 } } } },
    { q: choiceQuestion },
  )
  assert.equal(answers.q.confidence, 0.7)
})

test('choice: claimed option outside criteria is rejected', () => {
  assert.throws(
    () => normalizeAnswers({ answers: { q: { choice: 'delta', probabilities: { alpha: 1, beta: 0, gamma: 0 } } } }, { q: choiceQuestion }),
    /not in this request's criteria/,
  )
})

test('choice: probability key set must exactly equal criteria', () => {
  assert.throws(
    () => normalizeAnswers({ answers: { q: { choice: 'alpha', probabilities: { alpha: 1, beta: 0 } } } }, { q: choiceQuestion }),
    /exactly equal the criteria/,
  )
})

test('choice: non-argmax claim is rejected', () => {
  assert.throws(
    () => normalizeAnswers({ answers: { q: { choice: 'beta', probabilities: { alpha: 0.5, beta: 0.3, gamma: 0.2 } } } }, { q: choiceQuestion }),
    /argmax/,
  )
})

test('choice: argmax within rounding slack is accepted', () => {
  // beta 0.399 vs alpha 0.4 — the claimed option trails by exactly the 0.001 slack.
  const answers = normalizeAnswers(
    { answers: { q: { choice: 'beta', probabilities: { alpha: 0.4, beta: 0.399, gamma: 0.201 } } } },
    { q: choiceQuestion },
  )
  assert.equal(answers.q.value, 'beta')
})

test('choice: probability sum outside rounding tolerance is rejected', () => {
  assert.throws(
    () => normalizeAnswers({ answers: { q: { choice: 'alpha', probabilities: { alpha: 0.9, beta: 0.05, gamma: 0.01 } } } }, { q: choiceQuestion }),
    /outside rounding tolerance/,
  )
})

test('choice: rounding-tolerant sum is accepted', () => {
  // 0.995 with 3 options (tolerance 0.0151) — two-decimal rounding noise.
  const answers = normalizeAnswers(
    { answers: { q: { choice: 'alpha', probabilities: { alpha: 0.6, beta: 0.295, gamma: 0.1 } } } },
    { q: choiceQuestion },
  )
  assert.equal(answers.q.value, 'alpha')
})

test('score: positional array maps onto level names stripped of descriptions', () => {
  const answers = normalizeAnswers(
    { answers: { q: { score: 1, probabilities: [0.2, 0.5, 0.3] } } },
    { q: scoreQuestion },
  )
  assert.equal(answers.q.value, 1)
  assert.deepEqual(answers.q.probabilities, { S: 0.2, M: 0.5, L: 0.3 })
})

test('score: object keyed by stringified positions maps onto level names', () => {
  const answers = normalizeAnswers(
    { answers: { q: { score: 2, probabilities: { 0: 0.1, 1: 0.1, 2: 0.8 } } } },
    { q: scoreQuestion },
  )
  assert.deepEqual(answers.q.probabilities, { S: 0.1, M: 0.1, L: 0.8 })
})

test('score: score value may land between levels', () => {
  const answers = normalizeAnswers({ answers: { q: { score: 1.4, probabilities: [0.3, 0.4, 0.3] } } }, { q: scoreQuestion })
  assert.equal(answers.q.value, 1.4)
})

test('score: level key-set mismatch is rejected', () => {
  assert.throws(
    () => normalizeAnswers({ answers: { q: { score: 1, probabilities: { S: 0.5, M: 0.5 } } } }, { q: scoreQuestion }),
    /exactly equal the criteria levels/,
  )
})

test('noul: value in range passes; out of range rejects', () => {
  const answers = normalizeAnswers({ answers: { q: { noul: 0.8 } } }, { q: noulQuestion })
  assert.equal(answers.q.value, 0.8)
  assert.equal(answers.q.kind, 'noul')
  assert.throws(() => normalizeAnswers({ answers: { q: { noul: 1.5 } } }, { q: noulQuestion }), /not a number in \[0, 1\]/)
  assert.throws(() => normalizeAnswers({ answers: { q: { noul: 'high' } } }, { q: noulQuestion }), /not a number in \[0, 1\]/)
})

test('every asked question must be answered — no partial maps', () => {
  assert.throws(
    () => normalizeAnswers({ answers: { a: { noul: 0.5 } } }, { a: noulQuestion, b: noulQuestion }),
    /b: every asked question must be answered/,
  )
})

test('malformed payload shapes are rejected', () => {
  assert.throws(() => normalizeAnswers(null, { q: noulQuestion }), /response is not an object/)
  assert.throws(() => normalizeAnswers({}, { q: noulQuestion }), /no answers map/)
  assert.throws(() => normalizeAnswers({ answers: [] }, { q: noulQuestion }), /no answers map/)
  assert.throws(() => normalizeAnswers({ answers: { q: null } }, { q: noulQuestion }), /non-object/)
})

test('answers to unasked questions are ignored', () => {
  const answers = normalizeAnswers(
    { answers: { q: { noul: 0.5 }, stray: { noul: 0.9 } } },
    { q: noulQuestion },
  )
  assert.deepEqual(Object.keys(answers), ['q'])
})

test('usage: valid tokens kept; violations degrade to null (metadata never sinks a decision)', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 5, output_tokens: 7 }), { input_tokens: 5, output_tokens: 7 })
  assert.deepEqual(normalizeUsage({ input_tokens: -1 }), null)
  assert.deepEqual(normalizeUsage({ input_tokens: 1.5 }), null)
  assert.deepEqual(normalizeUsage('nope'), null)
  assert.deepEqual(normalizeUsage(undefined), null)
})
