import test from 'node:test'
import assert from 'node:assert/strict'
import { managementFetch } from '../src/rpc.js'

test('management RPC validates the correlated envelope before dispatch', async () => {
  let calls = 0
  const handler = managementFetch('add', async (_endpoint, payload) => { calls++; return { ok: true, value: payload } })
  const request = (body: unknown) => new Request('http://localhost/api/dsh-ssh-workspaces/add', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await handler(request({ type: 'client-request', rpcId: 'request-1', method: 'dsh-ssh-workspaces/remove', payload: {} }))).status, 400)
  assert.equal(calls, 0)
  const response = await handler(request({ type: 'client-request', rpcId: 'request-2', method: 'dsh-ssh-workspaces/add', payload: { title: 'Remote' } }))
  assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'request-2', result: { ok: true, value: { title: 'Remote' } } })
  assert.equal(calls, 1)
})

test('management RPC rejects malformed bodies and unsupported content types', async () => {
  const handler = managementFetch('status', async () => { throw new Error('must not dispatch') })
  assert.equal((await handler(new Request('http://localhost', { method: 'POST', body: 'untrusted' }))).status, 415)
  assert.equal((await handler(new Request('http://localhost', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{broken' }))).status, 400)
})
