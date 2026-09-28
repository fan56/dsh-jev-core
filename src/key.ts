/**
 * Key resolution, keychain-first — the dsh-jev-mcp convention so config
 * files never carry plaintext:
 *
 *   explicit `apiKey` → env `TYPESAFE_API_KEY` → env `JEV_API_KEY`
 *     → macOS Keychain via `JEV_KEYCHAIN='<service>[:<account>]'`
 *       (default service `typesafe.ai`).
 *
 * The keychain lookup runs once per spec and is memoized (mcp's
 * restart-to-pick-up-a-new-key semantics). Every failure mode — missing
 * binary, missing entry, non-macOS — resolves to null, never throws: an
 * absent key is a configuration state, not an error.
 */

import { execFileSync } from 'node:child_process'

export interface KeychainSpec {
  service: string
  account?: string
}

/** Parse `'<service>[:<account>]'`. Throws on an empty/garbage spec — that is a config typo, not an absent key. */
export function parseKeychainSpec(spec: string): KeychainSpec {
  const trimmed = spec.trim()
  const separator = trimmed.indexOf(':')
  const service = separator === -1 ? trimmed : trimmed.slice(0, separator).trim()
  const account = separator === -1 ? undefined : trimmed.slice(separator + 1).trim() || undefined
  if (service === '') throw new Error(`invalid JEV_KEYCHAIN spec: ${JSON.stringify(spec)} (expected '<service>[:<account>]')`)
  return account === undefined ? { service } : { service, account }
}

/**
 * The runner is injectable for tests: `lookupKeychain(spec, fakeRunner)`.
 * A runner returns the secret string or null; it never throws.
 */
export type KeychainRunner = (args: readonly string[]) => string | null

function defaultRunner(args: readonly string[]): string | null {
  if (process.platform !== 'darwin') return null
  try {
    const out = execFileSync('security', [...args, '-w'], { encoding: 'utf8', timeout: 5_000 })
    const secret = out.trim()
    return secret === '' ? null : secret
  } catch {
    return null
  }
}

/** Query the macOS Keychain for one spec. Injectable runner, non-throwing; blank runner output is an absent key. */
export function lookupKeychain(spec: KeychainSpec, runner: KeychainRunner = defaultRunner): string | null {
  const args = ['find-generic-password', '-s', spec.service]
  if (spec.account !== undefined) args.push('-a', spec.account)
  const secret = runner(args)
  if (typeof secret !== 'string') return null
  const trimmed = secret.trim()
  return trimmed === '' ? null : trimmed
}

const keychainCache = new Map<string, string | null>()

function keychainKey(spec: KeychainSpec): string {
  return spec.account === undefined ? spec.service : `${spec.service}:${spec.account}`
}

/** Drop the memoized keychain lookups (tests, and long-lived processes that rotated a key without restarting). */
export function clearKeychainCache(): void {
  keychainCache.clear()
}

export interface KeySources {
  apiKey?: string
  /** Keychain spec override; defaults to env `JEV_KEYCHAIN`, else the `typesafe.ai` service. */
  keychainSpec?: string
  env?: NodeJS.ProcessEnv
  keychainRunner?: KeychainRunner
}

/** Ordered source labels for diagnostics — kept in one place so error messages never drift from the actual order. */
export const KEY_SOURCES = ['apiKey option', 'env TYPESAFE_API_KEY', 'env JEV_API_KEY', 'keychain (JEV_KEYCHAIN)'] as const

/** An env value that is absent, empty, or whitespace-only carries no key. */
function blankEnv(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === ''
}

/** Resolve the API key or null. Memoizes the keychain leg; env legs are read live. */
export function readKey(sources: KeySources = {}): string | null {
  const env = sources.env ?? process.env
  if (typeof sources.apiKey === 'string' && sources.apiKey.trim() !== '') return sources.apiKey
  if (!blankEnv(env['TYPESAFE_API_KEY'])) return env['TYPESAFE_API_KEY'] as string
  if (!blankEnv(env['JEV_API_KEY'])) return env['JEV_API_KEY'] as string

  const specSource = sources.keychainSpec ?? env['JEV_KEYCHAIN'] ?? 'typesafe.ai'
  let spec: KeychainSpec
  try {
    spec = parseKeychainSpec(specSource)
  } catch {
    return null // a malformed spec is a silent absent key for lookup purposes; parseKeychainSpec is exported for config validation at boot
  }
  const cacheKey = keychainKey(spec)
  if (keychainCache.has(cacheKey)) return keychainCache.get(cacheKey) ?? null
  const secret = lookupKeychain(spec, sources.keychainRunner)
  keychainCache.set(cacheKey, secret)
  return secret
}

/** The jev-optional branch point: consumers query this instead of try/catching a classify call. */
export function isConfigured(sources: KeySources = {}): boolean {
  return readKey(sources) !== null
}
