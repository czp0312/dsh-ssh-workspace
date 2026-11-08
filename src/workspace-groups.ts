import { connectionState } from './connection-status.js'
import { environmentKey, sshTarget, type ConnectionState, type RemoteTarget, type WorkspaceView } from './types.js'

export type GroupState = ConnectionState | 'partial'
export interface ConnectionGroup { key: string; backendId?: string; rows: WorkspaceView[]; visible: WorkspaceView[] }
export interface EnvironmentGroup { key: string; target: RemoteTarget; rows: WorkspaceView[]; visible: WorkspaceView[]; connections: ConnectionGroup[]; light: WorkspaceView[] }

/** Presentation only: never infer transport ownership from host names or credentials. */
export function groupWorkspaces(rows: readonly WorkspaceView[], matches: (row: WorkspaceView) => boolean = () => true): EnvironmentGroup[] {
  const environments = new Map<string, EnvironmentGroup>()
  for (const row of rows) {
    if (row.removedAt !== undefined) continue
    const key = environmentKey(row.target)
    let group = environments.get(key)
    if (!group) { group = { key, target: row.target, rows: [], visible: [], connections: [], light: [] }; environments.set(key, group) }
    group.rows.push(row)
    if (matches(row)) group.visible.push(row)
    if (row.mode !== 'full') { if (matches(row)) group.light.push(row); continue }
    const connectionKey = row.backendId ? `backend:${row.backendId}` : `project:${row.id}`
    let connection = group.connections.find(item => item.key === connectionKey)
    if (!connection) { connection = { key: connectionKey, backendId: row.backendId, rows: [], visible: [] }; group.connections.push(connection) }
    connection.rows.push(row)
    if (matches(row)) connection.visible.push(row)
  }
  return [...environments.values()].filter(group => group.visible.length)
}

export function aggregateState(states: readonly ConnectionState[]): GroupState {
  const unique = new Set(states)
  if (unique.has('connecting')) return 'connecting'
  if (unique.size <= 1) return states[0] ?? 'disconnected'
  return 'partial'
}

export function backendState(rows: readonly WorkspaceView[]): ConnectionState {
  if (rows.some(row => row.disconnected)) return 'disconnected'
  const authoritative = rows.find(row => row.backendHealth)?.backendHealth
  if (authoritative) return authoritative.connectionState
  const states = rows.map(connectionState)
  return states.includes('connecting') ? 'connecting' : states.includes('connected') ? 'connected' : states.includes('error') ? 'error' : 'disconnected'
}

export function environmentLabel(target: RemoteTarget): string {
  if (target.kind === 'wsl') return target.distribution
  if (target.kind === 'ssh') return `${target.host}${target.port ? `:${target.port}` : ' · SSH 配置端口'}`
  return target.containerName ?? target.container.slice(0, 12)
}

export function environmentDetail(target: RemoteTarget): string {
  if (target.kind !== 'docker') return target.kind.toUpperCase()
  return `Docker · ${target.via ? `SSH ${environmentLabel(target.via)}` : target.context ?? '当前 Docker Context'} · ${target.container.slice(0, 12)}`
}

export function connectionLabel(row: WorkspaceView): string {
  const ssh = sshTarget(row.target)
  const user = row.target.user ?? '默认用户'
  const auth = ssh ? ({ auto: '自动认证', password: '密码', key: '密钥', certificate: '证书' }[ssh.auth ?? 'auto']) : ''
  const key = ssh?.identityFile?.split(/[\\/]/).pop()
  return [user, row.target.kind === 'docker' && ssh ? `SSH ${ssh.user ?? '默认用户'}` : '', auth, key].filter(Boolean).join(' · ')
}
