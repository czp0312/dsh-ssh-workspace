import test from 'node:test'
import assert from 'node:assert/strict'
import { groupWorkspaces, aggregateState, backendState } from '../src/workspace-groups.js'
import { environmentKey, type RemoteTarget, type WorkspaceView } from '../src/types.js'
const target: RemoteTarget = { kind: 'wsl', distribution: 'Ubuntu', remotePath: '/srv/api' }
const row = (id: string, changes: Partial<WorkspaceView> = {}): WorkspaceView => ({ id, workspaceId: id, title: id, localPath: '/srv/api', target, mode: 'full', createdAt: 1, registered: true, connectionState: 'connected', backendId: 'shared', ...changes })

test('environment grouping separates transport ownership from machine identity', () => {
  const groups = groupWorkspaces([row('a'), row('b', { target: { ...target, remotePath: '/srv/worker' } }), row('root', { backendId: 'root', target: { ...target, user: 'root' } }), row('light', { mode: 'light', backendId: undefined })])
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0]!.connections.map(group => group.rows.map(item => item.id)), [['a', 'b'], ['root']])
  assert.equal(groups[0]!.light.length, 1)
  assert.equal(groupWorkspaces([row('a', { backendId: undefined }), row('b', { backendId: undefined })])[0]!.connections.length, 2)
})

test('filters retain all affected projects and exclude removed registrations', () => {
  const [group] = groupWorkspaces([row('a'), row('b'), row('c', { removedAt: 5 })], row => row.id === 'b')
  assert.deepEqual(group!.rows.map(row => row.id), ['a', 'b'])
  assert.deepEqual(group!.visible.map(row => row.id), ['b'])
  assert.equal(group!.connections[0]!.rows.length, 2)
  assert.equal(group!.connections[0]!.visible.length, 1)
})

test('SSH config ports and distinct Docker IDs cannot collapse to one environment', () => {
  const ssh = { kind: 'ssh' as const, host: 'dev', remotePath: '/' }
  assert.notEqual(environmentKey(ssh), environmentKey({ ...ssh, port: 22 }))
  assert.equal(environmentKey(ssh), environmentKey({ ...ssh, host: 'DEV', user: 'root', auth: 'password' }))
  const docker = { kind: 'docker' as const, container: 'a'.repeat(64), context: 'dev', remotePath: '/' }
  assert.equal(environmentKey(docker), environmentKey({ ...docker, containerName: 'renamed', remotePath: '/workspace' }))
  assert.notEqual(environmentKey(docker), environmentKey({ ...docker, container: 'a'.repeat(63) + 'b' }))
  assert.notEqual(environmentKey(docker), environmentKey({ ...docker, context: 'production' }))
})

test('transport health survives missing directories and environment state can be partial', () => {
  const missing = row('missing', { registered: false, connectionState: 'error', backendHealth: { connectionState: 'connected' } })
  assert.equal(backendState([missing]), 'connected')
  assert.equal(backendState([{ ...missing, disconnected: true }]), 'disconnected')
  assert.equal(aggregateState(['connected', 'error']), 'partial')
  assert.equal(aggregateState(['connected', 'disconnected']), 'partial')
  assert.equal(aggregateState(['error', 'connecting']), 'connecting')
})
