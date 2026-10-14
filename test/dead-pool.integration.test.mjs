/**
 * Issue #1, pinned over the REAL transport (global fetch, no `fetchImpl`).
 *
 * The field failure: a long-lived host process rides the process-wide
 * connection pool, and the first call after an idle gap draws a connection
 * the intermediary silently dropped — the request hangs to its deadline,
 * every time, while a fresh process always lands. The live intermediary
 * that dropped idle sockets (~30s) on 2026-09-28 cannot be summoned on
 * demand, so this suite replays its shape deterministically: a local server
 * that answers the FIRST request on every connection and swallows the rest
 * (socket held open, no response, no FIN) — exactly what a half-open pooled
 * connection feels like to undici.
 *
 * Two facts are pinned here, and the second is why the fix is a retry:
 * the timeout abort destroys the poisoned socket (undici cannot know a
 * socket with an unanswered request is reusable, so it frees it), which is
 * what makes the retry's fresh connection land.
 *
 * Connection COUNTS are deliberately not asserted: after an abort, undici
 * may open a socket it never sends a request on (observed as an accept with
 * no request event), and that is an implementation detail. What matters is
 * WHICH connection served the successful request.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { classify, JevTimeoutError } from '../lib/index.js'

const questions = { probe: { type: 'noul', criteria: { true: 'a', false: 'b' } } }

/**
 * A keep-alive server that poisons its own pool: request n=1 per connection
 * gets a valid verdict, n>=2 is read and never answered. Returns the call
 * helper (same origin, so undici pools across calls), a per-request log of
 * `{ connection, nth, answered }`, and its cleanup.
 */
async function startSwallowServer() {
  const perSocket = new WeakMap()
  const connections = []
  const log = []
  const server = http.createServer((req, res) => {
    const n = (perSocket.get(req.socket) ?? 0) + 1
    perSocket.set(req.socket, n)
    const answered = n === 1
    log.push({ connection: connections.indexOf(req.socket), nth: n, answered })
    if (answered) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'keep-alive', 'keep-alive': 'timeout=30' })
      res.end(JSON.stringify({ answers: { probe: { noul: 0.5 } } }))
    }
    // n >= 2: the swallow — hold the socket open, respond with nothing.
  })
  // Outlive the test window so the server's own keep-alive timer never FINs
  // the poisoned socket before the client's deadline does.
  server.keepAliveTimeout = 30_000
  server.on('connection', (socket) => connections.push(socket))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${server.address().port}/v1/systemone`
  const call = (retries, timeoutMs) => classify({ questions, state: 'probe', apiKey: 'sk-test', endpoint, retries, timeoutMs, env: {} })
  return {
    call,
    log,
    cleanup: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

/** An idle gap long enough for a consumed socket to settle into the pool —
 *  without it the next call races the teardown and draws a fresh socket,
 *  which is the one way this repro refuses to reproduce. */
const idleGap = () => new Promise((resolve) => setTimeout(resolve, 50))

test('issue #1: a timeout retry lands on a fresh connection while the poisoned one still hangs', async () => {
  const net = await startSwallowServer()
  try {
    await net.call(0, 1_000) // warm the pool: socket #0 served one verdict and went back in
    await idleGap()
    const t0 = Date.now()
    const result = await net.call(1, 1_000)
    const elapsed = Date.now() - t0
    assert.equal(result.answers.probe.value, 0.5)
    // Attempt 1 really did burn its budget on the swallowed request (≈ half
    // of 1000ms) — a first-try success would have returned in ~10ms.
    assert.ok(elapsed >= 300, `elapsed ${elapsed}ms — attempt 1 must hang on the poisoned socket`)
    assert.ok(elapsed < 1_000, `elapsed ${elapsed}ms — the caller's deadline contract must hold`)
    // Three requests: warmup answered, attempt 1 swallowed on the SAME
    // connection, the retry answered from a connection's FIRST request.
    assert.deepEqual(net.log.map((row) => [row.connection, row.nth, row.answered]), [
      [0, 1, true],
      [0, 2, false],
      [1, 1, true],
    ])
  } finally {
    net.cleanup()
  }
})

test('issue #1: without retries the poisoned socket costs the verdict, and the abort is what frees the pool', async () => {
  const net = await startSwallowServer()
  try {
    await net.call(0, 1_000) // warm the pool
    await idleGap()
    const t0 = Date.now()
    await assert.rejects(net.call(0, 800), JevTimeoutError)
    const elapsed = Date.now() - t0
    assert.ok(elapsed >= 700, `elapsed ${elapsed}ms — the field symptom: the full deadline, wasted`)
    // The failed call's abort destroyed the poisoned socket, so the very next
    // plain call lands — the 0.1.4 self-heal, one lost verdict per idle gap.
    const healed = await net.call(0, 800)
    assert.equal(healed.answers.probe.value, 0.5)
    assert.deepEqual(net.log.map((row) => [row.connection, row.nth, row.answered]), [
      [0, 1, true],
      [0, 2, false],
      [1, 1, true],
    ])
  } finally {
    net.cleanup()
  }
})
