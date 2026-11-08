import { posix, win32 } from 'node:path'
import type { AddWorkspaceRequest, RemoteTarget, SavedWorkspace, SshTarget, WslTarget } from './types.js'

const controls = /[\u0000-\u001f\u007f-\u009f]/u

function object(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object`)
  }
  return input as Record<string, unknown>
}

function text(input: unknown, label: string): string {
  if (typeof input !== 'string' || controls.test(input)) {
    throw new TypeError(`${label} must be a string without control characters`)
  }
  return input
}

function identifier(input: unknown, label: string): string {
  const value = text(input, label).trim()
  if (!value || value.startsWith('-') || /[/\\]/u.test(value)) {
    throw new TypeError(`${label} must be nonempty, without a leading '-' or path separators`)
  }
  return value
}

function remotePath(input: unknown): string {
  const value = text(input, 'remotePath')
  if (!posix.isAbsolute(value) || value.includes('\\')) {
    throw new TypeError('remotePath must be an absolute POSIX path without backslashes')
  }
  return posix.normalize(value).replace(/\/+$/u, '') || '/'
}

/** Validate connection data without interpreting host aliases as user@host or host:port. */
export function validateTarget(input: unknown): RemoteTarget {
  const value = object(input, 'target')
  const path = remotePath(value.remotePath)
  if (value.kind === 'docker') {
    const container = identifier(value.container, 'container')
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) throw new TypeError('无效的 Docker 容器名称或 ID。')
    const containerName = value.containerName === undefined ? undefined : identifier(value.containerName, 'container name')
    if (containerName && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerName)) throw new TypeError('无效的 Docker 容器显示名称。')
    const context = value.context === undefined ? undefined : identifier(value.context, 'Docker context')
    if (context && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(context)) throw new TypeError('无效的 Docker context 名称。')
    const via = value.via === undefined ? undefined : validateTarget(value.via)
    if (via && via.kind !== 'ssh') throw new TypeError('Docker 的远程宿主必须是 SSH。')
    if (via && context) throw new TypeError('Docker context 与 SSH 宿主不能同时指定。')
    const user = value.user === undefined ? undefined : text(value.user, 'Docker user').trim()
    if (user && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*(?::[a-zA-Z0-9_][a-zA-Z0-9_.-]*)?$/.test(user)) throw new TypeError('Docker 用户应为用户名或 UID，可附带 :组名 / GID。')
    if (user === '') throw new TypeError('Docker user must be nonempty')
    return { kind: 'docker', container, remotePath: path, ...(containerName ? { containerName } : {}), ...(context ? { context } : {}), ...(via ? { via } : {}), ...(user ? { user } : {}) }
  }
  const user = value.user === undefined ? undefined : identifier(value.user, 'user')
  if (user !== undefined && /\s/u.test(user)) throw new TypeError('user must not contain whitespace')

  if (value.kind === 'wsl') {
    const distribution = identifier(value.distribution, 'distribution')
    if (/[:*?"<>|]/u.test(distribution) || distribution === '.' || distribution.endsWith('.')) {
      throw new TypeError('distribution must be a valid WSL share name')
    }
    return { kind: 'wsl', distribution, ...(user === undefined ? {} : { user }), remotePath: path }
  }
  if (value.kind === 'ssh') {
    const host = identifier(value.host, 'host')
    if (/[\s@]/u.test(host)) throw new TypeError('host must not contain whitespace or @; specify user separately')
    const port = value.port
    if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) {
      throw new TypeError('port must be an integer between 1 and 65535')
    }
    let identityFile: string | undefined
    if (value.identityFile !== undefined) {
      const key = text(value.identityFile, 'identityFile').trim()
      identityFile = /^~[/\\]/u.test(key) ? key : nativePath(key, process.platform)
      if (!identityFile || identityFile.length > 4096) throw new TypeError('密钥文件路径必须是本机绝对路径或 ~/.ssh/…，不能填写密钥内容。')
      if (/\.pub$/iu.test(identityFile)) throw new TypeError('请选择私钥文件，不是 .pub 公钥文件。')
      if (/\.ppk$/iu.test(identityFile)) throw new TypeError('系统 OpenSSH 不能直接使用 PuTTY .ppk 文件，请先转换为 OpenSSH 私钥。')
    }
    const auth = value.auth
    if (auth !== undefined && !['auto', 'password', 'key', 'certificate'].includes(auth as string)) throw new TypeError('无效的 SSH 登录方式。')
    let certificateFile: string | undefined
    if (value.certificateFile !== undefined) {
      const certificate = text(value.certificateFile, 'certificateFile').trim()
      certificateFile = /^~[/\\]/u.test(certificate) ? certificate : nativePath(certificate, process.platform)
      if (!certificateFile || certificateFile.length > 4096) throw new TypeError('证书文件必须是本机绝对路径或 ~/ 开头的路径。')
    }
    if ((auth === 'key' || auth === 'certificate') && !identityFile) throw new TypeError('请选择配套的 SSH 私钥文件。')
    if (auth === 'certificate' && !certificateFile) throw new TypeError('请选择 OpenSSH 用户证书文件。')
    if (auth === 'password' && (identityFile || certificateFile)) throw new TypeError('仅密码方式不能携带密钥或证书。')
    if (certificateFile && auth !== 'certificate') throw new TypeError('证书文件只能用于证书登录方式。')
    return { kind: 'ssh', host, ...(port === undefined ? {} : { port: port as number }), ...(user === undefined ? {} : { user }), ...(identityFile === undefined ? {} : { identityFile }), ...(auth === undefined ? {} : { auth: auth as SshTarget['auth'] }), ...(certificateFile ? { certificateFile } : {}), remotePath: path }
  }
  throw new TypeError('target.kind must be ssh, wsl or docker')
}

/** Lexical normalization only: a disconnected mount need not currently exist. */
function nativePath(input: unknown, platform: NodeJS.Platform): string | undefined {
  if (typeof input !== 'string' || !input || controls.test(input)) return undefined
  const paths = platform === 'win32' ? win32 : posix
  if (!paths.isAbsolute(input)) return undefined
  if (platform === 'win32') {
    // Root-relative and drive-relative paths depend on process state. Device namespaces
    // have different normalization rules and cannot safely share this lexical mapping.
    if (/^[/\\]{2}[?.][/\\]/u.test(input)) return undefined
    if (!/^[a-z]:[/\\]/iu.test(input) && !/^[/\\]{2}[^/\\]+[/\\]+[^/\\]+(?:[/\\]|$)/u.test(input)) return undefined
  }
  const normalized = paths.normalize(input)
  const root = paths.parse(normalized).root
  return normalized.length > root.length && normalized.endsWith(paths.sep)
    ? normalized.slice(0, -1)
    : normalized
}

export function validateAddRequest(input: unknown): AddWorkspaceRequest {
  const value = object(input, 'workspace request')
  const target = validateTarget(value.target)
  const title = value.title === undefined ? undefined : text(value.title, 'title').trim()
  const localPath = value.localPath === undefined ? undefined : nativePath(value.localPath, process.platform)
  if (value.localPath !== undefined && localPath === undefined) {
    throw new TypeError('localPath must be an absolute native path without control characters')
  }
  return { target, ...(title ? { title } : {}), ...(localPath === undefined ? {} : { localPath }) }
}

export function wslUncPath(target: WslTarget): string {
  const value = validateTarget(target)
  if (value.kind !== 'wsl') throw new TypeError('Expected a WSL target')
  // The WSL network share cannot reliably traverse drvfs mounts. The ledger keeps
  // the Linux path and distro, so this native view never changes command routing.
  const drive = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/u.exec(value.remotePath)
  if (drive) return `${drive[1]!.toUpperCase()}:\\${(drive[2] ?? '').replaceAll('/', '\\')}`
  return `\\\\wsl.localhost\\${value.distribution}\\${value.remotePath.slice(1).replaceAll('/', '\\')}`
}

export function sshfsUncPath(target: SshTarget, remoteUser: string): string {
  const value = validateTarget(target)
  if (value.kind !== 'ssh') throw new TypeError('Expected an SSH target')
  if (value.identityFile || value.auth === 'password' || value.auth === 'certificate') throw new TypeError('轻量模式的自动 SSHFS 共享不能传入指定凭据。请填写已使用同一凭据建立的挂载路径，或选择全量模式。')
  const user = identifier(remoteUser, 'remoteUser')
  if (!/^[a-z0-9._-]+$/iu.test(value.host) || !/^[a-z0-9._-]+$/iu.test(user)) {
    throw new TypeError('Automatic SSHFS paths require a simple hostname and user; provide an existing mount for IPv6 or other SSH identities')
  }
  return `\\\\sshfs.kr\\${user}@${value.host}!${value.port ?? 22}\\${value.remotePath.slice(1).replaceAll('/', '\\')}`
}

export function toRemotePath(
  localPath: string,
  workspace: SavedWorkspace,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const root = nativePath(workspace.localPath, platform)
  const candidate = nativePath(localPath, platform)
  if (root === undefined || candidate === undefined) return undefined
  const paths = platform === 'win32' ? win32 : posix
  const relative = paths.relative(root, candidate)
  if (relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) return undefined
  const suffix = relative.split(paths.sep).join('/')
  if (suffix.includes('\\')) return undefined
  return posix.join(remotePath(workspace.target.remotePath), suffix)
}

/** Forward-slash paths are Linux paths; backslashes/drive names identify native input. */
export function remoteWorkdir(
  input: string | undefined,
  currentLocalPath: string,
  workspace: SavedWorkspace,
  platform: NodeJS.Platform = process.platform,
): string {
  const current = toRemotePath(currentLocalPath, workspace, platform)
  if (current === undefined) throw new Error('Current native directory is outside the mapped workspace')
  if (input === undefined || input === '') return current
  const value = text(input, 'cwd')
  const windowsPath = /^[a-z]:/iu.test(value) || value.includes('\\') || (platform === 'win32' && value.startsWith('//'))
  if (windowsPath) {
    if (platform !== 'win32') throw new Error('Native directory is outside the mapped workspace')
    if (/^[a-z]:(?![/\\])/iu.test(value)) throw new TypeError('Native cwd must not be drive-relative')
    const translated = toRemotePath(win32.resolve(currentLocalPath, value), workspace, platform)
    if (translated === undefined) throw new Error('Native directory is outside the mapped workspace')
    return translated
  }
  // A native POSIX mount path is recognizable when contained in the mapping.
  // Other POSIX absolute paths address the remote filesystem directly.
  if (platform !== 'win32' && posix.isAbsolute(value)) {
    const translated = toRemotePath(value, workspace, platform)
    if (translated !== undefined) return translated
  }
  return remotePath(posix.resolve(current, value))
}

export function targetKey(target: RemoteTarget): string {
  const value = validateTarget(target)
  if (value.kind === 'docker') return JSON.stringify(['docker', value.context ?? '', value.via ? targetKey({ ...value.via, remotePath: '/' }) : '', value.container, value.user ?? '', value.remotePath])
  return value.kind === 'ssh'
    ? JSON.stringify(['ssh', value.host.toLowerCase(), value.port ?? 22, value.user ?? '', value.remotePath, ...(value.identityFile ? [value.identityFile] : []), ...(value.auth && value.auth !== 'auto' && value.auth !== 'key' ? [value.auth] : []), ...(value.certificateFile ? [value.certificateFile] : [])])
    : JSON.stringify(['wsl', value.distribution.toLowerCase(), value.user ?? '', value.remotePath])
}
