import test from 'node:test'
import assert from 'node:assert/strict'
import { idSource, payloadSource, remoteId, routeSource, translateIds } from '../src/backend-protocol.js'

test('backend identities round-trip without changing paths, prompt text or binary data', () => {
  const original = { workspaceId: 'workspace', sessionIds: ['same'], sourceSessionId: 'origin', beforeSessionId: 'anchor', path: '/same', text: 'same', data: Uint8Array.of(1, 2), resource: { kind: 'session', id: 'same' }, question: { id: 'same' }, model: { id: 'same' } }
  const incoming = translateIds(original, 'host-a', true)
  assert.equal(incoming.sessionIds[0], remoteId('host-a', 'same'))
  assert.equal(incoming.sourceSessionId, remoteId('host-a', 'origin'))
  assert.equal(incoming.beforeSessionId, remoteId('host-a', 'anchor'))
  assert.equal(incoming.resource.id, remoteId('host-a', 'same'))
  assert.equal(incoming.question.id, 'same')
  assert.equal(incoming.model.id, 'same')
  assert.deepEqual(translateIds(incoming, 'host-a', false), original)
  assert.notEqual(remoteId('host-a', 'same'), remoteId('host-b', 'same'))
  assert.equal(idSource('same'), undefined)
  assert.throws(() => idSource('dsh-remote:missing'), /Invalid remote/)
})

test('explicit local scopes override the selected remote backend', () => {
  assert.equal(routeSource({ args: { agentId: 'local-session' } }, 'host-a'), undefined)
  assert.equal(routeSource({ args: { request: { sessionId: 'local-session' } } }, 'host-a'), undefined)
  assert.equal(routeSource({ args: {} }, 'host-a'), 'host-a')
  assert.equal(routeSource({ args: { workspaceFileScopeId: remoteId('host-b', 'same') } }, 'host-a'), 'host-b')
})

test('cross-backend moves fail before dispatch, while a remote Session can allocate a fresh UUID', () => {
  assert.throws(() => payloadSource({ sessionId: remoteId('host-a', 'one'), workspaceId: remoteId('host-b', 'two') }), /Cross-backend/)
  assert.throws(() => routeSource({ workspaceId: remoteId('host-a', 'one'), beforeWorkspaceId: 'local' }), /local and remote/)
  assert.equal(routeSource({ workspaceId: remoteId('host-a', 'one'), sessionId: 'new-uuid' }, undefined, 'session/create'), 'host-a')
  assert.throws(() => translateIds({ agentId: remoteId('host-b', 'one') }, 'host-a', false), /different DSH backends/)
})

test('Session headers, subagent catalogs and job ownership retain the remote execution world', () => {
  const value = { header: { id: 'session', version: 1, parentSession: 'parent' }, subagentCatalog: [{ id: 'child', mode: 'continuable', createdAt: 1 }], changes: [{ key: 'subagentCatalog', val: [{ id: 'child' }] }], jobs: [{ id: 'bash-1', owner: 'session', kind: 'bash', startedAt: 1, output: {} }] }
  const translated = translateIds(value, 'host-a', true)
  assert.equal(translated.header.id, remoteId('host-a', 'session'))
  assert.equal(translated.header.parentSession, remoteId('host-a', 'parent'))
  assert.equal(translated.subagentCatalog[0].id, remoteId('host-a', 'child'))
  assert.equal(translated.changes[0].val[0].id, remoteId('host-a', 'child'))
  assert.equal(translated.jobs[0].owner, remoteId('host-a', 'session'))
  assert.equal(translated.jobs[0].id, 'bash-1')
  assert.deepEqual(translateIds(translated, 'host-a', false), value)
})
