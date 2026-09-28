import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { classify } from '../lib/index.js'

/**
 * Issue #1 regression: a long-lived process must not have its second call
 * die on a pooled dead connection. One-shot agents mean one TCP connection
 * per call — asserted from the SERVER side (two calls, two connections),
 * which is the exact property the pool bug violated.
 */
test('classify uses a fresh connection per call (no pooled reuse)', async () => {
  let connections = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const payload = JSON.parse(body)
      const answers = {}
      for (const id of Object.keys(payload.questions ?? {})) answers[id] = { noul: 0.5 }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ model: 'jev-1.13.0', answers }))
    })
  })
  server.on('connection', () => { connections += 1 })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const env = { JEV_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone`, TYPESAFE_API_KEY: 'x' }
  const questions = { q: { type: 'noul', criteria: { true: 'y', false: 'n' } } }

  try {
    const first = await classify({ questions, state: 'one', env })
    assert.equal(first.answers.q.value, 0.5)
    const second = await classify({ questions, state: 'two', env })
    assert.equal(second.answers.q.value, 0.5)
    assert.equal(connections, 2, 'two calls must ride two separate connections')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
