# @aiwayds/dsh-jev-core

[中文](./README.md) | English

Shared [TypeSafe Jev](https://typesafe.ai) (System One) decision-model client for the dsh ecosystem: one HTTP call carries N atomic questions (`choice` / `score` / `noul`); responses come back through **strict single-level validation** as typed judgments.

**Jev-optional is a design constraint, not an add-on**: every consumer branches on `isConfigured()` and owns its fallback (dispatch stays silent, attention ranks heuristically). The core itself **never falls back** — it either returns a judgment or throws a typed error.

## Why strict, single-level

Community implementations validate answer TYPES and stop there, letting well-typed but wrong distributions through: a claimed option that is not the argmax of its own probability distribution, a probability map that does not cover the criteria, a question that was never answered (which a policy then reads as "no gate"). Every rule here is **always on** — there is no lenient mode to reach for, and validation failures are exactly the cases where the caller was going to do nothing anyway, so strictness costs nothing:

- **Argmax rule**: the claimed choice must be the maximum of its own distribution (±0.001 rounding slack)
- **Exact key-set equality**: probability keys must correspond one-to-one with this request's criteria
- **Sum tolerance**: |sum − 1| ≤ `0.005×n + 0.0001` (two-decimal rounding noise)
- **Every asked question answered**: no partial answer maps, ever
- **Score position mapping**: position-keyed probabilities (arrays or stringified indices) are mapped onto level names before validation

## Install

```sh
npm install @aiwayds/dsh-jev-core
```

Zero runtime dependencies; Node ≥ 22 (native fetch); ESM.

## Quick start

```js
import { classify, isConfigured, JevError } from '@aiwayds/dsh-jev-core'

const questions = {
  delegate: { type: 'noul', criteria: { true: 'should delegate', false: 'main agent handles it' } },
  tier: { type: 'choice', instructions: 'pick a complexity tier', criteria: { quick: 'mechanical', deep: 'needs thought' } },
}

if (isConfigured()) {
  try {
    const { answers, usage, latencyMs } = await classify({ questions, state: 'fix the flaky e2e timer' })
    // answers.delegate.value ∈ [0,1]; answers.tier is an argmax-validated choice
  } catch (error) {
    if (error instanceof JevError) {
      // 'no-key' | 'timeout' | 'http' | 'invalid-response' — degradation is the caller's policy
    }
  }
} else {
  // jev-optional: take the local heuristic path
}
```

## API

| Export | Purpose |
| --- | --- |
| `classify(options)` | One judgment call; resolves `{ answers, model, usage, latencyMs }` or throws a typed error |
| `buildRequestBody(questions, state, model)` | The exact request body (deep-clones questions) — for contract tests and replay tooling |
| `normalizeAnswers(payload, questions)` | The strict validator itself; reused by replay and unit tests |
| `normalizeUsage(payload)` | Usage-metadata validation; violations degrade to null (metadata never sinks a valid decision) |
| `readKey(sources?)` | Key resolution in a fixed order (below) |
| `isConfigured(sources?)` | The jev-optional branch point: query configuration instead of try/catching a call |
| `sumTolerance(n)` | The probability-sum tolerance formula |
| `JevError` and subclasses | `code`: `'no-key'` / `'timeout'` / `'http'` / `'invalid-response'` — **match on code, never on message text** |
| `DEFAULT_ENDPOINT` / `DEFAULT_MODEL` / `DEFAULT_TIMEOUT_MS` | `https://api.typesafe.ai/v1/systemone` / `jev-1.13.0` (pinned, never an alias) / 5000ms |

### Key resolution order (keychain-first, no plaintext in config)

1. Explicit `apiKey` option
2. env `TYPESAFE_API_KEY`
3. env `JEV_API_KEY`
4. macOS Keychain via `JEV_KEYCHAIN='<service>[:<account>]'` (default service `typesafe.ai`), read with `security find-generic-password`, **memoized per spec** (rotate the key → restart to pick it up)

Any failure outside the keychain — missing entry, no binary, non-macOS — resolves to "no key" (null / `isConfigured() === false`) and never throws: an absent key is a configuration state, not an error. Validate a `JEV_KEYCHAIN` spec explicitly at boot with `parseKeychainSpec()`.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — | Primary env entry (matches dsh-jev-mcp's native backend) |
| `JEV_API_KEY` | — | Fallback env entry |
| `JEV_KEYCHAIN` | `typesafe.ai` | macOS Keychain spec `'<service>[:<account>]'` |
| `JEV_ENDPOINT` | Official endpoint | Advanced/testing hook (local mock, etc.) |
| `JEV_MODEL` | `jev-1.13.0` | Pinned id — aliases drift silently across releases; upgrade deliberately |

## Design boundaries (deliberately absent)

- **No retries in the core**: a once-triggered caller deserves one retry, a fire-and-forget caller does not — that is caller policy
- **No caching**: consumers whose state text changes every turn have a ~0% hit rate
- **No circuit breaking**: breakers exist for execution-model failover; an advisory call's fail-open (skip) already is the fallback
- **Corrupt usage never fails the call**: metadata degrades to null
- **Caller aborts rethrow as-is**: a caller cancel is an `AbortError`, never disguised as a timeout

## Ecosystem consumers

- `@aiwayds/dsh-jev-dispatch` (planned): pre-step dispatch advice on `agent/pre-step`
- dsh-tui-pi attention (planned): mid-flight subagent attention scoring
- [dsh-jev-mcp](https://github.com/fan56/dsh-jev-mcp) (MCP-shaped, independent implementation): the keychain/endpoint conventions originate there

## License

[MIT](./LICENSE)
