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
  constructor() { super('http://127.0.0.1:1', 'synthetic-cookie') }
  override async rpc(endpoint: string, payload: any): Promise<any> {
    this.calls.push(endpoint)
    if (this.closed) throw new Error('wire closed')
    const request = payload.args.request
    if (endpoint === 'workspace/create') return { result: { ok: true, value: { workspace: { workspaceId: 'id-' + request.path.slice(1), path: request.path, title: 'remote', sessionIds: ['original-history'] } } }, attachments: [] }
    return { result: { ok: true, value: {} }, attachments: [] }
  }
  override async checkHealth(): Promise<void> { if (!this.healthy) { this.isStale = true; throw new Error('network lost') } }
  override close(): void { this.closed = true; super.close() }
}

class TestBackends extends RemoteBackends {
  starts = 0
  wires: FakeWire[] = []
  tunnelCloses = 0
  onStart?: (signal: AbortSignal) => Promise<void>
  protected override async createConnection(_target: RemoteTarget, signal: AbortSignal): Promise<RunningBackend> {
    this.starts++
    await this.onStart?.(signal)
    const wire = new FakeWire(); this.wires.push(wire)
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
  try {
    await reloaded.load()
    assert.equal(reloaded.findTarget(target)?.id, original.id)
    assert.equal((await reloaded.add({ target })).id, original.id)
  } finally { await reloaded.dispose() }
})
