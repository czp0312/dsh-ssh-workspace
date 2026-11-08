import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, unlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceManager } from '../src/manager.js'
import type { NativeWorkspace, NativeWorkspaceRegistry, WorkspaceTransport } from '../src/manager.js'
import { WorkspaceStore } from '../src/storage.js'
import type { RemoteTarget, SavedWorkspace } from '../src/types.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-manager-'))
  const mount = join(root, 'mount')
  const wrong = join(root, 'wrong')
  await Promise.all([mkdir(mount), mkdir(wrong)])
  const workspaces = new Map<string, NativeWorkspace>()
  let serial = 0
  const registry: NativeWorkspaceRegistry = {
    get: id => workspaces.get(id),
    resolveByPath: async path => [...workspaces.values()].find(row => row.path === path),
    create: async (path, title) => {
      const record = { id: `workspace-${++serial}`, path, title: title ?? 'project' }
      workspaces.set(record.id, record)
      return record
    },
    delete: async id => workspaces.delete(id),
  }
  const target: RemoteTarget = { kind: 'ssh', host: 'test-host', remotePath: '/srv/project' }
  let cleanups = 0
  const transport: WorkspaceTransport = {
    inspect: async remote => ({ path: remote.remotePath, user: 'developer', home: '/home/developer', platform: 'linux', python: '3.12' }),
    createMountProbe: async () => {
      const probe = { name: '.dsh-ssh-probe-test', token: 'unique-test-token' }
      await writeFile(join(mount, probe.name), probe.token, { flag: 'wx' })
      return probe
    },
    removeMountProbe: async (_target, name, token) => {
      assert.equal(await readFile(join(mount, name), 'utf8'), token)
      await unlink(join(mount, name))
      cleanups++
    },
  }
  const statePath = join(root, 'connections.json')
  const store = new WorkspaceStore(statePath)
  const manager = new WorkspaceManager(registry, transport, store, process.platform)
  await manager.load()
  return { root, mount, wrong, registry, workspaces, manager, store, statePath, transport, target, cleanups: () => cleanups }
}

test('registers one native workspace, persists identity and serializes concurrent adds', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
  const request = { target: f.target, localPath: f.mount, title: 'Remote project' }
  const [first, second] = await Promise.all([f.manager.add(request), f.manager.add(request)])
  assert.equal(first.id, second.id)
  assert.equal(f.workspaces.size, 1)
  assert.equal(f.manager.list()[0]?.workspaceId, first.workspaceId)
  const reopened = new WorkspaceStore(f.statePath)
  await reopened.load()
  assert.equal(reopened.list()[0]?.target.kind, 'ssh')
  assert.equal(f.cleanups(), 2)
})

test('rejects wrong mount and removes its remote identity probe', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
  await assert.rejects(f.manager.add({ target: f.target, localPath: f.wrong }), /不一致/)
  assert.equal(f.workspaces.size, 0)
  assert.equal(f.store.list().length, 0)
  assert.equal(f.cleanups(), 1)
})

test('does not rebind an existing local project to SSH', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
  const existing = await f.registry.create(f.mount, 'Local project')
  await assert.rejects(f.manager.add({ target: f.target, localPath: f.mount }), /本机项目/)
  assert.equal(f.workspaces.get(existing.id)?.title, 'Local project')
  assert.equal(f.workspaces.size, 1)
})

test('removal keeps files and routing for old sessions, re-add restores one record', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
  await writeFile(join(f.mount, 'keep.txt'), 'user data')
  const first = await f.manager.add({ target: f.target, localPath: f.mount })
  await f.manager.remove(first.id)
  assert.equal(f.workspaces.size, 0)
  assert.equal(f.manager.list().length, 0)
  assert.equal(await readFile(join(f.mount, 'keep.txt'), 'utf8'), 'user data')
  assert.equal(f.manager.forPath(join(f.mount, 'src'))?.id, first.id)
  const second = await f.manager.add({ target: f.target, localPath: f.mount })
  assert.equal(second.id, first.id)
  assert.notEqual(second.workspaceId, first.workspaceId)
  assert.equal(f.store.list().length, 1)
  assert.equal(f.manager.list()[0]?.registered, true)
})

test('failed ledger publication rolls back only the new native registration', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
  const store = { list: (): readonly SavedWorkspace[] => [], save: async () => { throw new Error('disk full') } } as unknown as WorkspaceStore
  const manager = new WorkspaceManager(f.registry, f.transport, store)
  await assert.rejects(manager.add({ target: f.target, localPath: f.mount }), /disk full/)
  assert.equal(f.workspaces.size, 0)
  assert.equal(await readFile(join(f.mount, '.dsh-ssh-probe-test'), 'utf8').catch(() => 'removed'), 'removed')
})

test('lightweight disconnect preserves folders and history routing, aborts commands and remains paused after reload', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
  const saved = await f.manager.add({ target: f.target, localPath: f.mount })
  const calls: AbortSignal[] = []
  f.transport.run = async (_target, _command, options) => {
    calls.push(options!.signal!)
    await new Promise<void>(resolve => options!.signal!.addEventListener('abort', () => resolve(), { once: true }))
    return { exitCode: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false, aborted: true }
  }
  assert.equal(f.manager.list()[0]!.connectionState, 'connected')
  const command = f.manager.run(saved.id, 'long command')
  await f.manager.disconnect(saved.id)
  assert.equal((await command).aborted, true)
  assert.equal(calls[0]!.aborted, true)
  assert.equal(f.workspaces.size, 1)
  assert.equal(f.manager.forPath(join(f.mount, 'src'))!.id, saved.id)
  assert.equal(f.manager.list()[0]!.connectionState, 'disconnected')
  await assert.rejects(f.manager.run(saved.id, 'must not run'), /已断开/)
  const reloaded = new WorkspaceManager(f.registry, f.transport, new WorkspaceStore(f.statePath))
  await reloaded.load()
  await reloaded.checkHealth(new AbortController().signal)
  assert.equal(reloaded.list()[0]!.connectionState, 'disconnected')
  assert.throws(() => reloaded.assertAvailable(saved.id), /已断开/)
  const next = await reloaded.reconnect(saved.id)
  assert.equal(next.workspaceId, saved.workspaceId)
  assert.equal(next.id, saved.id)
  assert.equal(next.disconnected, undefined)
  assert.equal(reloaded.list()[0]!.connectionState, 'connected')
  reloaded.dispose()
})

test('a saved registration becomes offline on a failed reachability check and recovers without changing its identity', async t => {
  const f = await fixture(); t.after(() => rm(f.root, { recursive: true, force: true }))
  const saved = await f.manager.add({ target: f.target, localPath: f.mount })
  const inspect = f.transport.inspect
  f.transport.inspect = async () => { throw new Error('server unreachable') }
  await f.manager.checkHealth(new AbortController().signal)
  assert.equal(f.manager.list()[0]!.connectionState, 'error')
  assert.equal(f.manager.list()[0]!.online, false)
  assert.match(f.manager.list()[0]!.connectionError!, /unreachable/)
  assert.equal(f.manager.list()[0]!.registered, true)
  f.transport.inspect = inspect
  await f.manager.checkHealth(new AbortController().signal)
  assert.equal(f.manager.list()[0]!.connectionState, 'connected')
  assert.equal(f.manager.list()[0]!.workspaceId, saved.workspaceId)
})
