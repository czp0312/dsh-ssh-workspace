import test from 'node:test'
import assert from 'node:assert/strict'
import { installBackendRouter } from '../src/client-router.js'
import { remoteId } from '../src/backend-protocol.js'
import { RemoteStream, RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'

const success = (value: unknown) => ({ ok: true, value })
const abort = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  const stop = () => reject(signal.reason)
  signal.addEventListener('abort', stop, { once: true })
  if (signal.aborted) stop()
})

function fixture(options: { localControlReady?: Promise<void>; offlineControl?: boolean; lateServices?: boolean; mountedNative?: boolean } = {}) {
  const native = { workspaceId: 'local-workspace', title: 'Local', path: 'C:\\project', sessionIds: ['local-session'] }
  const remote = { workspaceId: 'remote-workspace', title: 'Remote', path: '/project', sessionIds: ['same-session'] }
  const records: any[] = [{ backendId: 'host-a', workspaceId: remoteId('host-a', remote.workspaceId), workspace: remote }]
  const calls: any[] = []
  const uploads: any[] = []
  const eventFrames: any[] = []
  const controlFrames: any[] = []
  const pendingServices = new Map<string, (ctx: any) => () => void>()
  const serviceCleanup: Array<() => void> = []
  const streams = new Map<string, any[]>()
  let count = 0
  let reconnects = 0
  let gatewayRestarts = 0
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
      if (payload.endpoint === 'session/control' && options.offlineControl) throw new Error('remote control offline')
      const id = `stream-${++count}`
      streams.set(id, payload.endpoint === '$events'
        ? [{ type: 'item', value: { type: 'ready', clientId: 'remote-client', host: { home: '/home/remote' } } }, ...eventFrames.map(value => ({ type: 'item', value }))]
        : payload.endpoint === 'session/control'
          ? [{ type: 'item', value: { type: 'baseline', value: { projections: { 'same-session': { asOfSeq: 1, values: { title: 'Remote' } } } } } }, ...controlFrames.map(value => ({ type: 'item', value }))]
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
  const originalOpen = async function* (_channel: string, endpoint: string, _payload: unknown, signal: AbortSignal, _uplink?: AsyncIterable<unknown>): AsyncGenerator<any, void> {
    if (endpoint === '$events') yield { type: 'ready', clientId: 'local-client', host: { home: 'C:\\Users\\test' } }
    else if (endpoint === 'session/control') {
      if (options.localControlReady) await Promise.race([options.localControlReady, abort(signal)])
      yield { type: 'baseline', value: { projections: { 'local-session': { asOfSeq: 1, values: { title: 'Local' } } } } }
    }
    else if (endpoint === 'workspace/follow') yield { type: 'baseline', value: { items: [native], archivedSessionIds: [], pinnedSessionIds: [] } }
    else yield { local: true }
    await abort(signal)
  }
  const rpc = { call: originalCall, open: originalOpen }
  const context = { connection: { rpc, openWebSocket() { throw new Error('Native logical streams should be retained') }, reconnect() { reconnects++ } }, get(name: string) { return name === 'uiWorkspace' ? navigation : name === 'fileUpload' ? upload : name === 'workspaces' && options.mountedNative ? {} : name === 'remote' ? { streams: { reconnect() { gatewayRestarts++ } } } : undefined }, emit() {}, ...(options.lateServices ? { inject(services: string[], setup: (ctx: any) => () => void) { pendingServices.set(services[0]!, setup) } } : {}) }
  let router = installBackendRouter(context)!
  const reload = () => { router.dispose(); router = installBackendRouter(context)!; return router }
  const ready = () => router.refresh()
  return { rpc, get router() { return router }, reload, ready, navigation, upload, uploads, calls, records, eventFrames, controlFrames, provideServices() { for (const setup of pendingServices.values()) serviceCleanup.push(setup(context)); pendingServices.clear() }, withdrawServices() { serviceCleanup.splice(0).forEach(dispose => dispose()) }, get reconnects() { return reconnects }, get gatewayRestarts() { return gatewayRestarts }, fail() { broken = true }, disconnect() { enabled = false; for (const row of records) row.disconnected = true } }
}

test('late activation retires the pre-router native carrier once without resetting a cold startup', async () => {
  const cold = fixture(); const late = fixture({ mountedNative: true })
  try {
    await Promise.all([cold.ready(), late.ready()])
    assert.equal(cold.gatewayRestarts, 0)
    assert.equal(late.gatewayRestarts, 1)
    await late.router.refresh()
    assert.equal(late.gatewayRestarts, 1, 'status polling cannot repeatedly interrupt native streams')
  } finally { cold.router.dispose(); late.router.dispose() }
})

for (const endpoint of ['workspace/follow', 'session/control']) test(`DSH native ${endpoint} survives plugin hot replacement and accepts the next catalog`, async () => {
  const f = fixture()
  let recoveries = 0
  // Use the real DSH supervisor. The structural-to-class conversion is the
  // Gateway's normalizeConnectionStream boundary for plugin/worker carriers.
  const supervisor = new RemoteStream<any>({ generation: { getSnapshot: () => ({ id: 1, host: { home: '/local' } }), subscribe: () => () => {} } }, {
    name: endpoint,
    async *open(signal) {
      try { yield* f.rpc.open('/api', endpoint, { args: {} }, signal) }
      catch (error: any) { if (error.dshRemoteStreamFailure?.kind === 'carrier') throw new RemoteStreamCarrierError(error.message); throw error }
    },
    ended: () => new RemoteStreamCarrierError('Stream ended'),
    carrierFailed: () => { recoveries++ },
  })
  const stream = supervisor[Symbol.asyncIterator]()
  try {
    await f.ready()
    const initial = (await stream.next()).value!
    initial.accept()
    f.reload()
    await f.ready()
    const replacement = (await stream.next()).value!
    assert.equal(replacement.generation, 2)
    assert.equal(replacement.value.type, 'baseline')
    replacement.accept()
    assert.equal(recoveries, 1)
    if (endpoint === 'workspace/follow') assert.ok(replacement.value.value.items.some((row: any) => row.workspaceId === remoteId('host-a', 'remote-workspace')))
  } finally { await supervisor.dispose(); f.router.dispose() }
})

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
    await f.rpc.call('/api', 'dynamicCordisRunner/syncInspectManifest', { args: {} })
    assert.equal(f.calls.at(-1).endpoint, 'dynamicCordisRunner/syncInspectManifest')
    await f.rpc.call('/api', 'remoteAccess/follow', { args: {} })
    assert.equal(f.calls.at(-1).endpoint, 'remoteAccess/follow')
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
    assert.equal(f.reconnects, 0, 'initial routing must not reset native Session startup')
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

test('missing native registrations are excluded from both cached and live sidebar frames', async () => {
  const f = fixture()
  const controller = new AbortController()
  try {
    f.records[0].registered = false
    await f.ready()
    const stream = f.rpc.open('/api', 'workspace/follow', { args: {} }, controller.signal)[Symbol.asyncIterator]()
    for (let i = 0; i < 2; i++) {
      const frame = (await stream.next()).value
      assert.ok(frame.value.items.every((row: any) => row.workspaceId === 'local-workspace'))
    }
    await stream.return?.()
  } finally { controller.abort(); f.router.dispose() }
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

test('native Session control receives one merged baseline before live remote projection updates', async () => {
  const f = fixture()
  f.controlFrames.push({ type: 'projection', sessionId: 'same-session', seq: 2, changes: [{ key: 'title', val: 'Updated remote' }] })
  const controller = new AbortController()
  try {
    await f.ready()
    const stream = f.rpc.open('/api', 'session/control', { args: {} }, controller.signal)[Symbol.asyncIterator]()
    const first: any = (await stream.next()).value
    assert.equal(first.type, 'baseline')
    assert.equal(first.value.projections['local-session'].values.title, 'Local')
    assert.equal(first.value.projections[remoteId('host-a', 'same-session')].values.title, 'Remote')
    assert.equal(first.value.projections['same-session'], undefined)
    const second: any = (await stream.next()).value
    assert.equal(second.type, 'projection')
    assert.equal(second.sessionId, remoteId('host-a', 'same-session'))
    assert.equal(second.changes[0].val, 'Updated remote')
    await stream.return?.()
  } finally { controller.abort(); f.router.dispose() }
})

test('control buffers early remote updates until the local opening snapshot arrives', async () => {
  const ready = Promise.withResolvers<void>()
  const f = fixture({ localControlReady: ready.promise })
  f.controlFrames.push({ type: 'projection', sessionId: 'same-session', seq: 2, changes: [{ key: 'title', val: 'Early update' }] })
  const controller = new AbortController()
  try {
    await f.ready()
    const stream = f.rpc.open('/api', 'session/control', { args: {} }, controller.signal)[Symbol.asyncIterator]()
    const opening = stream.next()
    await new Promise<void>(resolve => setImmediate(resolve))
    ready.resolve()
    const baseline: any = (await opening).value
    assert.equal(baseline.type, 'baseline')
    assert.equal(Object.keys(baseline.value.projections).length, 2)
    assert.equal((await stream.next()).value.changes[0].val, 'Early update')
    await stream.return?.()
  } finally { controller.abort(); f.router.dispose() }
})

test('an unavailable remote control stream does not block the local Session baseline', async () => {
  const f = fixture({ offlineControl: true })
  const controller = new AbortController()
  try {
    await f.ready()
    const stream = f.rpc.open('/api', 'session/control', { args: {} }, controller.signal)[Symbol.asyncIterator]()
    const first: any = (await stream.next()).value
    assert.equal(first.type, 'baseline')
    assert.deepEqual(Object.keys(first.value.projections), ['local-session'])
    await stream.return?.()
  } finally { controller.abort(); f.router.dispose() }
})

test('catalog changes end an existing subscription as a retryable carrier generation', async () => {
  const f = fixture()
  const controller = new AbortController()
  try {
    await f.ready()
    const stream = f.rpc.open('/api', 'workspace/follow', { args: {} }, controller.signal)[Symbol.asyncIterator]()
    await stream.next(); await stream.next()
    const pending = stream.next()
    const failure = assert.rejects(pending, (error: any) => error.dshRemoteStreamFailure?.kind === 'carrier')
    f.disconnect(); await f.router.refresh(); await failure
    const replacement = f.rpc.open('/api', 'workspace/follow', { args: {} }, controller.signal)[Symbol.asyncIterator]()
    assert.ok((await replacement.next()).value.value.items.some((row: any) => row.workspaceId === remoteId('host-a', 'remote-workspace')))
    await replacement.return?.()
  } finally { controller.abort(); f.router.dispose() }
})

test('adding a native lightweight folder does not interrupt existing remote sessions', async () => {
  const f = fixture()
  try {
    await f.ready()
    f.records.push({ workspaceId: 'native-lightweight', mode: 'light' })
    await f.router.refresh()
    assert.equal(f.reconnects, 0)
  } finally { f.router.dispose() }
})

test('routing starts before UI services and attaches navigation and upload hooks when they arrive', async () => {
  const f = fixture({ lateServices: true })
  const originalNavigation = f.navigation.openSession
  const originalUpload = f.upload.post
  try {
    await f.ready()
    assert.equal(f.navigation.openSession, originalNavigation)
    f.provideServices()
    f.navigation.openSession(remoteId('host-a', 'same-session'))
    await f.rpc.call('/api', 'llm/listProviders', { args: {} })
    assert.equal(f.calls.at(-1).payload.backendId, 'host-a')
    await f.upload.post({ path: 'api/session/uploadFileBinary?sessionId=' + encodeURIComponent(remoteId('host-a', 'same-session')), body: new Blob(['test']) })
    assert.ok(f.uploads[0].path.startsWith('api/dsh-ssh-workspaces/backend/upload?'))
    f.withdrawServices()
    assert.equal(f.navigation.openSession, originalNavigation)
    assert.equal(f.upload.post, originalUpload)
  } finally { f.withdrawServices(); f.router.dispose() }
})
