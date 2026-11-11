import test from 'node:test'
import assert from 'node:assert/strict'
import { MANAGEMENT_ENDPOINTS, managementFetch, registerManagementRoutes } from '../src/rpc.js'

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

test('management routes register every dispatched endpoint, including host-key verification', async () => {
  const registered: string[] = []
  const ctx = {
    connection: { fetch: { register: (route: { path: string }) => { registered.push(route.path); return () => {} } } },
    effect: () => {},
  } as unknown as Parameters<typeof registerManagementRoutes>[0]
  registerManagementRoutes(ctx, async () => ({ ok: true, value: null }))
  assert.deepEqual(registered, MANAGEMENT_ENDPOINTS.map(endpoint => `/api/dsh-ssh-workspaces/${endpoint}`))
  for (const endpoint of ['hostkey/inspect', 'hostkey/trust']) {
    assert.ok((MANAGEMENT_ENDPOINTS as readonly string[]).includes(endpoint), endpoint)
    const handler = managementFetch(endpoint, async (_endpoint, payload) => ({ ok: true, value: payload }))
    const response = await handler(new Request('http://localhost', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'hostkey-1', method: `dsh-ssh-workspaces/${endpoint}`, payload: { target: { kind: 'ssh', host: 'example.test', remotePath: '/' } } }),
    }))
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { type: 'server-response', rpcId: 'hostkey-1', result: { ok: true, value: { target: { kind: 'ssh', host: 'example.test', remotePath: '/' } } } })
  }
})
