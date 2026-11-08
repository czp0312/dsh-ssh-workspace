import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RemoteTransport } from '../src/transport.js'
import { RemoteBackends } from '../src/backends.js'
import { translateIds } from '../src/backend-protocol.js'
import { WorkspaceManager, type NativeWorkspace } from '../src/manager.js'
import { WorkspaceStore } from '../src/storage.js'
import { WorkspaceConnections } from '../src/connections.js'

const transport = new RemoteTransport()
const backends = new RemoteBackends(resolve('.test-artifacts/backend-smoke.json'), transport)
await backends.load()
try {
  const record = await backends.add({ target: { kind: 'wsl', distribution: 'Ubuntu-22.04', remotePath: '/home/cczp/.cache/dsh-ssh-workspaces-desktop-check' }, title: 'WSL 远程后端验收' })
  const wire = await backends.wire(record.backendId)
  const workspaceId = translateIds({ workspaceId: record.workspaceId }, record.backendId, false).workspaceId
  const call = async (endpoint: string, args: any) => {
    const response = await wire.rpc(endpoint, { args }) as any
    assert.ok(response.result.ok, response.result.error?.message)
    return response.result.value
  }
  const created = await call('session/create', { request: { workspaceId } })
  assert.ok(created.sessionId)
  const list = await call('session/list', { _request: {} })
  assert.ok(list.items.some((item: any) => item.sessionId === created.sessionId))
  const environment = await call('terminal/environment', { agentId: created.sessionId })
  assert.equal(environment.cwd, record.target.remotePath)
  const terminalId = randomUUID()
  const terminal = await call('terminal/create', { agentId: created.sessionId, request: { id: terminalId, cols: 100, rows: 30 } })
  assert.equal(terminal.cwd, record.target.remotePath)
  assert.equal(terminal.state, 'running', terminal.error)
  const attach = await wire.open('terminal/attach', { args: { agentId: created.sessionId, id: terminalId } })
  try {
    const opening: any[] = await wire.poll(attach, AbortSignal.timeout(30_000))
    assert.ok(opening.some(frame => frame.type === 'item' && frame.value.type === 'snapshot'))
    wire.send(attach, { type: 'write', sequence: 1, data: "printf '\\104\\123\\110\\137\\122\\105\\115\\117\\124\\105\\137\\117\\113\\n'; pwd; printf 'remote-backend-smoke\\n' > .native-backend-check.txt\r" })
    let output = ''
    const deadline = AbortSignal.timeout(30_000)
    while (!output.includes('DSH_REMOTE_OK')) {
      for (const frame of await wire.poll(attach, deadline) as any[]) {
        assert.notEqual(frame.type, 'error', frame.error?.message)
        if (frame.value?.type === 'output') output += frame.value.data
      }
    }
  } finally { wire.cancel(attach); await call('terminal/close', { agentId: created.sessionId, id: terminalId }) }
  const directory = await call('workspaceFiles/list', { workspaceFileScopeId: created.sessionId, path: '.' })
  assert.ok(directory.entries.some((item: any) => item.name === '.native-backend-check.txt'))
  const read = await call('workspaceFiles/read', { workspaceFileScopeId: created.sessionId, path: '.native-backend-check.txt', range: {} })
  assert.equal(read.text, 'remote-backend-smoke')
  const bytes: any = await wire.rpc('workspaceFiles/readBytes', { args: { workspaceFileScopeId: created.sessionId, path: '.native-backend-check.txt', options: {} } })
  assert.ok(bytes.result.ok, bytes.result.error?.message)
  assert.equal(Buffer.from(bytes.attachments[0].base64, 'base64').toString(), 'remote-backend-smoke\n')
  const upload = await wire.upload(new URLSearchParams({ sessionId: created.sessionId, name: 'remote-smoke-upload.txt' }), new Request('http://localhost/upload', { method: 'POST', body: new Blob(['remote-upload-smoke']), headers: { 'content-type': 'application/octet-stream' } }))
  assert.equal(upload.status, 200)
  const receipt: any = await upload.json()
  assert.ok(receipt.ok, receipt.error?.message)
  assert.ok(receipt.value.receiptId)
  const eventStream = await wire.open('$events', { args: {} })
  const ready: any[] = await wire.poll(eventStream, AbortSignal.timeout(30_000))
  assert.equal(ready[0].value.type, 'ready')
  assert.ok(ready[0].value.host.home.startsWith('/'))
  wire.cancel(eventStream)
  const stream = await wire.open('workspace/follow', { args: {} })
  const frames = await wire.poll(stream, AbortSignal.timeout(30_000))
  assert.equal(frames[0]?.type, 'item')
  wire.cancel(stream)
  await backends.checkHealth(AbortSignal.timeout(15_000))
  assert.equal(backends.list().find(row => row.id === record.id)?.connectionState, 'connected')
  // Exercise a real WSL mode switch while using a private native registry, so
  // the user's desktop folders and existing sessions are never rewritten.
  const natives = new Map<string, NativeWorkspace>()
  const light = new WorkspaceManager({
    get: id => natives.get(id),
    resolveByPath: async path => [...natives.values()].find(row => row.path === path),
    create: async (path, title) => { const value = { id: randomUUID(), path, title: title || 'smoke' }; natives.set(value.id, value); return value },
    delete: async id => natives.delete(id),
  }, transport, new WorkspaceStore(resolve('.test-artifacts/backend-smoke-light.json')))
  await light.load()
  try {
    const connections = new WorkspaceConnections(light, backends)
    const lightweight = await connections.reconnect(record.id, AbortSignal.timeout(30_000), { mode: 'light' })
    assert.notEqual(lightweight.workspaceId, record.workspaceId)
    assert.equal(lightweight.target.remotePath, record.target.remotePath)
    const command = await light.run(lightweight.id, 'printf lifecycle-ok', { timeoutMs: 10_000 })
    assert.equal(command.stdout, 'lifecycle-ok')
    await connections.disconnect(lightweight.id)
    await assert.rejects(light.run(lightweight.id, 'must-not-run'), /已断开/)
    assert.equal(backends.list().find(row => row.id === record.id)?.connectionState, 'connected')
    assert.equal((await connections.reconnect(lightweight.id)).id, lightweight.id)
    await connections.disconnect(record.id)
    await assert.rejects(backends.wire(record.backendId), /已断开/)
    assert.equal((await light.run(lightweight.id, 'printf still-light')).stdout, 'still-light')
    const resumed = await connections.reconnect(lightweight.id, AbortSignal.timeout(30_000), { mode: 'full' })
    assert.equal(resumed.id, record.id)
    assert.equal(resumed.workspaceId, record.workspaceId)
    const continued = await backends.wire(record.backendId)
    const history: any = await continued.rpc('session/list', { args: { _request: {} } })
    assert.ok(history.result.ok)
    assert.ok(history.result.value.items.some((item: any) => item.sessionId === created.sessionId))
    const file: any = await continued.rpc('workspaceFiles/read', { args: { workspaceFileScopeId: created.sessionId, path: '.native-backend-check.txt', range: {} } })
    assert.equal(file.result.value.text, 'remote-backend-smoke')
  } finally { light.dispose() }
  console.log(JSON.stringify({ backend: 'native remote DSH', project: record.title, sessionCreatedOnRemote: true, remoteWorkspaceStream: 'passed', terminalInputAndOutput: 'passed', remoteFileWriteAndRead: 'passed', nativeBinaryAttachments: 'passed', nativeRawUpload: 'passed', remoteEventsHandshake: 'passed', connectionHealth: 'passed', disconnectAndResume: 'passed', fullLightFullSwitch: 'passed', originalSessionHistory: 'preserved', source: record.backendId }, null, 2))
} finally { await backends.dispose(); await transport.dispose() }
