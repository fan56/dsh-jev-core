# Changelog

All notable changes to this project are documented in this file.

## Unreleased

## 0.1.2 - 2026-09-28

- Fix issue #1: long-lived host processes timed out on every call after the
  first — the global undici pool kept reusing a connection the intermediary
  had silently dropped (fresh processes reached the endpoint in ~400ms, so
  config/key/DNS were ruled out). `classify` now rides a throwaway
  `undici.Agent` per call (`close()`d in a finally), trading one extra TLS
  handshake for calls that always land. Regression test asserts two calls
  ride two server-observed connections.

## 0.1.0 - 2026-09-28

First release. Scope per the wayfinder decision ticket (dsh-jev-core API 面):

- `classify()` — one HTTP call, N atomic questions; no retries, 5s default deadline, `redirect: "error"`.
- `buildRequestBody()` — exported for contract tests and replay tooling; deep-clones the question set.
- `normalizeAnswers()` — strict single-level response validation: choice must be a known option and the argmax of its own probability distribution, probability key sets must exactly equal the criteria, sums within rounding tolerance, every asked question must be answered.
- `readKey()` / `isConfigured()` — keychain-first resolution (`JEV_KEYCHAIN='<service>[:<account>]'` on macOS) with env fallback (`TYPESAFE_API_KEY`, then `JEV_API_KEY`). Letting consumers branch on a query instead of a try/catch is the jev-optional contract.
- Typed errors (`JevNoKeyError` / `JevTimeoutError` / `JevHttpError` / `JevInvalidResponseError`); the core never falls back — degradation is the caller's policy.
- Deliberately out: caching, circuit breaking, budget guards, retries (fail-open advisory callers have no cache hits to win; see the map's fog list).
