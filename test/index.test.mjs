import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as core from '../lib/index.js'

/** The published surface is a contract — this test breaks when an export moves or vanishes. */
test('export surface', () => {
  const expected = {
    // types
    JevQuestionType: undefined, // type-only — absent at runtime, checked by tsc
    // errors
    JevError: 'function',
    JevNoKeyError: 'function',
    JevTimeoutError: 'function',
    JevHttpError: 'function',
    JevInvalidResponseError: 'function',
    // key
    clearKeychainCache: 'function',
    isConfigured: 'function',
    KEY_SOURCES: 'object',
    lookupKeychain: 'function',
    parseKeychainSpec: 'function',
    readKey: 'function',
    // validate
    normalizeAnswers: 'function',
    normalizeUsage: 'function',
    sumTolerance: 'function',
    // client
    buildRequestBody: 'function',
    classify: 'function',
    DEFAULT_ENDPOINT: 'string',
    DEFAULT_MODEL: 'string',
    DEFAULT_TIMEOUT_MS: 'number',
    resolveConfig: 'function',
  }
  for (const [name, kind] of Object.entries(expected)) {
    if (kind === undefined) continue
    assert.equal(typeof core[name], kind, `export ${name}`)
  }
  assert.equal(core.DEFAULT_MODEL, 'jev-1.13.0', 'the pinned model id — aliases drift, this must be deliberate')
  assert.equal(core.DEFAULT_ENDPOINT, 'https://api.typesafe.ai/v1/systemone')
})

test('error classes carry stable codes', () => {
  assert.equal(new core.JevNoKeyError(['a']).code, 'no-key')
  assert.equal(new core.JevTimeoutError(5_000).code, 'timeout')
  assert.equal(new core.JevHttpError(429, '').code, 'http')
  assert.equal(new core.JevInvalidResponseError('x').code, 'invalid-response')
  for (const Ctor of [core.JevNoKeyError, core.JevTimeoutError, core.JevHttpError, core.JevInvalidResponseError]) {
    const err = Ctor === core.JevNoKeyError ? new Ctor(['a']) : Ctor === core.JevTimeoutError ? new Ctor(1) : Ctor === core.JevHttpError ? new Ctor(500, '') : new Ctor('x')
    assert.ok(err instanceof core.JevError)
  }
})
