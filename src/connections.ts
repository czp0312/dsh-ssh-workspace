import { targetKey } from './model.js'
import type { ReconnectRequest, RemoteTarget, SavedWorkspace, WorkspaceMode, WorkspaceView } from './types.js'

interface Connections {
  list(): WorkspaceView[]
  add(input: unknown, signal?: AbortSignal): Promise<SavedWorkspace>
  reconnect(id: string, signal?: AbortSignal): Promise<SavedWorkspace>
  connectProject?(id: string, signal?: AbortSignal): Promise<SavedWorkspace>
  disconnect(id: string): Promise<void>
  remove(id: string): Promise<void>
  checkHealth?(signal: AbortSignal): Promise<void>
  findTarget?(target: RemoteTarget): SavedWorkspace | undefined
}

/** Select the execution world before any connection side effect can begin. */
export class WorkspaceConnections {
  constructor(private light: Connections, private full: Connections) {}
  list(): WorkspaceView[] {
    return [...this.light.list().map(row => ({ ...row, mode: 'light' as const })), ...this.full.list().map(row => ({ ...row, mode: 'full' as const }))]
  }
  async add(input: unknown, signal?: AbortSignal): Promise<SavedWorkspace> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid workspace request')
    const mode = (input as { mode?: unknown }).mode ?? 'full'
    if (mode !== 'light' && mode !== 'full') throw new Error('模式必须是 light 或 full')
    const result = await (mode === 'light' ? this.light : this.full).add(input, signal)
    return { ...result, mode }
  }
  private owner(id: string): { manager: Connections; mode: WorkspaceMode } {
    if (this.full.list().some(row => row.id === id)) return { manager: this.full, mode: 'full' }
    if (this.light.list().some(row => row.id === id)) return { manager: this.light, mode: 'light' }
    throw new Error('远程项目不存在，请刷新列表。')
  }
  async reconnect(id: string, signal?: AbortSignal, options: Pick<ReconnectRequest, 'mode' | 'localPath'> = {}): Promise<SavedWorkspace> {
    const { manager, mode } = this.owner(id)
    if (options.mode !== undefined && options.mode !== 'light' && options.mode !== 'full') throw new Error('模式必须是 light 或 full')
    if (options.mode && options.mode !== mode) {
      const record = manager.list().find(row => row.id === id)!
      const destination = options.mode === 'light' ? this.light : this.full
      const existing = destination.findTarget?.(record.target) ?? destination.list().find(row => targetKey(row.target) === targetKey(record.target))
      // Modes own separate Session stores. Never rewrite a running Session's identity/cwd.
      const result = existing ? await (destination.connectProject?.(existing.id, signal) ?? destination.reconnect(existing.id, signal)) : await destination.add({ target: record.target, title: record.title, mode: options.mode, ...(options.mode === 'light' && options.localPath ? { localPath: options.localPath } : {}) }, signal)
      return { ...result, mode: options.mode }
    }
    return { ...await manager.reconnect(id, signal), mode }
  }
  async disconnect(id: string): Promise<void> { await this.owner(id).manager.disconnect(id) }
  async checkHealth(signal: AbortSignal): Promise<void> { await Promise.allSettled([this.light.checkHealth?.(signal), this.full.checkHealth?.(signal)]) }
  async remove(id: string): Promise<void> { await this.owner(id).manager.remove(id) }
}
