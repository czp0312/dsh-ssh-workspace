import { idSource, payloadSource, routeSource, translateIds, remoteId } from './backend-protocol.js'
import type { ConnectionWebSocket } from '@deepseek-ai/dsh-client-connection/client'
import type { WorkspaceView } from './types.js'

type Rpc = (channel: string, endpoint: string, payload: any, signal?: AbortSignal) => Promise<any>
type Open = (channel: string, endpoint: string, payload: any, signal: AbortSignal, uplink?: AsyncIterable<unknown>) => AsyncIterable<any>
interface RouterContext { connection: { rpc: { call: Rpc; open?: Open }; openWebSocket?(path: string): ConnectionWebSocket; reconnect?(): void }; get(name: string): any; emit?(event: string): unknown; inject?(services: string[], setup: (ctx: RouterContext) => () => void): unknown }

class Queue<T> {
  values: T[] = []
  wake?: () => void
  error?: unknown
  push(value: T): void { if (this.values.length >= 4096) { this.fail(new Error('DSH stream consumer is too slow')); return }; this.values.push(value); this.wake?.(); this.wake = undefined }
  fail(error: unknown): void { this.error = error; this.wake?.(); this.wake = undefined }
  async next(signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    while (!this.values.length) {
      signal.throwIfAborted(); if (this.error) throw this.error
      await new Promise<void>(resolve => { const wake = () => { signal.removeEventListener('abort', wake); resolve() }; this.wake = wake; signal.addEventListener('abort', wake, { once: true }); if (signal.aborted) wake() })
    }
    return this.values.shift()!
  }
}

/** Local streams continue to use DSH's native text mux; no local tool emulation. */
class NativeMux {
  private socket?: ConnectionWebSocket
  private ready?: Promise<void>
  private inboxes = new Map<string, Queue<any>>()
  constructor(private openSocket: (path: string) => ConnectionWebSocket) {}
  private connect(): Promise<void> {
    if (this.socket?.readyState === 1) return Promise.resolve()
    return this.ready ??= new Promise<void>((resolve, reject) => {
      const socket = this.openSocket('/api/remote.mux'); this.socket = socket
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener('error', () => reject(carrierError('Local DSH stream connection failed')), { once: true })
      socket.addEventListener('message', event => {
        try { const frame = JSON.parse(String(event.data)); this.inboxes.get(frame.streamId)?.push(frame) }
        catch { for (const inbox of this.inboxes.values()) inbox.fail(new Error('Invalid DSH stream frame')) }
      })
      socket.addEventListener('close', () => { this.ready = undefined; for (const inbox of this.inboxes.values()) inbox.fail(carrierError('DSH stream disconnected')) }, { once: true })
    }).catch(error => { this.ready = undefined; throw error })
  }
  async *open(endpoint: string, payload: any, signal: AbortSignal, uplink?: AsyncIterable<unknown>): AsyncGenerator<any> {
    await this.connect(); signal.throwIfAborted()
    const id = crypto.randomUUID(); const inbox = new Queue<any>()
    this.inboxes.set(id, inbox)
    const socket = this.socket!
    const send = (frame: object) => { if (socket.readyState === 1) socket.send(JSON.stringify({ streamId: id, ...frame })) }
    send({ type: 'open', endpoint, payload })
    let iterator: AsyncIterator<unknown> | undefined
    let stopped = false
    if (uplink) {
      iterator = uplink[Symbol.asyncIterator]()
      void (async () => { while (!stopped && !signal.aborted) { const item = await iterator!.next(); if (stopped || signal.aborted) break; if (item.done) { send({ type: 'end' }); break }; send({ type: 'item', value: item.value }) } })().catch(error => inbox.fail(error))
    }
    try {
      while (true) { const frame = await inbox.next(signal); if (frame.type === 'item') yield frame.value; else if (frame.type === 'error') throw streamError(frame.error); else return }
    } finally { stopped = true; send({ type: 'cancel' }); this.inboxes.delete(id); void iterator?.return?.() }
  }
  close(): void { this.socket?.close(); this.ready = undefined; for (const inbox of this.inboxes.values()) inbox.fail(carrierError('Remote workspace router replaced')); this.inboxes.clear() }
}
const streamError = (failure: any): Error => Object.assign(new Error(failure?.message || 'Remote DSH stream failed'), { dshRemoteStreamFailure: { kind: 'remote', code: failure?.code || 'internal', details: failure?.details || {} } })
const carrierError = (message: string): Error => Object.assign(new Error(message), { dshRemoteStreamFailure: { kind: 'carrier' } })

export function installBackendRouter(ctx: RouterContext, onCatalog?: (workspaces: WorkspaceView[]) => void): { refresh(force?: boolean): Promise<void>; dispose(): void } | undefined {
  if (!ctx.connection.openWebSocket || !ctx.connection.reconnect) return
  const rpc = ctx.connection.rpc
  const originalCall = rpc.call.bind(rpc)
  const originalMethod = rpc.call
  const originalOpen = rpc.open
  // DSH 0.2.2-rc.1's Gateway owns the pre-plugin WebSocket mux. Its native
  // reconnect sink stops touching that mux once rpc.open is provided. On a
  // late install/hot replacement, retire it once so existing controllers
  // subscribe through this router. Capture only an already-mounted controller;
  // a normal cold start must not interrupt native Session restoration.
  const preexistingMux = ctx.get('workspaces') ? ctx.get('remote')?.streams : undefined
  const localMux = new NativeMux(path => ctx.connection.openWebSocket!(path))
  const localOpen: Open = originalOpen?.bind(rpc) ?? ((_channel, endpoint, payload, signal, uplink) => localMux.open(endpoint, payload, signal, uplink))
  const lifetime = new AbortController()
  let catalogLifetime = new AbortController()
  let sources: string[] = []
  let records: any[] = []
  let active: string | undefined
  let catalog = ''
  let refreshSequence = 0
  const eventClients = new Map<string, string>()
  const localOnly = /^(?:dsh-ssh-workspaces\/|productAnalytics\/|plugins\/|pluginManager\/|pluginInventory\/|pluginMarket\/|pluginRegistryProbe\/|cordis\/|dynamicCordisRunner\/|account\/|remoteAccess\/)/
  const manage = async (endpoint: string, input: any, signal?: AbortSignal): Promise<any> => {
    const result = await originalCall('/api', `dsh-ssh-workspaces/${endpoint}`, input, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const refresh = async (force = false) => {
    const sequence = ++refreshSequence
    const status = await manage('status', {}, lifetime.signal)
    if (sequence !== refreshSequence || lifetime.signal.aborted) return
    const next: string[] = status.sources ?? []
    records = status.workspaces ?? []
    onCatalog?.(records)
    const key = JSON.stringify([next, records.filter(row => row.backendId).map(row => [row.backendId, row.workspaceId, row.registered])])
    if (force || key !== catalog) {
      const connectedCatalog = catalog !== ''
      catalog = key; sources = next
      const previous = catalogLifetime; catalogLifetime = new AbortController()
      previous.abort(carrierError('Remote workspace catalog changed'))
      if (connectedCatalog) ctx.connection.reconnect!()
    }
  }
  const initialized = refresh().catch(error => { if (!lifetime.signal.aborted) console.error('Remote backend catalog:', error instanceof Error ? error.message : 'unavailable') })
  void initialized.then(() => { if (!lifetime.signal.aborted && typeof preexistingMux?.reconnect === 'function') preexistingMux.reconnect() })
  async function remoteCall(source: string, endpoint: string, payload: any, signal?: AbortSignal): Promise<any> {
    const translated = translateIds(payload, source, false)
    if (endpoint === '$events/result' && eventClients.has(source)) translated.args.clientId = eventClients.get(source)
    const response = await manage('backend/rpc', { backendId: source, endpoint, payload: translated }, signal)
    if (response.result.ok) {
      const root = { value: response.result.value }
      for (const attachment of response.attachments ?? []) {
        let parent: any = root; let key: string | number = 'value'
        for (const segment of attachment.path) { if (!parent[key] || !Object.hasOwn(parent[key], segment)) throw new Error('Invalid remote binary attachment'); parent = parent[key]; key = segment }
        const bytes = Uint8Array.from(atob(attachment.base64), c => c.charCodeAt(0))
        Object.defineProperty(parent, key, { value: bytes, enumerable: true, writable: true, configurable: true })
      }
      return { ok: true, value: translateIds(root.value, source, true) }
    }
    return response.result
  }
  async function* remoteOpen(source: string, endpoint: string, payload: any, signal: AbortSignal, uplink?: AsyncIterable<unknown>): AsyncGenerator<any> {
    const streamId = await manage('backend/open', { backendId: source, endpoint, payload: translateIds(payload, source, false) }, signal)
    let stopped = false
    let iterator: AsyncIterator<unknown> | undefined
    const uplinkError = new AbortController()
    const combined = AbortSignal.any([signal, uplinkError.signal])
    if (uplink) {
      iterator = uplink[Symbol.asyncIterator]()
      void (async () => {
        while (!stopped && !combined.aborted) {
          const item = await iterator!.next(); if (stopped || combined.aborted) break
          await manage('backend/send', { backendId: source, streamId, ...(item.done ? { end: true } : { value: translateIds(item.value, source, false) }) }, combined)
          if (item.done) break
        }
      })().catch(error => uplinkError.abort(error))
    }
    try {
      while (!combined.aborted) {
        const frames = await manage('backend/poll', { backendId: source, streamId }, combined)
        for (const frame of frames) {
          if (frame.type === 'error') throw streamError(frame.error)
          if (frame.type !== 'item') return
          const value = translateIds(frame.value, source, true)
          if (endpoint === 'session/control' && value.type === 'baseline') value.value.projections = Object.fromEntries(Object.entries(value.value.projections).map(([id, block]) => [remoteId(source, id), block]))
          if (endpoint === '$events' && value.type === 'ready') eventClients.set(source, value.clientId)
          if (endpoint === '$events' && value.type === 'emit' && /^api-session\//.test(value.event) && typeof value.args?.[0] === 'string') value.args[0] = remoteId(source, value.args[0])
          yield value
        }
      }
      combined.throwIfAborted()
    } finally {
      stopped = true; void iterator?.return?.()
      void manage('backend/cancel', { backendId: source, streamId }).catch(() => {})
    }
  }
  const select = (target: any) => {
    if (target === undefined) return
    const source = typeof target === 'string' ? idSource(target) : payloadSource(target)
    if (active !== source) { active = source; ctx.emit?.('connection/reset') }
  }
  const restorations: Array<() => void> = []
  const hookNavigation = (owner: RouterContext) => {
    const navigation = owner.get('uiWorkspace')
    const restore: Array<() => void> = []
    for (const method of ['startSession', 'openSession', 'openWorkspace']) {
      if (typeof navigation?.[method] !== 'function') continue
      const original = navigation[method]
      const wrapped = function(this: unknown, target: unknown, ...args: unknown[]) {
        const source = typeof target === 'string' ? idSource(target) : payloadSource(target)
        const paused = records.some(record => record.disconnected && ((method === 'startSession' && record.workspaceId === target) || (source && record.backendId === source)))
        if (paused) { ctx.get('layout')?.selectPanel('dsh-ssh-workspaces'); return }
        select(target); return original.call(this, target, ...args)
      }
      navigation[method] = wrapped
      restore.push(() => { navigation[method] = original })
    }
    return () => restore.forEach(dispose => dispose())
  }
  // FileUpload owns the desktop-authenticated raw carrier. Reuse it instead of
  // sending Blob uploads to a local Session with the same opaque identity.
  const hookUpload = (owner: RouterContext) => {
    const upload = owner.get('fileUpload')
    if (typeof upload?.post !== 'function') return () => {}
    const original = upload.post
    upload.post = function(this: unknown, request: any) {
      const url = new URL(request.path, 'http://dsh.invalid/')
      const sessionId = url.searchParams.get('sessionId')
      const source = sessionId ? idSource(sessionId) : undefined
      if (source && url.pathname === '/api/session/uploadFileBinary') {
        url.pathname = '/api/dsh-ssh-workspaces/backend/upload'
        url.searchParams.set('backendId', source)
        url.searchParams.set('sessionId', translateIds(sessionId, source, false, 'sessionId'))
        return original.call(this, { ...request, path: url.pathname.slice(1) + url.search })
      }
      return original.call(this, request)
    }
    return () => { upload.post = original }
  }
  // Install the carrier before native controllers subscribe. Navigation and
  // uploads arrive later and own separate dependency-scoped hook lifetimes.
  if (ctx.inject) {
    ctx.inject(['uiWorkspace'], hookNavigation)
    ctx.inject(['fileUpload'], hookUpload)
  } else restorations.push(hookNavigation(ctx), hookUpload(ctx))
  rpc.call = async (channel, endpoint, payload, signal) => {
    if (channel !== '/api' || localOnly.test(endpoint)) return originalCall(channel, endpoint, payload, signal)
    await initialized
    if (endpoint === 'session/list') {
      const local = await originalCall(channel, endpoint, payload, signal)
      if (!local.ok) return local
      const remote = await Promise.all(sources.map(source => remoteCall(source, endpoint, payload, signal).catch(() => null)))
      return { ok: true, value: { ...local.value, items: [...local.value.items, ...remote.flatMap(result => result?.ok ? result.value.items : [])] } }
    }
    const source = routeSource(payload, active, endpoint)
    return source ? remoteCall(source, endpoint, payload, signal) : originalCall(channel, endpoint, payload, signal)
  }
  rpc.open = async function* (channel, endpoint, payload, signal, uplink) {
    await initialized
    if (endpoint === 'workspace/follow' || endpoint === '$events' || endpoint === 'session/control') {
      const inbox = new Queue<{ source: string; value: any }>()
      const scope = new AbortController(); const combined = AbortSignal.any([signal, scope.signal, lifetime.signal, catalogLifetime.signal])
      const states = new Map<string, any>()
      const controlSources = new Set(['', ...sources])
      const controlSnapshots = new Map<string, any>()
      const empty = () => ({ items: [], archivedSessionIds: [], pinnedSessionIds: [] })
      // Cached folders remain visible when manually disconnected. Only enabled
      // sources receive live subscriptions, so polling cannot undo a disconnect.
      const visibleSources = [...new Set([...sources, ...records.filter(record => record.backendId).map(record => record.backendId as string)])]
      for (const source of visibleSources) states.set(source, { ...empty(), items: records.filter(record => record.backendId === source && record.registered !== false).map(record => translateIds(record.workspace, source, true)) })
      const pump = async (source: string) => {
        let attempt = 0
        while (!combined.aborted) {
          if (source && !sources.includes(source)) return
          try {
            for await (const value of source ? remoteOpen(source, endpoint, payload, combined) : localOpen(channel, endpoint, payload, combined)) { attempt = 0; inbox.push({ source, value }) }
            if (!combined.aborted) throw new Error('DSH event stream ended')
          } catch (error) {
            if (combined.aborted) return
            if (!source) { inbox.fail(error); return }
            if (endpoint === 'session/control') inbox.push({ source, value: { type: 'source-unavailable' } })
            if (attempt === 0) console.warn('Remote backend disconnected:', source)
          }
          // Retry subscriptions only; never replay a submitted prompt or tool.
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); combined.removeEventListener('abort', done); resolve() }
            const timer = setTimeout(done, Math.min(10_000, 500 * 2 ** Math.min(attempt++, 5)))
            combined.addEventListener('abort', done, { once: true })
            if (combined.aborted) done()
          })
        }
      }
      void pump(''); for (const source of sources) void pump(source)
      let baseline = false
      const buffered: any[] = []
      try {
        while (true) {
          const item = await inbox.next(combined)
          if (endpoint === '$events') {
            if (item.value.type === 'ready') { if (!item.source) { baseline = true; yield item.value; yield* buffered.splice(0) } }
            else if (baseline) yield item.value; else buffered.push(item.value)
            continue
          }
          if (endpoint === 'session/control') {
            if (item.value.type === 'baseline' || item.value.type === 'source-unavailable') {
              if (item.value.type === 'baseline') {
                // Each native stream generation accepts exactly one baseline.
                // A recovered source needs a new merged generation, not another
                // opening snapshot inserted among live projection updates.
                if (baseline) throw carrierError('Remote Session control source recovered')
                controlSnapshots.set(item.source, item.value.value.projections)
              }
              controlSources.delete(item.source)
              if (!baseline && controlSources.size === 0) {
                baseline = true
                yield { type: 'baseline', value: { projections: Object.assign({}, ...controlSnapshots.values()) } }
                yield* buffered.splice(0)
              }
            } else if (baseline) yield item.value; else buffered.push(item.value)
            continue
          }
          const state = states.get(item.source) ?? empty(); const frame = item.value
          const allowed = (workspaceId: string) => !item.source || records.some(record => record.backendId === item.source && record.workspaceId === workspaceId && record.registered !== false)
          if (frame.type === 'baseline' || frame.type === 'replace') states.set(item.source, { ...frame.value, items: frame.value.items.filter((row: any) => allowed(row.workspaceId)) })
          else if (frame.type === 'upsert' && allowed(frame.workspace.workspaceId)) state.items = [...state.items.filter((row: any) => row.workspaceId !== frame.workspace.workspaceId), frame.workspace]
          else if (frame.type === 'remove') state.items = state.items.filter((row: any) => row.workspaceId !== frame.workspaceId)
          else if (frame.type === 'order') state.items.sort((a: any, b: any) => frame.workspaceIds.indexOf(a.workspaceId) - frame.workspaceIds.indexOf(b.workspaceId))
          else if (frame.type === 'archived') state.archivedSessionIds = frame.archivedSessionIds
          else if (frame.type === 'pinned') state.pinnedSessionIds = frame.pinnedSessionIds
          if (!states.has(item.source)) states.set(item.source, state)
          if (!baseline && item.source) continue
          const values = [...states.values()]
          yield { type: baseline ? 'replace' : 'baseline', value: { items: values.flatMap(value => value.items), archivedSessionIds: values.flatMap(value => value.archivedSessionIds), pinnedSessionIds: values.flatMap(value => value.pinnedSessionIds) } }
          baseline = true
        }
      } finally { scope.abort() }
    } else {
      const source = channel === '/api' && !localOnly.test(endpoint) ? routeSource(payload, active, endpoint) : undefined
      const combined = AbortSignal.any([signal, lifetime.signal])
      yield* source ? remoteOpen(source, endpoint, payload, combined, uplink) : localOpen(channel, endpoint, payload, combined, uplink)
    }
  }
  let polling = false
  const timer = setInterval(() => {
    if (polling || lifetime.signal.aborted) return
    polling = true
    void refresh().catch(() => {
      if (!lifetime.signal.aborted) onCatalog?.(records.map(record => ({ ...record, online: false, connectionState: 'disconnected' })))
    }).finally(() => { polling = false })
  }, 5_000)
  return { refresh, dispose() {
    // DSH retains its native controllers when a third-party plugin hot reloads.
    // A plain AbortError permanently terminates their RemoteSnapshotStreams,
    // leaving the sidebar frozen even after the replacement router connects.
    // Classify retirement as a carrier change so subscriptions can be reopened.
    rpc.call = originalMethod; rpc.open = originalOpen
    lifetime.abort(carrierError('Remote workspace router replaced'))
    clearInterval(timer); localMux.close(); restorations.forEach(restore => restore())
  } }
}
