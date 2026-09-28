import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  clearKeychainCache,
  isConfigured,
  lookupKeychain,
  parseKeychainSpec,
  readKey,
  KEY_SOURCES,
} from '../lib/index.js'

beforeEach(() => {
  clearKeychainCache()
})

test('parseKeychainSpec: service-only and service:account shapes', () => {
  assert.deepEqual(parseKeychainSpec('typesafe.ai'), { service: 'typesafe.ai' })
  assert.deepEqual(parseKeychainSpec('typesafe.ai:fan56-main'), { service: 'typesafe.ai', account: 'fan56-main' })
  assert.deepEqual(parseKeychainSpec('  svc : acct '), { service: 'svc', account: 'acct' })
  assert.throws(() => parseKeychainSpec(''), /invalid JEV_KEYCHAIN spec/)
  assert.throws(() => parseKeychainSpec(':account-only'), /invalid JEV_KEYCHAIN spec/)
})

test('lookupKeychain: injectable runner receives the security argv', () => {
  let seen = null
  const secret = lookupKeychain({ service: 'typesafe.ai', account: 'fan56-main' }, (args) => {
    seen = args
    return 'sk-keychain-secret'
  })
  assert.equal(secret, 'sk-keychain-secret')
  assert.deepEqual(seen, ['find-generic-password', '-s', 'typesafe.ai', '-a', 'fan56-main'])
})

test('lookupKeychain: runner returning null or blank is an absent key', () => {
  assert.equal(lookupKeychain({ service: 'x' }, () => null), null)
  assert.equal(lookupKeychain({ service: 'x' }, () => '   '), null)
})

test('readKey: explicit option → TYPESAFE_API_KEY → JEV_API_KEY → keychain, in that order', () => {
  const runnerCalls = []
  const runner = (args) => {
    runnerCalls.push(args)
    return 'sk-keychain'
  }
  const base = { env: {}, keychainSpec: 'svc', keychainRunner: runner }

  assert.equal(readKey({ ...base, apiKey: 'explicit' }), 'explicit')
  assert.equal(readKey({ ...base, env: { TYPESAFE_API_KEY: 'primary' } }), 'primary')
  assert.equal(readKey({ ...base, env: { JEV_API_KEY: 'fallback' } }), 'fallback')
  assert.equal(readKey(base), 'sk-keychain')
  assert.equal(runnerCalls.length, 1)
})

test('readKey: keychain result is memoized per spec; blank env values are skipped', () => {
  let calls = 0
  const runner = () => {
    calls += 1
    return 'sk-once'
  }
  const base = { env: { TYPESAFE_API_KEY: '', JEV_API_KEY: '   ' }, keychainSpec: 'memo-svc', keychainRunner: runner }
  assert.equal(readKey(base), 'sk-once')
  assert.equal(readKey(base), 'sk-once')
  assert.equal(calls, 1)
  clearKeychainCache()
  assert.equal(readKey(base), 'sk-once')
  assert.equal(calls, 2)
})

test('readKey: a malformed spec is a silent absent key, not a throw', () => {
  assert.equal(readKey({ env: {}, keychainSpec: ':broken' }), null)
})

test('readKey: non-darwin default runner never throws (absent key)', () => {
  // Default runner with a service that cannot exist; on CI (linux) there is no
  // `security` binary at all, on macOS the lookup fails cleanly. Either way: null.
  assert.equal(readKey({ env: {}, keychainSpec: 'definitely-not-a-real-service-jev-core-test' }), null)
})

test('isConfigured: the jev-optional branch point', () => {
  assert.equal(isConfigured({ env: { TYPESAFE_API_KEY: 'x' } }), true)
  assert.equal(isConfigured({ env: {}, keychainRunner: () => null }), false)
})

test('KEY_SOURCES documents the resolution order', () => {
  assert.deepEqual(KEY_SOURCES, ['apiKey option', 'env TYPESAFE_API_KEY', 'env JEV_API_KEY', 'keychain (JEV_KEYCHAIN)'])
})
