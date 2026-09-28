/**
 * @aiwayds/dsh-jev-core — shared TypeSafe Jev client for the dsh ecosystem.
 *
 * Jev-optional by design: every consumer branches on `isConfigured()` and
 * owns its fallback (dispatch stays silent, attention ranks heuristically).
 * The core itself never falls back — it answers or throws a typed error.
 */

export * from './types.ts'
export * from './errors.ts'
export {
  clearKeychainCache,
  isConfigured,
  KEY_SOURCES,
  lookupKeychain,
  parseKeychainSpec,
  readKey,
  type KeySources,
} from './key.ts'
export { normalizeAnswers, normalizeUsage, sumTolerance } from './validate.ts'
export {
  buildRequestBody,
  classify,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  resolveConfig,
  type JevCallOptions,
  type JevEnv,
  type ResolvedJevConfig,
} from './client.ts'
