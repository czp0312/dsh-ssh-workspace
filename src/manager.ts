import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { validateAddRequest, targetKey, wslUncPath, sshfsUncPath, toRemotePath } from './model.js'
import { WorkspaceStore } from './storage.js'
import type { RemoteTransport } from './transport.js'
import { targetLabel, type SavedWorkspace, type WorkspaceView, type RemoteTarget, type RemoteInfo, type ConnectionHealth, type CommandResult, type RunOptions } from './types.js'

export interface NativeWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
}

export interface NativeWorkspaceRegistry {
  get(id: string): NativeWorkspace | undefined
  resolveByPath(path: string): Promise<NativeWorkspace | undefined>
  create(path: string, title?: string): Promise<NativeWorkspace>
  delete(id: string): Promise<boolean>
}

export type WorkspaceTransport = Pick<RemoteTransport, 'inspect' | 'createMountProbe' | 'removeMountProbe'> & Partial<Pick<RemoteTransport, 'run' | 'canonicalTarget'>>

/** Windows network-filesystem IO cannot be cancelled, but must not block disconnect. */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason ?? new Error('操作已取消。'))
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

/** Coordinates durable remote identities with DSH's unmodified native registry. */
export class WorkspaceManager {
  private tail: Promise<void> = Promise.resolve()
  private health = new Map<string, ConnectionHealth>()
  private paused = new Set<string>()
  private scopes = new Map<string, AbortController>()
  private epochs = new Map<string, number>()
  private disposed = false

  constructor(
    private readonly registry: NativeWorkspaceRegistry,
    private readonly transport: WorkspaceTransport,
    private readonly store: WorkspaceStore,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async load(): Promise<void> { await this.store.load() }

  list(): WorkspaceView[] {
    return this.store.list().filter(record => record.removedAt === undefined).map(record => {
      const native = this.registry.get(record.workspaceId)
      const health = this.paused.has(record.id) || record.disconnected ? { connectionState: 'disconnected' as const } : this.health.get(record.id) ?? { connectionState: 'disconnected' as const }
      return { ...record, title: native?.title ?? record.title, registered: native !== undefined, ...health, online: health.connectionState === 'connected' }
    })
  }

  forPath(path: string | undefined): SavedWorkspace | undefined {
    if (path === undefined) return undefined
    return [...this.store.list()].sort((a, b) => b.localPath.length - a.localPath.length)
      .find(record => toRemotePath(path, record, this.platform) !== undefined)
  }

  add(input: unknown, signal?: AbortSignal): Promise<SavedWorkspace> {
    const request = validateAddRequest(input)
    return this.enqueue(async () => {
      signal?.throwIfAborted()
      const canonical = await this.transport.canonicalTarget?.(request.target, signal) ?? request.target
      const info = await this.transport.inspect(canonical, signal)
      const target: RemoteTarget = { ...canonical, remotePath: info.path }
      const existing = this.store.list().find(row => targetKey(row.target) === targetKey(target))
      if (existing !== undefined) return this.connectTracked(existing, signal)
      const localPath = await this.localDirectory(target, info, request.localPath, signal)
      const other = this.forPath(localPath)
      if (other !== undefined) throw new Error('这个目录已属于另一个远程项目。请为每个连接使用独立的挂载目录。')
      const native = await this.registry.resolveByPath(localPath)
      if (native !== undefined) {
        throw new Error('这个目录已作为本机项目存在。请先在侧边栏移除它的项目登记，再添加远程项目；文件和会话会保留。')
      }
      signal?.throwIfAborted()
      const title = request.title?.trim() || `${posix.basename(target.remotePath) || '/'} · ${targetLabel(target)}`
      const workspace = await this.registry.create(localPath, title)
      const record: SavedWorkspace = {
        id: randomUUID(), workspaceId: workspace.id, title: workspace.title,
        localPath: workspace.path, target, createdAt: Date.now(),
      }
      try {
        // Once the native registration commits, finish its ledger write even if the UI closes.
        await this.store.save([...this.store.list(), record])
      } catch (error) {
        await this.registry.delete(workspace.id).catch(() => undefined)
        throw error
      }
      this.health.set(record.id, { connectionState: 'connected', checkedAt: Date.now() })
      return record
    })
  }

  reconnect(id: string, signal?: AbortSignal): Promise<SavedWorkspace> {
    const epoch = this.epochs.get(id) ?? 0
    return this.enqueue(() => this.connectTracked(this.requireRecord(id), signal, epoch))
  }

  /** Stops this plugin's command channel. User-managed SSHFS/WSL mounts stay mounted. */
  disconnect(id: string): Promise<void> {
    this.requireRecord(id)
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1)
    this.paused.add(id)
    this.scopes.get(id)?.abort(new Error('远程项目已断开。'))
    this.health.set(id, { connectionState: 'disconnected' })
    return this.enqueue(() => this.store.save(this.store.list().map(row => row.id === id ? { ...row, disconnected: true } : row)))
  }

  assertAvailable(id: string): void {
    if (this.disposed || this.paused.has(id) || this.requireRecord(id).disconnected) throw new Error('远程项目已断开，请在“远程工作区”中连接后继续。')
  }

  async run(id: string, command: string, options: RunOptions = {}): Promise<CommandResult> {
    this.assertAvailable(id)
    const record = this.requireRecord(id)
    if (!this.transport.run) throw new Error('Remote command transport is unavailable')
    const scope = this.scope(id)
    const signal = AbortSignal.any([scope.signal, ...(options.signal ? [options.signal] : [])])
    try {
      const result = await this.transport.run(record.target, command, { ...options, signal })
      if (!signal.aborted && result.exitCode !== 255) this.health.set(id, { connectionState: 'connected', checkedAt: Date.now() })
      else if (!signal.aborted && result.exitCode === 255) this.health.set(id, { connectionState: 'error', checkedAt: Date.now(), connectionError: 'SSH 命令通道已中断，请检查连接后重试。' })
      return result
    } catch (error) {
      if (!signal.aborted) this.health.set(id, { connectionState: 'error', connectionError: error instanceof Error ? error.message : '远程连接失败', checkedAt: Date.now() })
      throw error
    }
  }

  async checkHealth(signal: AbortSignal): Promise<void> {
    await Promise.allSettled(this.store.list().filter(row => !row.disconnected && !this.paused.has(row.id) && row.removedAt === undefined).map(async record => {
      if (this.health.get(record.id)?.connectionState === 'connecting') return
      const scope = this.scope(record.id)
      const combined = AbortSignal.any([signal, scope.signal, AbortSignal.timeout(8_000)])
      try {
        const info = await this.transport.inspect(record.target, combined)
        if (info.path !== record.target.remotePath) throw new Error('远程项目的真实路径已经变化。')
        if (!(await abortable(stat(record.localPath), combined)).isDirectory()) throw new Error('本机挂载目录不可用。')
        combined.throwIfAborted()
        this.health.set(record.id, { connectionState: 'connected', checkedAt: Date.now() })
      } catch (error) {
        if (!signal.aborted && !scope.signal.aborted && !this.paused.has(record.id) && !this.requireRecord(record.id).disconnected) this.health.set(record.id, { connectionState: 'error', checkedAt: Date.now(), connectionError: error instanceof Error ? error.message : '远程连接不可用' })
      }
    }))
  }

  dispose(): void {
    this.disposed = true
    for (const scope of this.scopes.values()) scope.abort()
  }

  private scope(id: string): AbortController {
    let scope = this.scopes.get(id)
    if (!scope || scope.signal.aborted) { scope = new AbortController(); this.scopes.set(id, scope) }
    return scope
  }

  private async connectTracked(record: SavedWorkspace, signal?: AbortSignal, epoch = this.epochs.get(record.id) ?? 0): Promise<SavedWorkspace> {
    if ((this.epochs.get(record.id) ?? 0) !== epoch) throw new Error('连接操作已取消。')
    this.paused.delete(record.id)
    this.scopes.get(record.id)?.abort()
    const combined = AbortSignal.any([this.scope(record.id).signal, ...(signal ? [signal] : [])])
    this.health.set(record.id, { connectionState: 'connecting' })
    try {
      const result = await this.connect(record, combined)
      combined.throwIfAborted()
      this.health.set(record.id, { connectionState: 'connected', checkedAt: Date.now() })
      return result
    } catch (error) {
      if (!this.paused.has(record.id)) this.health.set(record.id, { connectionState: 'error', connectionError: error instanceof Error ? error.message : '连接失败', checkedAt: Date.now() })
      throw error
    }
  }

  remove(id: string): Promise<void> {
    return this.enqueue(async () => {
      const record = this.requireRecord(id)
      const native = this.registry.get(record.workspaceId)
      if (native !== undefined && native.path === record.localPath) await this.registry.delete(native.id)
      // Session histories outlive workspace registration. Keep their remote routing.
      await this.store.save(this.store.list().map(row => row.id === id ? { ...row, removedAt: Date.now() } : row))
    })
  }

  private requireRecord(id: string): SavedWorkspace {
    const record = this.store.list().find(row => row.id === id)
    if (record === undefined) throw new Error('远程项目不存在，请刷新列表。')
    return record
  }

  private async connect(record: SavedWorkspace, signal?: AbortSignal): Promise<SavedWorkspace> {
    const info = await this.transport.inspect(record.target, signal)
    if (info.path !== record.target.remotePath) throw new Error('远程目录的真实路径已经变化，请移除登记后重新添加。')
    const path = await this.localDirectory(record.target, info, record.localPath, signal)
    const native = await this.registry.resolveByPath(path)
    if (native !== undefined && native.id !== record.workspaceId) {
      throw new Error('此挂载目录已有其他本机项目登记，不能自动替换其执行环境。')
    }
    signal?.throwIfAborted()
    const workspace = native ?? await this.registry.create(path, record.title)
    const { removedAt: _removedAt, ...retained } = record
    const { disconnected: _disconnected, ...connected } = retained
    const next = { ...connected, workspaceId: workspace.id, localPath: workspace.path, title: workspace.title }
    try {
      await this.store.save(this.store.list().map(row => row.id === record.id ? next : row))
    } catch (error) {
      if (native === undefined) await this.registry.delete(workspace.id).catch(() => undefined)
      throw error
    }
    return next
  }

  private async localDirectory(target: RemoteTarget, info: RemoteInfo, provided: string | undefined, signal?: AbortSignal): Promise<string> {
    let requested: string
    if (target.kind === 'wsl') {
      if (this.platform !== 'win32') throw new Error('WSL 项目需要 Windows 版 DSH。')
      requested = wslUncPath(target)
    } else if (provided !== undefined) {
      requested = provided
    } else if (target.kind === 'ssh') {
      if (this.platform !== 'win32') throw new Error('请先用 SSHFS 挂载远程目录，并填写本机挂载路径。')
      requested = sshfsUncPath(target, info.user)
    } else {
      throw new Error('Docker 轻量模式需要填写本机共享/挂载路径，且必须对应容器内的同一项目目录；也可选择无需挂载的全量模式。')
    }
    let canonical: string
    try {
      canonical = await abortable(realpath(requested), signal)
      if (!(await abortable(stat(canonical), signal)).isDirectory()) throw new Error('挂载目标不是目录')
    } catch (error) {
      const advice = target.kind === 'docker' ? '请确认共享或挂载路径可访问，并与容器目录双向共享。' : target.kind === 'ssh'
        ? '请安装 WinFsp 与 SSHFS-Win，配置密钥登录，或填写已有的 SSHFS 挂载目录。'
        : '请确认发行版已启动，且 Windows 能访问该 WSL 目录。'
      throw new Error(`无法访问本机目录 ${requested}。${advice}`, { cause: error })
    }
    signal?.throwIfAborted()
    if (target.kind !== 'wsl') {
      // A two-way proof catches a wrong mount before either filesystem or Bash is bound.
      const probe = await this.transport.createMountProbe(target, signal)
      try {
        if (!/^\.dsh-ssh-probe-[a-zA-Z0-9-]+$/.test(probe.name)) throw new Error('无效的挂载校验文件名')
        const observed = await abortable(readFile(join(canonical, probe.name), 'utf8'), signal)
        if (observed !== probe.token) throw new Error('挂载内容不匹配')
        signal?.throwIfAborted()
      } catch (error) {
        throw new Error('本机挂载目录与远程目录不一致，无法添加项目。', { cause: error })
      } finally {
        await this.transport.removeMountProbe(target, probe.name, probe.token, AbortSignal.timeout(5_000))
      }
    }
    return canonical
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation)
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }
}
