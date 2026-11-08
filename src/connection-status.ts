import type { ConnectionState, WorkspaceView } from './types.js'

export function connectionState(workspace: WorkspaceView): ConnectionState {
  if (workspace.disconnected) return 'disconnected'
  return workspace.connectionState ?? (workspace.online ? 'connected' : 'disconnected')
}

export const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connected: '已连接', disconnected: '未连接', connecting: '连接中', error: '连接异常',
}
