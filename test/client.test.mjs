import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRequestBody,
  classify,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  JevHttpError,
  JevInvalidResponseError,
  JevNoKeyError,
  JevTimeoutError,
} from '../lib/index.js'

const questions = {
  go: { type: 'noul', criteria: { true: 'delegate', false: 'keep' } },
}

/** A fully keyed-off call: no env, no keychain — for tests that control the key explicitly. */
const noAmbientKey = { env: {}, keychainRunner: () => null }

function okResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}

const fixturePayload = {
  model: 'jev-1.13.0',
  answers: { go: { noul: 0.82 } },
  usage: { input_tokens: 10, output_tokens: 2 },
}

beforeEach(() => {
  // The keychain memo is process-global; keep tests order-independent.
  clearKeychainCacheSafe()
})

function clearKeychainCacheSafe() {
  // Imported lazily to keep this helper resilient if the export surface evolves.
  return import('../lib/index.js').then(({ clearKeychainCache }) => clearKeychainCache())
}

test('classify: happy path — request shape, auth header, redirect policy, validated result', async () => {
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return okResponse(fixturePayload)
  }
  const result = await classify({ ...noAmbientKey, questions, state: 'fix the flaky e2e', apiKey: 'sk-test', fetchImpl })
  assert.equal(seen.url, DEFAULT_ENDPOINT)
  assert.equal(seen.init.method, 'POST')
  assert.equal(seen.init.headers.authorization, 'Bearer sk-test')
  assert.equal(seen.init.redirect, 'error')
  const body = JSON.parse(seen.init.body)
  assert.deepEqual(Object.keys(body), ['state', 'model', 'questions'])
  assert.equal(body.model, DEFAULT_MODEL)
  assert.equal(result.answers.go.value, 0.82)
  assert.equal(result.model, 'jev-1.13.0')
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 2 })
  assert.equal(typeof result.latencyMs, 'number')
})

test('classify: buildRequestBody deep-clones the question set', () => {
  const source = { q: { type: 'noul', criteria: { true: 'a', false: 'b' } } }
  const body = buildRequestBody(source, 'state text', 'jev-x')
  source.q.criteria.true = 'MUTATED'
  assert.equal(body.questions.q.criteria.true, 'a')
})

test('classify: no key from any source throws JevNoKeyError naming the sources', async () => {
  await assert.rejects(
    classify({ ...noAmbientKey, questions, state: 's' }),
    (error) => {
      assert.ok(error instanceof JevNoKeyError)
      assert.equal(error.code, 'no-key')
      assert.match(error.message, /TYPESAFE_API_KEY/)
      assert.match(error.message, /JEV_KEYCHAIN/)
      return true
    },
  )
})

test('classify: env TYPESAFE_API_KEY wins over env JEV_API_KEY; JEV_ENDPOINT/JEV_MODEL respected', async () => {
  let seen = null
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return okResponse(fixturePayload)
  }
  await classify({
    questions,
    state: 's',
    env: { TYPESAFE_API_KEY: 'env-primary', JEV_API_KEY: 'env-fallback', JEV_ENDPOINT: 'http://127.0.0.1:9/v1/systemone', JEV_MODEL: 'jev-9.9.9' },
    fetchImpl,
  })
  assert.equal(seen.url, 'http://127.0.0.1:9/v1/systemone')
  assert.equal(seen.init.headers.authorization, 'Bearer env-primary')
  assert.equal(JSON.parse(seen.init.body).model, 'jev-9.9.9')
})

test('classify: explicit apiKey beats env', async () => {
  let seen = null
  const fetchImpl = async (_url, init) => {
    seen = { init }
    return okResponse(fixturePayload)
  }
  await classify({
    questions,
    state: 's',
    apiKey: 'explicit',
    env: { TYPESAFE_API_KEY: 'env-primary' },
    fetchImpl,
  })
  assert.equal(seen.init.headers.authorization, 'Bearer explicit')
})

test('classify: HTTP error carries status and a bounded body snippet', async () => {
  const fetchImpl = async () => new Response('{"error":"quota"}'.repeat(50), { status: 429 })
  await assert.rejects(
    classify({ ...noAmbientKey, questions, state: 's', apiKey: 'k', fetchImpl }),
    (error) => {
      assert.ok(error instanceof JevHttpError)
      assert.equal(error.code, 'http')
      assert.equal(error.status, 429)
      assert.ok(error.message.includes('429'))
      assert.ok(error.message.length < 400)
      return true
    },
  )
})

test('classify: deadline exceeded maps to JevTimeoutError', async () => {
  const slowFetch = (_url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(okResponse(fixturePayload)), 5_000)
    init.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    })
  })
  await assert.rejects(
    classify({ ...noAmbientKey, questions, state: 's', apiKey: 'k', fetchImpl: slowFetch, timeoutMs: 50 }),
    (error) => {
      assert.ok(error instanceof JevTimeoutError)
      assert.equal(error.code, 'timeout')
      return true
    },
  )
})

test('classify: a caller abort rethrows as AbortError, never as timeout', async () => {
  const signal = AbortSignal.abort()
  const fetchImpl = async () => {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }
  await assert.rejects(
    classify({ ...noAmbientKey, questions, state: 's', apiKey: 'k', fetchImpl, signal }),
    (error) => error.name === 'AbortError',
  )
})

test('classify: non-JSON 200 is an invalid response, not a crash', async () => {
  const fetchImpl = async () => new Response('<html>bad gateway</html>', { status: 200 })
  await assert.rejects(
    classify({ ...noAmbientKey, questions, state: 's', apiKey: 'k', fetchImpl }),
    (error) => {
      assert.ok(error instanceof JevInvalidResponseError)
      assert.equal(error.code, 'invalid-response')
      return true
    },
  )
})

test('classify: structurally invalid answers fail strict validation', async () => {
  const fetchImpl = async () => okResponse({ model: 'jev-1.13.0', answers: {} })
  await assert.rejects(
    classify({ ...noAmbientKey, questions, state: 's', apiKey: 'k', fetchImpl }),
    /every asked question must be answered/,
  )
})

test('classify: answered-model echo is taken from the response, missing echo falls back to the request', async () => {
  const fetchA = async () => okResponse({ model: 'jev-1.13-free', answers: { go: { noul: 0.5 } } })
  const a = await classify({ questions, state: 's', apiKey: 'k', fetchImpl: fetchA })
  assert.equal(a.model, 'jev-1.13-free')

  const fetchB = async () => new Response(JSON.stringify({ answers: { go: { noul: 0.5 } } }), { status: 200 })
  const b = await classify({ questions, state: 's', apiKey: 'k', fetchImpl: fetchB })
  assert.equal(b.model, DEFAULT_MODEL)
})

test('classify: response with invalid usage still succeeds, usage null', async () => {
  const fetchImpl = async () => okResponse({ answers: { go: { noul: 0.5 } }, usage: { input_tokens: 'lots' } })
  const result = await classify({ questions, state: 's', apiKey: 'k', fetchImpl })
  assert.equal(result.usage, null)
})
