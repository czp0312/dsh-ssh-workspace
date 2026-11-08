import manifest from '../package.json' with { type: 'json' }

export const RPC_CHANNEL = '/api'
export const RPC_PREFIX = 'dsh-ssh-workspaces'
export const PLUGIN_VERSION = manifest.version
export const VERIFIED_DSH_VERSION = '0.2.2-rc.1'

export interface WslTarget {
  kind: 'wsl'
  distribution: string
  user?: string
  remotePath: string
}

export interface SshTarget {
  kind: 'ssh'
  host: string
  port?: number
  user?: string
  /** Local OpenSSH private-key path; key contents and passphrases are never stored. */
  identityFile?: string
  /** Absent preserves the pre-0.2.4 OpenSSH/default-key behavior. */
  auth?: 'auto' | 'password' | 'key' | 'certificate'
  certificateFile?: string
  remotePath: string
}

/** RPC-only input. Never place these fields on a target or durable workspace. */
export interface SshCredentials { password?: string; passphrase?: string }

export type RemoteTarget = WslTarget | SshTarget
export type WorkspaceMode = 'light' | 'full'
export type ConnectionState = 'connected' | 'disconnected' | 'connecting' | 'error'

export interface ConnectionHealth {
  connectionState: ConnectionState
  checkedAt?: number
  connectionError?: string
}

export interface ReconnectRequest {
  id: string
  mode?: WorkspaceMode
  credentials?: SshCredentials
  localPath?: string
}

export interface AddWorkspaceRequest {
  target: RemoteTarget
  credentials?: SshCredentials
  title?: string
  /** Full uses remote DSH; light keeps the Agent local and installs no remote DSH. */
  mode?: WorkspaceMode
  /** An existing SSHFS mount of exactly target.remotePath. WSL derives its UNC path. */
  localPath?: string
}

export interface SavedWorkspace {
  mode?: WorkspaceMode
  id: string
  workspaceId: string
  title: string
  localPath: string
  target: RemoteTarget
  createdAt: number
  /** Retain routing for old sessions after removing a project from the sidebar. */
  removedAt?: number
  /** Explicitly paused by the user. Persist this, never a transient online status. */
  disconnected?: boolean
}

export interface WorkspaceView extends SavedWorkspace {
  registered: boolean
  connectionState?: ConnectionState
  connectionError?: string
  checkedAt?: number
  online?: boolean
  /** Full projects sharing the same connection are disconnected together. */
  sharedConnectionCount?: number
}

export interface RemoteInfo {
  path: string
  home: string
  user: string
  platform: string
  python: string
}

export interface RemoteDirectory {
  path: string
  directories: string[]
}

export interface CommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  aborted: boolean
}

export interface RunOptions {
  cwd?: string
  timeoutMs?: number
  maxOutputBytes?: number
  signal?: AbortSignal
}

export interface PluginConfig {
  stateFile?: string
  sshExecutable?: string
  wslExecutable?: string
  pythonExecutable?: string
  connectTimeoutMs?: number
  /** Optional separate host-key store, primarily for isolated integration tests. */
  knownHostsFile?: string
}
