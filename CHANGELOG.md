# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- 0.2.1-rc.2 wave: zero-change repo (no host seam, no `@deepseek-ai/*` pins, no CI closure-tower block) — dependencies reinstalled against registry.npmjs.org and verified green as-is: typecheck clean, 50/0 tests.

## 0.1.5 - 2026-10-14

- fix: `retries` option — opt-in timeout-only retries inside the SAME total
  deadline (issue #1, the shipped fix). A long-lived host process rides the
  process-wide connection pool, and the first call after an idle gap can draw
  a connection the intermediary silently dropped: it hangs to its deadline,
  every time, while a fresh process lands in ~400ms. `retries: 1` re-attempts
  a timeout once; the abort destroys the poisoned socket, so the retry rides a
  fresh connection and lands. The caller's deadline contract is unchanged —
  earlier attempts give up budget (half the total, capped at 2s) so the total
  never exceeds `timeoutMs`. Only timeouts retry: any other error (HTTP
  status, bad key, invalid body) would recur, so it throws immediately. The
  design-boundary note is amended, not abandoned: whether to opt in stays
  caller policy — the core never retries on its own.
  `test/dead-pool.integration.test.mjs` pins the shape over the REAL
  transport: a local server answers a connection's first request and swallows
  the rest, and the suite asserts the retry's success comes from a fresh
  connection's first request while the total stays under the caller's
  deadline.
- fix: network failures now carry their cause chain in the message
  (`fetch failed (TypeError: ...): (Error: ...)`). The 0.1.3 in-host
  investigation was blinded by exactly this gap: the verdict log recorded
  "fetch failed" while the real reason (TLS/DNS/proxy, often nested in
  `.cause`) was discarded.
- docs: the "no bare dispatcher" policy is now written down where the next
  transport experiment will read it — a per-call `undici.Agent` passed as
  `dispatcher` silently bypasses the host's process-wide proxy policy
  (`dsh-http-proxy`), which is why both 0.1.2/0.1.3 pairings were dead ends
  by policy, not just by bug.

## 0.1.4 - 2026-09-28

- Revert the 0.1.2/0.1.3 transport experiments (issue #1 stays OPEN):
  - 0.1.2: npm-undici Agent + built-in fetch — version mismatch on Node 22
    ("invalid onRequestStart method"), never published.
  - 0.1.3: same-source npm-undici Agent+fetch — lands fine in a plain
    process (460ms) but fails inside the real dsh host process ("fetch
    failed"); root cause not yet found (host network layer interaction).
  - 0.1.4 restores the 0.1.0 global-fetch transport: first call per process
    lands, later calls may hit the pooled-dead-connection timeout and fail
    OPEN exactly as designed. Both dead ends are documented on issue #1.

## 0.1.3 - 2026-09-28

- Fix the 0.1.2 CI break (the 0.1.2 tag never reached npm): pairing the npm
  undici package's `Agent` with the BUILT-IN global fetch is a version
  mismatch ("invalid onRequestStart method" on Node 22). The Agent and the
  fetch now both come from the npm undici package — same source, no mismatch.

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
