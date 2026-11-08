import test from 'node:test'
import assert from 'node:assert/strict'
import { installBackendRouter } from '../src/client-router.js'
import { remoteId } from '../src/backend-protocol.js'

const success = (value: unknown) => ({ ok: true, value })
const abort = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  const stop = () => reject(signal.reason)
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
})

function fixture() {
  const native = { workspaceId: 'local-workspace', title: 'Local', path: 'C:\\project', sessionIds: ['local-session'] }
  const remote = { workspaceId: 'remote-workspace', title: 'Remote', path: '/project', sessionIds: ['same-session'] }
  const records: any[] = [{ backendId: 'host-a', workspaceId: remoteId('host-a', remote.workspaceId), workspace: remote }]
  const calls: any[] = []
  const uploads: any[] = []
  const eventFrames: any[] = []
  const streams = new Map<string, any[]>()
  let count = 0
  let reconnects = 0
  let broken = false
  let enabled = true
  const navigation: any = { startSession() {}, openSession() {}, openWorkspace() {} }
  const upload: any = { post: async (request: any) => { uploads.push(request); return { status: 200, body: '{}' } } }
  const originalCall = async (channel: string, endpoint: string, payload: any, signal?: AbortSignal) => {
    calls.push({ channel, endpoint, payload })
    if (endpoint === 'dsh-ssh-workspaces/status') return success({ sources: enabled ? ['host-a'] : [], workspaces: records })
    if (endpoint === 'dsh-ssh-workspaces/backend/rpc') {
      if (broken) throw new Error('remote disconnected')
      if (payload.endpoint === 'workspaceFiles/readBytes') return success({ result: success({ data: null, path: '/project/file' }), attachments: [{ path: ['data'], base64: 'AQID' }] })
      return success({ result: success({ sessionId: 'same-session' }), attachments: [] })
    }
    if (endpoint === 'dsh-ssh-workspaces/backend/open') {
      const id = `stream-${++count}`
      streams.set(id, payload.endpoint === '$events'
        ? [{ type: 'item', value: { type: 'ready', clientId: 'remote-client', host: { home: '/home/remote' } } }, ...eventFrames.map(value => ({ type: 'item', value }))]
        : payload.endpoint === 'session/control'
          ? [{ type: 'item', value: { type: 'baseline', value: { projections: { 'same-session': { asOfSeq: 1, values: { title: 'Remote' } } } } } }]
        : payload.endpoint === 'workspace/follow'
          ? [{ type: 'item', value: { type: 'baseline', value: { items: [remote, { ...remote, workspaceId: 'unregistered', title: 'Hidden' }], archivedSessionIds: [], pinnedSessionIds: [] } } }]
          : [{ type: 'item', value: { type: 'snapshot', info: { id: 'terminal-1', cwd: '/project' } } }])
      return success(id)
    }
    if (endpoint === 'dsh-ssh-workspaces/backend/poll') {
      const frames = streams.get(payload.streamId)!
      if (frames?.length) return success(frames.splice(0))
      return abort(signal!)
    }
    if (endpoint === 'dsh-ssh-workspaces/backend/send' || endpoint === 'dsh-ssh-workspaces/backend/cancel') return success(null)
    if (endpoint === 'session/list') return success({ items: [] })
    return success({ local: true })
  }
  const originalOpen = async function* (_channel: string, endpoint: string, _payload: unknown, signal: AbortSignal, _uplink?: AsyncIterable<unknown>) {
    if (endpoint === '$events') yield { type: 'ready', clientId: 'local-client', host: { home: 'C:\\Users\\test' } }
    else if (endpoint === 'session/control') yield { type: 'baseline', value: { projections: { 'local-session': { asOfSeq: 1, values: { title: 'Local' } } } } }
    else if (endpoint === 'workspace/follow') yield { type: 'baseline', value: { items: [native], archivedSessionIds: [], pinnedSessionIds: [] } }
    else yield { local: true }
    await abort(signal)
  }
  const rpc = { call: originalCall, open: originalOpen }
  const context = { connection: { rpc, openWebSocket() { throw new Error('Native logical streams should be retained') }, reconnect() { reconnects++ } }, get(name: string) { return name === 'uiWorkspace' ? navigation : name === 'fileUpload' ? upload : undefined }, emit() {} }
  const router = installBackendRouter(context)!
  const ready = () => router.refresh()
  return { rpc, router, ready, navigation, upload, uploads, calls, records, eventFrames, get reconnects() { return reconnects }, fail() { broken = true }, disconnect() { enabled = false; for (const row of records) row.disconnected = true } }
}

test('router isolates local and remote calls across project switches and never falls back on a remote failure', async () => {
  const f = fixture()
  try {
    await f.ready()
    f.navigation.openSession(remoteId('host-a', 'same-session'))
    await f.rpc.call('/api', 'session/state', { args: { request: { sessionId: 'local-session' } } })
    assert.equal(f.calls.at(-1).endpoint, 'session/state')
    await f.rpc.call('/api', 'session/state', { args: { request: { sessionId: remoteId('host-a', 'same-session') } } })
    assert.equal(f.calls.at(-1).payload.payload.args.request.sessionId, 'same-session')
    await f.rpc.call('/api', 'llm/listProviders', { args: {} })
    assert.equal(f.calls.at(-1).payload.endpoint, 'llm/listProviders')
    await f.rpc.call('/api', 'pluginInventory/list', { args: {} })
    assert.equal(f.calls.at(-1).endpoint, 'pluginInventory/list')
    f.navigation.openSession({ kind: 'subagent', parentSessionId: remoteId('host-a', 'same-session'), childSessionId: remoteId('host-a', 'child') })
    f.fail()
    const before = f.calls.length
    await assert.rejects(f.rpc.call('/api', 'session/prompt', { args: { request: { sessionId: remoteId('host-a', 'same-session'), text: 'test' } } }), /disconnected/)
    assert.equal(f.calls.length, before + 1)
    assert.equal(f.calls.at(-1).endpoint, 'dsh-ssh-workspaces/backend/rpc')
    f.navigation.openWorkspace('local-workspace')
    await f.rpc.call('/api', 'llm/listProviders', { args: {} })
    assert.equal(f.calls.at(-1).endpoint, 'llm/listProviders')
  } finally { f.router.dispose() }
})

test('manually disconnected remote folders remain in the sidebar without starting remote subscriptions', async () => {
  const f = fixture()
  const controller = new AbortController()
  try {
    await f.ready()
    f.disconnect(); await f.router.refresh()
    const before = f.calls.length
    const stream = f.rpc.open('/api', 'workspace/follow', { args: {} }, controller.signal)[Symbol.asyncIterator]()
    const frame: any = (await stream.next()).value
    assert.ok(frame.value.items.some((row: any) => row.workspaceId === remoteId('host-a', 'remote-workspace')))
    assert.equal(f.calls.slice(before).some(call => call.endpoint === 'dsh-ssh-workspaces/backend/open'), false)
    await stream.return?.()
  } finally { controller.abort(); f.router.dispose() }
})

test('remote binary results survive the broker envelope and duplicate Session identities are namespaced', async () => {
  const f = fixture()
  try {
    await f.ready()
    const result: any = await f.rpc.call('/api', 'workspaceFiles/readBytes', { args: { workspaceFileScopeId: remoteId('host-a', 'same-session'), path: 'file' } })
    assert.deepEqual(result.value.data, Uint8Array.of(1, 2, 3))
    assert.equal(result.value.path, '/project/file')
    const session: any = await f.rpc.call('/api', 'session/create', { args: { request: { workspaceId: remoteId('host-a', 'remote-workspace'), sessionId: 'new-uuid' } } })
    assert.equal(session.value.sessionId, remoteId('host-a', 'same-session'))
    assert.equal(f.calls.at(-1).payload.payload.args.request.sessionId, 'new-uuid')
  } finally { f.router.dispose() }
})

test('native sidebar merges only registered remote folders and refreshes for a second folder on the same host', async () => {
  const f = fixture()
  const controller = new AbortController()
  try {
    await f.ready()
    const stream = f.rpc.open('/api', 'workspace/follow', { args: {} }, controller.signal)[Symbol.asyncIterator]()
    let frame: any
    for (let i = 0; i < 3; i++) { frame = (await stream.next()).value; if (frame.type === 'replace') break }
    assert.equal(frame.value.items.length, 2)
    assert.deepEqual(frame.value.items.map((item: any) => item.title), ['Remote', 'Local'])
    assert.ok(frame.value.items.some((item: any) => item.workspaceId === remoteId('host-a', 'remote-workspace')))
    const count = f.reconnects
    f.records.push({ ...f.records[0], workspaceId: remoteId('host-a', 'second') })
    await f.router.refresh()
    assert.equal(f.reconnects, count + 1)
    await stream.return?.()
  } finally { controller.abort(); f.router.dispose() }
})

test('forwarded approvals retain the remote event identity and answer the owning remote client generation', async () => {
  const f = fixture()
  f.eventFrames.push({ type: 'waterfall', event: 'tools/before-call', eventId: 'approval-1', agentId: 'same-session', request: { tool: 'bash' } })
  const controller = new AbortController()
  try {
    await f.ready()
    const stream = f.rpc.open('/api', '$events', { args: {} }, controller.signal)[Symbol.asyncIterator]()
    const first: any = (await stream.next()).value
    assert.equal(first.clientId, 'local-client')
    const frame: any = (await stream.next()).value
    assert.equal(frame.agentId, remoteId('host-a', 'same-session'))
    assert.equal(frame.eventId, remoteId('host-a', 'approval-1'))
    await f.rpc.call('/api', '$events/result', { args: { clientId: 'local-client', eventId: frame.eventId, outcome: { kind: 'next' } } })
    const reply = f.calls.at(-1).payload.payload.args
    assert.equal(reply.clientId, 'remote-client')
    assert.equal(reply.eventId, 'approval-1')
    await stream.return?.()
  } finally { controller.abort(); f.router.dispose() }
})

test('terminal uplink and Blob uploads reuse the desktop carrier and restore hooks on disposal', async () => {
  const f = fixture()
  const controller = new AbortController()
  const post = f.upload.post
  try {
    await f.ready()
    async function* input() { yield { type: 'write', data: 'pwd\r', sequence: 1 } }
    const stream = f.rpc.open('/api', 'terminal/attach', { args: { agentId: remoteId('host-a', 'same-session'), id: 'terminal-1' } }, controller.signal, input())[Symbol.asyncIterator]()
    const frame: any = (await stream.next()).value
    assert.equal(frame.info.cwd, '/project')
    assert.equal(frame.info.id, 'terminal-1')
    assert.ok(f.calls.some(call => call.endpoint.endsWith('backend/send') && call.payload.value?.data === 'pwd\r'))
    await stream.return?.()
    await f.upload.post({ path: 'api/session/uploadFileBinary?sessionId=' + encodeURIComponent(remoteId('host-a', 'same-session')) + '&name=file.txt', body: new Blob(['test']) })
    const url = new URL(f.uploads[0].path, 'http://localhost/')
    assert.equal(url.pathname, '/api/dsh-ssh-workspaces/backend/upload')
    assert.equal(url.searchParams.get('sessionId'), 'same-session')
    assert.equal(url.searchParams.get('backendId'), 'host-a')
  } finally { controller.abort(); f.router.dispose() }
  assert.notEqual(f.upload.post, post) // post was the wrapped method at fixture return.
})

test('host-wide Session control includes local and remote projections with namespaced record keys', async () => {
  const f = fixture()
  const controller = new AbortController()
  try {
    await f.ready()
    const stream = f.rpc.open('/api', 'session/control', { args: {} }, controller.signal)[Symbol.asyncIterator]()
    const first: any = (await stream.next()).value
    assert.equal(first.value.projections['local-session'].values.title, 'Local')
    const second: any = (await stream.next()).value
    assert.equal(second.value.projections[remoteId('host-a', 'same-session')].values.title, 'Remote')
    assert.equal(second.value.projections['same-session'], undefined)
    await stream.return?.()
  } finally { controller.abort(); f.router.dispose() }
})
