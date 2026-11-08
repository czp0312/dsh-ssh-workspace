import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceConnections } from '../src/connections.js'
import type { SavedWorkspace, WorkspaceView } from '../src/types.js'

function fixture() {
  const calls: string[] = []
  const target = { kind: 'wsl' as const, distribution: 'Ubuntu', remotePath: '/project' }
  const saved = (id: string): SavedWorkspace => ({ id, workspaceId: id, title: id, target, localPath: '/project', createdAt: 1 })
  const manager = (mode: string) => ({
    list: (): WorkspaceView[] => [{ ...saved(mode), registered: true }],
    add: async () => { calls.push(mode + '/add'); return saved(mode) },
    reconnect: async () => { calls.push(mode + '/reconnect'); return saved(mode) },
    disconnect: async () => { calls.push(mode + '/disconnect') },
    remove: async () => { calls.push(mode + '/remove') },
  })
  return { calls, target, connections: new WorkspaceConnections(manager('light'), manager('full')) }
}

test('light mode only invokes the mount manager, full mode only invokes the remote backend manager', async () => {
  const f = fixture()
  assert.equal((await f.connections.add({ mode: 'light', target: f.target })).mode, 'light')
  assert.deepEqual(f.calls, ['light/add'])
  assert.equal((await f.connections.add({ mode: 'full', target: f.target })).mode, 'full')
  assert.deepEqual(f.calls, ['light/add', 'full/add'])
  assert.equal((await f.connections.add({ target: f.target })).mode, 'full')
})

test('switching connection modes reuses the other mode and never disconnects or removes the original', async () => {
  const f = fixture()
  assert.equal((await f.connections.reconnect('light', undefined, { mode: 'full' })).id, 'full')
  assert.equal((await f.connections.reconnect('full', undefined, { mode: 'light' })).id, 'light')
  assert.deepEqual(f.calls, ['full/reconnect', 'light/reconnect'])
  await f.connections.disconnect('light')
  assert.deepEqual(f.calls, ['full/reconnect', 'light/reconnect', 'light/disconnect'])
})

test('a new mode gets a distinct environment and a failed switch leaves the original usable', async () => {
  const records: WorkspaceView[] = [{ id: 'light-project', workspaceId: 'local-workspace', mode: 'light', title: 'Remote', target: { kind: 'ssh', host: 'test-host', remotePath: '/project' }, localPath: 'Z:\\project', createdAt: 1, registered: true }]
  const calls: any[] = []
  const light = { list: () => records, reconnect: async () => records[0]!, add: async () => records[0]!, disconnect: async () => { throw new Error('Must not disconnect the original') }, remove: async () => { throw new Error('Must not remove the original') } }
  let fail = true
  const full = { ...light, list: () => [], add: async (input: any) => { calls.push(input); if (fail) throw new Error('install failed'); return { ...records[0]!, id: 'full-project', workspaceId: 'dsh-remote:host:workspace', localPath: '/project' } } }
  const connections = new WorkspaceConnections(light, full)
  await assert.rejects(connections.reconnect('light-project', undefined, { mode: 'full' }), /install failed/)
  assert.equal((await connections.reconnect('light-project')).workspaceId, 'local-workspace')
  fail = false
  const next = await connections.reconnect('light-project', undefined, { mode: 'full' })
  assert.equal(next.workspaceId, 'dsh-remote:host:workspace')
  assert.equal(records[0]!.workspaceId, 'local-workspace')
  assert.equal(Object.hasOwn(calls[0], 'localPath'), false, 'a mount path is never sent to the full backend')
  await assert.rejects(connections.reconnect('light-project', undefined, { mode: 'invalid' as any }), /light 或 full/)
})

test('saved connections preserve their mode on reconnect/removal and old mount records are lightweight', async () => {
  const f = fixture()
  assert.deepEqual(f.connections.list().map(row => row.mode), ['light', 'full'])
  assert.equal((await f.connections.reconnect('light')).mode, 'light')
  assert.equal((await f.connections.reconnect('full')).mode, 'full')
  await f.connections.remove('light')
  await f.connections.remove('full')
  assert.deepEqual(f.calls, ['light/reconnect', 'full/reconnect', 'light/remove', 'full/remove'])
})

test('invalid modes and unknown saved identities fail before any remote operation', async () => {
  const f = fixture()
  await assert.rejects(f.connections.add({ mode: 'typo', target: f.target }), /light 或 full/)
  await assert.rejects(f.connections.reconnect('missing'), /不存在/)
  assert.deepEqual(f.calls, [])
})

test('switching one project to existing full mode uses a non-resetting connection path', async () => {
  const calls: string[] = []
  const make = (id: string, path: string, mode: 'light' | 'full'): WorkspaceView => ({ id, workspaceId: id, title: id, target: { kind: 'wsl', distribution: 'Ubuntu', remotePath: path }, localPath: path, createdAt: 1, registered: true, mode })
  const a = make('a-light', '/a', 'light')
  const aFull = make('a-full', '/a', 'full')
  const b = make('b-full', '/b', 'full')
  const base = { add: async () => { throw Error('must reuse') }, disconnect: async () => { throw Error('must not disconnect') }, remove: async () => { throw Error('must not remove') }, reconnect: async () => { throw Error('must not reset the shared tunnel') } }
  const full = { ...base, list: () => [aFull, b], connectProject: async (id: string) => { calls.push(id); return aFull } }
  const connections = new WorkspaceConnections({ ...base, list: () => [a] }, full)
  const result = await connections.reconnect(a.id, undefined, { mode: 'full' })
  assert.equal(result.workspaceId, 'a-full')
  assert.deepEqual(calls, ['a-full'])
  assert.equal(b.workspaceId, 'b-full')
  assert.equal(a.mode, 'light', 'original mode and its history remain available')
})
