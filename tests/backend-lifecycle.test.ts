import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { RemoteBackends, type RunningBackend } from '../src/backends.js'
import { BackendWire } from '../src/backend-wire.js'
import { RemoteTransport } from '../src/transport.js'
import type { RemoteTarget } from '../src/types.js'

class FakeWire extends BackendWire {
  calls: string[] = []
  healthy = true
  closed = false
  onSnapshot?: () => Promise<void>
  constructor(readonly native: Map<string, any>) { super('http://127.0.0.1:1', 'synthetic-cookie') }
  override async rpc(endpoint: string, payload: any): Promise<any> {
    this.calls.push(endpoint)
    if (this.closed) throw new Error('wire closed')
    const request = payload.args.request
    if (endpoint === 'workspace/create') {
      let workspace = [...this.native.values()].find(row => row.path === request.path)
      if (!workspace) {
        workspace = { workspaceId: 'id-' + request.path.slice(1), path: request.path, title: 'remote', sessionIds: ['original-history'] }
        this.native.set(workspace.workspaceId, workspace)
      }
      return { result: { ok: true, value: { workspace } }, attachments: [] }
    }
    if (endpoint === 'workspace/rename') this.native.get(request.workspaceId).title = request.title
    return { result: { ok: true, value: {} }, attachments: [] }
  }
  override async checkHealth(): Promise<void> { if (!this.healthy) { this.isStale = true; throw new Error('network lost') } }
  override async open(endpoint: string): Promise<string> { assert.equal(endpoint, 'workspace/follow'); return 'registration-snapshot' }
  override async poll(): Promise<any[]> {
    const items = structuredClone([...this.native.values()])
    await this.onSnapshot?.()
    return [{ type: 'item', value: { type: 'baseline', value: { items } } }]
  }
  override cancel(): void {}
  override close(): void { this.closed = true; super.close() }
}

class TestBackends extends RemoteBackends {
  starts = 0
  wires: FakeWire[] = []
  native = new Map<string, any>()
  tunnelCloses = 0
  onStart?: (signal: AbortSignal) => Promise<void>
  protected override async createConnection(_target: RemoteTarget, signal: AbortSignal): Promise<RunningBackend> {
    this.starts++
    await this.onStart?.(signal)
    const wire = new FakeWire(this.native); this.wires.push(wire)
    return { wire, tunnel: { close: async () => { this.tunnelCloses++ } } }
  }
}

const target: RemoteTarget = { kind: 'wsl', distribution: 'TestLinux', remotePath: '/project-a' }
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-backend-lifecycle-'))
  const file = join(directory, 'backends.json')
  const transport = new RemoteTransport()
  const backend = new TestBackends(file, transport)
  t.after(async () => { await backend.dispose(); await transport.dispose(); await rm(directory, { recursive: true, force: true }) })
  await backend.load()
  return { file, transport, backend }
}

test('shared full backends disconnect together, persist the pause and retain their workspace/session identities', async t => {
  const f = await fixture(t)
  const a = await f.backend.add({ target })
  const b = await f.backend.add({ target: { ...target, remotePath: '/project-b' } })
  const operation = f.backend.workspaceOperation(b.id)
  assert.equal(operation.signal.aborted, false)
  assert.equal(f.backend.starts, 1)
  assert.equal(f.backend.list()[0]!.sharedConnectionCount, 2)
  const original = f.backend.list().map(row => [row.workspaceId, row.workspace.sessionIds])
  await f.backend.disconnect(a.id)
  assert.equal(operation.signal.aborted, true, 'disconnect also cancels skill operations on shared projects')
  assert.throws(() => f.backend.workspaceOperation(b.id), /先连接/)
  assert.deepEqual(f.backend.sources(), [])
  assert.ok(f.backend.list().every(row => row.connectionState === 'disconnected' && row.registered))
  assert.equal(f.backend.wires[0]!.closed, true)
  assert.equal(f.backend.tunnelCloses, 1)
  await assert.rejects(f.backend.wire(a.backendId), /已断开/)
  await f.backend.checkHealth(new AbortController().signal)
  assert.equal(f.backend.starts, 1, 'polls never reconnect a deliberately paused host')
  assert.deepEqual(f.backend.list().map(row => [row.workspaceId, row.workspace.sessionIds]), original)
  const json = JSON.parse(await readFile(f.file, 'utf8'))
  assert.ok(json.projects.every((row: any) => row.disconnected === true))
  const reloaded = new TestBackends(f.file, f.transport)
  reloaded.native = f.backend.native
  try {
    await reloaded.load()
    await assert.rejects(reloaded.wire(b.backendId), /已断开/)
    assert.equal(reloaded.starts, 0)
    const connected = await reloaded.reconnect(b.id)
    assert.equal(connected.id, b.id)
    assert.equal(connected.workspaceId, b.workspaceId)
    assert.equal(reloaded.starts, 1)
    assert.equal(reloaded.sources().length, 1)
    assert.ok(reloaded.list().every(row => row.connectionState === 'connected' && !row.disconnected))
  } finally { await reloaded.dispose() }
})

test('a lost full backend turns unhealthy instead of retaining its last green status', async t => {
  const { backend } = await fixture(t)
  const a = await backend.add({ target })
  backend.wires[0]!.healthy = false
  await backend.checkHealth(new AbortController().signal)
  assert.equal(backend.list()[0]!.connectionState, 'error')
  assert.equal(backend.list()[0]!.online, false)
  await backend.wire(a.backendId)
  assert.equal(backend.starts, 2, 'natural network loss may reconnect while manual pauses may not')
  assert.equal(backend.list()[0]!.connectionState, 'connected')
})

test('disconnect cancels an in-flight full reconnect and a late bootstrap cannot revive the tunnel', async t => {
  const { backend, file } = await fixture(t)
  const a = await backend.add({ target })
  let started!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  backend.onStart = async () => { started(); await new Promise<void>(resolve => { release = resolve }) }
  const connecting = backend.reconnect(a.id)
  const rejected = assert.rejects(connecting, /取消|断开/)
  await ready
  assert.equal(backend.list()[0]!.connectionState, 'connecting')
  await backend.disconnect(a.id)
  release()
  await rejected
  assert.equal(backend.wires.at(-1)!.closed, true)
  assert.deepEqual(backend.sources(), [])
  assert.equal(backend.list()[0]!.connectionState, 'disconnected')
  assert.equal(JSON.parse(await readFile(file, 'utf8')).projects[0].disconnected, true)
  await assert.rejects(backend.wire(a.backendId), /已断开/)
})

test('switch matching prefers the current backend namespace over a duplicated legacy record', async t => {
  const { backend, file, transport } = await fixture(t)
  const original = await backend.add({ target })
  const json = JSON.parse(await readFile(file, 'utf8'))
  json.projects.unshift({ ...json.projects[0], id: 'legacy-duplicate', backendId: 'legacy-source', workspaceId: 'dsh-remote:legacy-source:id-project-a' })
  await writeFile(file, JSON.stringify(json))
  const reloaded = new TestBackends(file, transport)
  reloaded.native = backend.native
  try {
    await reloaded.load()
    assert.equal(reloaded.findTarget(target)?.id, original.id)
    assert.equal((await reloaded.add({ target })).id, original.id)
  } finally { await reloaded.dispose() }
})

test('removed native registrations report unavailable; explicit re-add preserves the old identity without migrating history', async t => {
  const { backend, file } = await fixture(t)
  const original = await backend.add({ target })
  const sibling = await backend.add({ target: { ...target, remotePath: '/project-b' } })
  backend.native.delete(original.workspace.workspaceId)
  await backend.checkHealth(new AbortController().signal)
  const missing = backend.list().find(row => row.id === original.id)!
  assert.equal(missing.registered, false)
  assert.equal(missing.connectionState, 'error')
  assert.equal(missing.online, false)
  assert.throws(() => backend.workspaceOperation(original.id), /重新添加目录/)
  assert.equal(backend.list().find(row => row.id === sibling.id)!.online, true)
  await assert.rejects(backend.reconnect(original.id), /重新添加目录/)
  assert.equal(backend.native.has(original.workspace.workspaceId), false, 'reconnect never recreates a deleted workspace implicitly')
  backend.native.set('replacement-id', { workspaceId: 'replacement-id', path: target.remotePath, title: original.title, sessionIds: [] })
  const restored = await backend.add({ target, title: original.title })
  assert.notEqual(restored.id, original.id)
  assert.notEqual(restored.workspaceId, original.workspaceId)
  assert.deepEqual(restored.workspace.sessionIds, [])
  assert.equal(backend.list().filter(row => row.target.remotePath === target.remotePath).length, 1)
  const retained = JSON.parse(await readFile(file, 'utf8')).projects.find((row: any) => row.id === original.id)
  assert.ok(retained.removedAt)
  assert.equal(retained.workspaceId, original.workspaceId)
  assert.deepEqual(retained.workspace.sessionIds, ['original-history'])
})

test('a stale health snapshot cannot mark a concurrently added project as missing', async t => {
  const { backend } = await fixture(t)
  await backend.add({ target })
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  backend.wires[0]!.onSnapshot = async () => { ready.resolve(); await release.promise }
  const checking = backend.checkHealth(new AbortController().signal)
  await ready.promise
  const added = await backend.add({ target: { ...target, remotePath: '/project-b' } })
  release.resolve()
  await checking
  assert.equal(backend.list().find(row => row.id === added.id)!.registered, true)
})
