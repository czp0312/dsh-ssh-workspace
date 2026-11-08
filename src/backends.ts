import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import { BACKEND_BOOTSTRAP } from './backend-bootstrap.js'
import { BackendTunnel, BackendWire } from './backend-wire.js'
import { remoteId } from './backend-protocol.js'
import { targetKey, validateTarget } from './model.js'
import { VERIFIED_DSH_VERSION, type ConnectionHealth, type PluginConfig, type RemoteTarget, type SavedWorkspace, type WorkspaceView } from './types.js'
import type { RemoteTransport } from './transport.js'

export interface BackendProject extends SavedWorkspace { backendId: string; backend: true; workspace: any }
export interface RunningBackend { tunnel: Pick<BackendTunnel, 'close'>; wire: BackendWire }

export class RemoteBackends {
  private records: BackendProject[] = []
  private running = new Map<string, RunningBackend>()
  private flights = new Map<string, { controller: AbortController; done: Promise<RunningBackend> }>()
  private paused = new Set<string>()
  private health = new Map<string, ConnectionHealth>()
  private epochs = new Map<string, number>()
  private publication = Promise.resolve()
  private disposed = false
  constructor(private file: string, private transport: RemoteTransport, private config: PluginConfig = {}) {}
  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8'))
      if (raw.version !== 1 || !Array.isArray(raw.projects)) throw new Error('Unsupported backend state')
      for (const record of raw.projects) {
        record.target = validateTarget(record.target)
        if (typeof record.backendId !== 'string' || typeof record.workspaceId !== 'string' || typeof record.id !== 'string') throw new Error('Invalid backend state')
        if (record.disconnected !== undefined && typeof record.disconnected !== 'boolean') throw new Error('Invalid backend disconnection state')
      }
      this.records = raw.projects
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  list(): Array<BackendProject & WorkspaceView> {
    return structuredClone(this.records.filter(row => row.removedAt === undefined).map(row => {
      const running = this.running.get(row.backendId)
      const state = this.blocked(row.backendId) ? { connectionState: 'disconnected' as const }
        : running && !running.wire.isStale ? { connectionState: 'connected' as const, checkedAt: this.health.get(row.backendId)?.checkedAt }
        : running?.wire.isStale ? { connectionState: 'error' as const, checkedAt: this.health.get(row.backendId)?.checkedAt, connectionError: this.health.get(row.backendId)?.connectionError ?? '远程连接已中断，请重新连接。' }
        : this.health.get(row.backendId) ?? { connectionState: 'disconnected' as const }
      return { ...row, registered: true, ...state, online: state.connectionState === 'connected', sharedConnectionCount: this.records.filter(item => item.backendId === row.backendId && item.removedAt === undefined).length }
    }))
  }
  sources(): string[] { return [...new Set(this.records.filter(row => row.removedAt === undefined && !this.blocked(row.backendId)).map(row => row.backendId))] }
  findTarget(target: RemoteTarget): BackendProject | undefined {
    const matches = this.records.filter(row => row.removedAt === undefined && targetKey(row.target) === targetKey(target))
    return matches.find(row => row.backendId === this.key(target)) ?? matches.sort((a, b) => b.createdAt - a.createdAt)[0]
  }
  private blocked(id: string): boolean { return this.paused.has(id) || this.records.some(row => row.backendId === id && row.disconnected) }
  private key(target: RemoteTarget): string {
    const connection = target.kind === 'wsl'
      ? { kind: target.kind, distribution: target.distribution, user: target.user ?? '' }
      : { kind: target.kind, host: target.host, port: target.port ?? null, user: target.user ?? '', ...(target.identityFile ? { identityFile: target.identityFile } : {}), ...(target.auth && target.auth !== 'auto' && target.auth !== 'key' ? { auth: target.auth } : {}), ...(target.certificateFile ? { certificateFile: target.certificateFile } : {}) }
    return createHash('sha256').update(JSON.stringify(connection)).digest('hex').slice(0, 24)
  }
  protected async createConnection(target: RemoteTarget, signal: AbortSignal): Promise<RunningBackend> {
    const state = await this.transport.python<{ port: number; token: string; path: string; version: string }>(target, BACKEND_BOOTSTRAP, { version: VERIFIED_DSH_VERSION, path: target.remotePath }, signal)
    if (state.version !== VERIFIED_DSH_VERSION || !Number.isInteger(state.port) || state.port < 1 || state.port > 65535 || !/^[A-Za-z0-9_-]+$/.test(state.token)) throw new Error('Invalid remote DSH handshake')
    const tunnel = new BackendTunnel(target, state.port, this.config, this.transport)
    let wire: BackendWire | undefined
    try {
      await tunnel.start()
      const login = await fetch(`${tunnel.origin}/?token=${encodeURIComponent(state.token)}`, { redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]) })
      const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
      if (![302, 303].includes(login.status) || !cookie) throw new Error(`Remote DSH authentication failed (HTTP ${login.status})`)
      wire = new BackendWire(tunnel.origin, cookie)
      const running = { tunnel, wire }
      signal.throwIfAborted()
      return running
    } catch (error) { wire?.close(); await tunnel.close(); throw error }
  }
  private ensure(target: RemoteTarget, id: string, signal?: AbortSignal, explicit = false): Promise<RunningBackend> {
    if (this.disposed) throw new Error('Backend manager disposed')
    if (!explicit && this.blocked(id)) throw new Error('远程后端已断开，请在“远程工作区”中手动连接；不会自动重连。')
    const running = this.running.get(id)
    if (running && !running.wire.isStale) return Promise.resolve(running)
    let flight = this.flights.get(id)
    if (!flight) {
      const controller = new AbortController()
      const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
      this.health.set(id, { connectionState: 'connecting' })
      const done = (async () => {
        if (running) { this.running.delete(id); running.wire.close(); await running.tunnel.close() }
        const next = await this.createConnection(target, combined)
        if (this.disposed || combined.aborted || (!explicit && this.blocked(id))) {
          next.wire.close(); await next.tunnel.close()
          throw new Error('远程连接已取消。')
        }
        this.running.set(id, next)
        this.health.set(id, { connectionState: 'connected', checkedAt: Date.now() })
        return next
      })().catch(error => {
        if (!this.blocked(id)) this.health.set(id, { connectionState: 'error', checkedAt: Date.now(), connectionError: error instanceof Error ? error.message : '远程后端连接失败' })
        throw error
      }).finally(() => { if (this.flights.get(id)?.controller === controller) this.flights.delete(id) })
      flight = { controller, done }
      this.flights.set(id, flight)
    }
    return flight.done
  }
  async wire(id: string, signal?: AbortSignal): Promise<BackendWire> {
    const record = this.records.find(row => row.backendId === id)
    if (!record) throw new Error('Unknown remote DSH backend')
    return (await this.ensure(record.target, id, signal)).wire
  }
  async add(input: unknown, signal?: AbortSignal): Promise<BackendProject> {
    const request = input as { target: unknown; title?: string }
    const target = validateTarget(request?.target)
    if (request.title !== undefined && (typeof request.title !== 'string' || request.title.length > 256)) throw new Error('Invalid workspace title')
    const id = this.findTarget(target)?.backendId ?? this.key(target)
    const epoch = this.epochs.get(id) ?? 0
    const running = await this.ensure(target, id, signal, true)
    const response = await running.wire.rpc('workspace/create', { args: { request: { path: target.remotePath } } }, signal) as any
    if (!response.result?.ok) throw new Error(response.result?.error?.message || 'Cannot create remote workspace')
    let workspace = response.result.value.workspace
    const title = request.title?.trim() || `${posix.basename(target.remotePath) || '/'} · ${target.kind === 'wsl' ? target.distribution : target.host}`
    const renamed = await running.wire.rpc('workspace/rename', { args: { request: { workspaceId: workspace.workspaceId, title } } }, signal) as any
    if (!renamed.result?.ok) throw new Error(renamed.result?.error?.message || 'Cannot name remote workspace')
    workspace = { ...workspace, title }
    let record!: BackendProject
    await this.publish(records => {
      if ((this.epochs.get(id) ?? 0) !== epoch || signal?.aborted) throw new Error('连接操作已取消，请重新选择连接。')
      const previous = records.find(row => row.backendId === id && row.workspaceId === remoteId(id, workspace.workspaceId))
      record = { id: previous?.id ?? randomUUID(), backendId: id, backend: true, workspaceId: remoteId(id, workspace.workspaceId), title, localPath: workspace.path, target: { ...target, remotePath: workspace.path }, createdAt: previous?.createdAt ?? Date.now(), workspace }
      return [...records.filter(row => row.id !== record.id).map(row => row.backendId === id ? this.resumed(row) : row), record]
    })
    if ((this.epochs.get(id) ?? 0) === epoch) this.paused.delete(id)
    return structuredClone(record)
  }
  async reconnect(id: string, signal?: AbortSignal): Promise<BackendProject> {
    const record = this.records.find(row => row.id === id)
    if (!record) throw new Error('Remote project not found')
    const epoch = this.epochs.get(record.backendId) ?? 0
    await this.closeRunning(record.backendId)
    await this.ensure(record.target, record.backendId, signal, true)
    signal?.throwIfAborted()
    await this.publish(records => {
      if ((this.epochs.get(record.backendId) ?? 0) !== epoch) throw new Error('连接操作已取消。')
      return records.map(row => row.backendId === record.backendId ? this.resumed(row) : row)
    })
    if ((this.epochs.get(record.backendId) ?? 0) === epoch) this.paused.delete(record.backendId)
    return this.resumed(record)
  }
  private resumed(record: BackendProject): BackendProject { const { disconnected: _disconnected, ...retained } = record; return retained }

  /** One backend/tunnel is shared by all full projects with the same SSH/WSL identity. */
  async disconnect(id: string): Promise<void> {
    const record = this.records.find(row => row.id === id)
    if (!record) throw new Error('远程项目不存在，请刷新列表。')
    const backendId = record.backendId
    this.epochs.set(backendId, (this.epochs.get(backendId) ?? 0) + 1)
    this.paused.add(backendId)
    this.health.set(backendId, { connectionState: 'disconnected' })
    this.flights.get(backendId)?.controller.abort(new Error('远程后端已断开。'))
    await this.closeRunning(backendId)
    await this.publish(records => records.map(row => row.backendId === backendId ? { ...row, disconnected: true } : row))
  }

  private async closeRunning(id: string): Promise<void> {
    const previous = this.running.get(id)
    if (!previous) return
    this.running.delete(id); previous.wire.close(); await previous.tunnel.close()
  }

  async checkHealth(signal: AbortSignal): Promise<void> {
    await Promise.allSettled([...this.running].filter(([id]) => !this.blocked(id)).map(async ([id, running]) => {
      try {
        await running.wire.checkHealth(AbortSignal.any([signal, AbortSignal.timeout(8_000)]))
        if (this.running.get(id) === running) this.health.set(id, { connectionState: 'connected', checkedAt: Date.now() })
      } catch (error) {
        if (!signal.aborted && !this.blocked(id) && this.running.get(id) === running) this.health.set(id, { connectionState: 'error', checkedAt: Date.now(), connectionError: error instanceof Error ? error.message : '远程后端不可达' })
      }
    }))
  }
  async remove(id: string): Promise<void> {
    const record = this.records.find(row => row.id === id)
    if (!record) throw new Error('Remote project not found')
    await this.publish(records => records.map(row => row.id === id ? { ...row, removedAt: Date.now() } : row))
  }
  private publish(change: (records: BackendProject[]) => BackendProject[]): Promise<void> {
    const operation = this.publication.then(async () => {
      const records = change(this.records)
      await mkdir(dirname(this.file), { recursive: true })
      const staging = this.file + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(staging, JSON.stringify({ version: 1, projects: records }, null, 2), { mode: 0o600 })
        await rename(staging, this.file)
        this.records = records
      } catch (error) { await unlink(staging).catch(() => {}); throw error }
    })
    this.publication = operation.catch(() => {})
    return operation
  }
  async dispose(): Promise<void> {
    this.disposed = true
    for (const flight of this.flights.values()) flight.controller.abort()
    await Promise.allSettled([...this.flights.values()].map(flight => flight.done))
    for (const running of this.running.values()) { running.wire.close(); await running.tunnel.close() }
    this.running.clear()
  }
}
