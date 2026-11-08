import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { access, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validateTarget as validateModelTarget } from './model.js'
import { REMOTE_HELPER, type HelperRequest } from './remote-helper.js'
import { SshAuthBroker } from './ssh-auth.js'
import type { CommandResult, PluginConfig, RemoteDirectory, RemoteInfo, RemoteTarget, RunOptions } from './types.js'

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000
const DEFAULT_OUTPUT = 1024 * 1024
const MAX_OUTPUT = 16 * 1024 * 1024
const LEASE_MS = 5_000
const PROBE_NAME = /^\.dsh-ssh-probe-[a-f0-9]{32}$/
const PROBE_TOKEN = /^[a-f0-9]{64}$/

export interface Invocation { executable: string; args: string[]; env?: NodeJS.ProcessEnv }
type StopReason = 'aborted' | 'timedOut'
interface Job { stop(reason: StopReason): void; done: Promise<CommandResult> }
type Settings = Required<Pick<PluginConfig, 'sshExecutable' | 'wslExecutable' | 'pythonExecutable' | 'connectTimeoutMs'>> & Pick<PluginConfig, 'knownHostsFile'>

function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value || /[\x00-\x1f\x7f]/.test(value) || Buffer.byteLength(value) > max) {
    throw new TypeError(`Invalid ${label}`)
  }
  return value
}

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const result = value === undefined ? fallback : value
  if (typeof result !== 'number' || !Number.isInteger(result) || result < min || result > max) {
    throw new TypeError(`${label} must be an integer from ${min} to ${max}`)
  }
  return result
}

function settings(config: PluginConfig): Settings {
  return {
    sshExecutable: text(config.sshExecutable ?? (process.platform === 'win32' ? 'ssh.exe' : 'ssh'), 'SSH executable'),
    wslExecutable: text(config.wslExecutable ?? 'wsl.exe', 'WSL executable'),
    pythonExecutable: text(config.pythonExecutable ?? 'python3', 'Python executable'),
    connectTimeoutMs: integer(config.connectTimeoutMs, 10_000, 1, 120_000, 'connectTimeoutMs'),
    ...(config.knownHostsFile ? { knownHostsFile: text(config.knownHostsFile, 'known hosts file') } : {}),
  }
}

function remotePath(value: unknown): string {
  const path = text(value, 'remote path')
  if (!path.startsWith('/')) throw new TypeError('Remote paths must be absolute POSIX paths')
  return path
}

/** Apply the shared model, then reject argv/SSH identities the transport cannot handle. */
function validateTarget(input: RemoteTarget): RemoteTarget {
  const target = validateModelTarget(input)
  remotePath(target.remotePath)
  if (target.user !== undefined && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\$?$/.test(text(target.user, 'remote user', 128))) {
    throw new TypeError('Invalid remote user')
  }
  if (target.kind === 'wsl') {
    if (!/^[\p{L}\p{N}_][\p{L}\p{N} ._-]*$/u.test(text(target.distribution, 'WSL distribution', 128))) {
      throw new TypeError('Invalid WSL distribution')
    }
  } else if (target.kind === 'ssh') {
    const host = text(target.host, 'SSH host', 253)
    const ip = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
    if (!isIP(ip) && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(host)) throw new TypeError('Invalid SSH host')
    if (target.port !== undefined) integer(target.port, 22, 1, 65535, 'SSH port')
  } else {
    throw new TypeError('Invalid remote target kind')
  }
  return target
}

export function quotePosix(value: string): string {
  if (value.includes('\0')) throw new TypeError('A POSIX argument cannot contain NUL')
  return "'" + value.replaceAll("'", "'\"'\"'") + "'"
}

function identityPath(path: string): string { return /^~[/\\]/u.test(path) ? join(homedir(), path.slice(2)) : path }

/** Check metadata/read permission only; never read, upload or copy private-key bytes. */
export async function validateIdentityFile(input: RemoteTarget): Promise<void> {
  const target = validateTarget(input)
  if (target.kind !== 'ssh') return
  for (const [file, label] of [[target.identityFile, '私钥'], [target.certificateFile, '证书']] as const) {
    if (!file) continue
    const path = identityPath(file)
    try {
      if (!(await stat(path)).isFile()) throw new Error('not a file')
      await access(path, constants.R_OK)
    } catch { throw new Error(`指定的 SSH ${label}文件不存在、不是文件或不可读。请检查本机文件路径。`) }
  }
}

/** All local launches use argv, never a local shell. SSH receives one quoted command. */
export function buildInvocation(target: RemoteTarget, request: HelperRequest, config: PluginConfig = {}, allowPrompts = false): Invocation {
  return buildPythonInvocation(target, REMOTE_HELPER, request, config, allowPrompts)
}

/** Shared SSH/WSL argv boundary for backend bootstrap and byte tunnels. */
export function buildPythonInvocation(target: RemoteTarget, script: string, request: unknown, config: PluginConfig = {}, allowPrompts = false): Invocation {
  target = validateTarget(target)
  const cfg = settings(config)
  const encoded = Buffer.from(JSON.stringify(request), 'utf8').toString('base64')
  const python = [cfg.pythonExecutable, '-u', '-c', script, encoded]
  let invocation: Invocation
  if (target.kind === 'wsl') {
    invocation = { executable: cfg.wslExecutable, args: [
      '--distribution', target.distribution, ...(target.user ? ['--user', target.user] : []), '--exec', ...python,
    ] }
  } else {
    invocation = { executable: cfg.sshExecutable, args: [
      '-T', '-o', `BatchMode=${allowPrompts ? 'no' : 'yes'}`, '-o', 'StrictHostKeyChecking=yes',
      '-o', `ConnectTimeout=${Math.max(1, Math.ceil(cfg.connectTimeoutMs / 1000))}`,
      '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
      '-o', `NumberOfPasswordPrompts=${allowPrompts ? 1 : 0}`, '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no',
      '-o', 'PermitLocalCommand=no', '-o', 'ClearAllForwardings=yes', '-o', 'RemoteCommand=none',
      ...(cfg.knownHostsFile ? ['-o', `UserKnownHostsFile=${cfg.knownHostsFile}`] : []),
      ...(target.auth === 'password' ? ['-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', '-o', 'KbdInteractiveAuthentication=no'] : []),
      ...(target.identityFile ? ['-i', identityPath(target.identityFile), '-o', 'IdentitiesOnly=yes'] : []),
      ...(target.identityFile || target.auth === 'key' || target.auth === 'certificate' ? ['-o', 'PreferredAuthentications=publickey', '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no'] : []),
      ...(target.certificateFile ? ['-o', `CertificateFile=${identityPath(target.certificateFile)}`] : []),
      ...(target.auth === 'certificate' ? ['-o', 'PubkeyAcceptedAlgorithms=*-cert-v01@openssh.com'] : []),
      ...(target.port === undefined ? [] : ['-p', String(target.port)]),
      ...(target.user ? ['-l', target.user] : []), '--', target.host.replace(/^\[([^\]]+)\]$/, '$1'),
      python.map(quotePosix).join(' '),
    ] }
  }
  // Leave room for CreateProcessW's quoting and executable path (32767 UTF-16 units).
  const windowsSize = invocation.executable.length + invocation.args.reduce((size, arg) => size + arg.length + (arg.match(/["\\]/g)?.length ?? 0) + 3, 0)
  if (windowsSize > 30_000) throw new TypeError('Remote request exceeds the Windows command-line limit')
  return invocation
}

/** WSL prints UTF-16LE even when redirected, sometimes without a BOM. */
export function decodeWslList(output: Buffer): string[] {
  const utf16 = (output[0] === 0xff && output[1] === 0xfe)
    || output.subarray(0, 256).some((byte, index) => index % 2 === 1 && byte === 0)
  const decoded = output.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '')
  return [...new Set(decoded.split(/\r?\n/).map(row => row.trim()).filter(Boolean))]
}

/** Explicit environment, including the SSH agent but no application credentials.
 * In particular, inheriting WSLENV could forward otherwise unrelated host secrets.
 */
export function transportEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|TEMP|TMP|TMPDIR|USER|USERNAME|LOGNAME|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|SSH_AUTH_SOCK|SSH_AGENT_PID|XDG_CONFIG_HOME|XDG_RUNTIME_DIR|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|ALLUSERSPROFILE)$/i
  const credentials = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/i
  return Object.fromEntries(Object.entries(source).filter(([name, value]) => value !== undefined && allowed.test(name) && !credentials.test(name)))
}

/** A fixed-size ring retains the tail and continues draining both OS pipes. */
class Capture {
  private buffer: Buffer | undefined
  private length = 0
  private position = 0
  truncated = false
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    if (this.length + chunk.length > this.limit) this.truncated = true
    if (this.limit === 0) return
    this.buffer ??= Buffer.allocUnsafe(this.limit)
    if (chunk.length >= this.limit) {
      chunk.copy(this.buffer, 0, chunk.length - this.limit)
      this.position = 0
      this.length = this.limit
      return
    }
    const first = Math.min(chunk.length, this.limit - this.position)
    chunk.copy(this.buffer, this.position, 0, first)
    chunk.copy(this.buffer, 0, first)
    this.position = (this.position + chunk.length) % this.limit
    this.length = Math.min(this.limit, this.length + chunk.length)
  }
  bytes(): Buffer {
    if (!this.buffer) return Buffer.alloc(0)
    if (this.length < this.limit) return this.buffer.subarray(0, this.length)
    return Buffer.concat([this.buffer.subarray(this.position), this.buffer.subarray(0, this.position)])
  }
}

function abortError(): Error { return Object.assign(new Error('Remote operation was aborted'), { name: 'AbortError' }) }

export class RemoteTransport {
  private readonly config: Settings
  private readonly jobs = new Set<Job>()
  private readonly probes = new Set<Promise<unknown>>()
  private disposed = false
  private disposing: Promise<void> | undefined
  private readonly auth = new SshAuthBroker()

  constructor(config: PluginConfig = {}) { this.config = settings(config) }

  setCredentials(target: RemoteTarget, credentials: unknown): void { this.auth.set(validateTarget(target), credentials) }

  async pythonInvocation(target: RemoteTarget, script: string, payload: unknown, cleanup = false): Promise<Invocation> {
    if (!cleanup) this.assertOpen()
    await validateIdentityFile(target)
    const env = { ...transportEnvironment(), ...await this.auth.environment(target) }
    return { ...buildPythonInvocation(target, script, payload, this.config, this.auth.has(target)), env }
  }

  async python<T>(target: RemoteTarget, script: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    this.assertOpen()
    signal?.throwIfAborted()
    const invocation = await this.pythonInvocation(target, script, payload)
    signal?.throwIfAborted()
    const result = await this.execute(invocation, 600_000, DEFAULT_OUTPUT, signal)
    this.requireSuccess(result)
    return JSON.parse(result.stdout) as T
  }

  async listWsl(signal?: AbortSignal): Promise<string[]> {
    this.assertOpen()
    const result = await this.execute({ executable: this.config.wslExecutable, args: ['--list', '--quiet'] }, this.requestTimeout, DEFAULT_OUTPUT, signal)
    this.requireSuccess(result)
    // execute's raw buffer is needed here, because UTF-8 decoding loses UTF-16 bytes.
    return decodeWslList(result.rawStdout)
  }

  async inspect(target: RemoteTarget, signal?: AbortSignal): Promise<RemoteInfo> {
    const value = await this.request(target, { op: 'inspect', path: remotePath(target.remotePath) }, signal)
    for (const key of ['path', 'home', 'user', 'platform', 'python']) text(value[key], `helper ${key}`)
    return value as unknown as RemoteInfo
  }

  async browse(target: RemoteTarget, path: string, signal?: AbortSignal): Promise<RemoteDirectory> {
    const value = await this.request(target, { op: 'browse', path: remotePath(path) }, signal)
    text(value.path, 'helper path')
    if (!Array.isArray(value.directories) || value.directories.length > 4096
      || value.directories.some(name => typeof name !== 'string' || !name || name === '.' || name === '..' || /[\/\0]/.test(name))) {
      throw new Error('Invalid directory response from remote helper')
    }
    return { path: value.path as string, directories: value.directories as string[] }
  }

  async run(target: RemoteTarget, command: string, opts: RunOptions = {}): Promise<CommandResult> {
    this.assertOpen()
    target = validateTarget(target)
    if (typeof command !== 'string' || !command.trim() || command.includes('\0') || Buffer.byteLength(command) > 8192) {
      throw new TypeError('Command must be nonempty, contain no NUL, and fit in 8192 UTF-8 bytes')
    }
    const timeoutMs = integer(opts.timeoutMs, DEFAULT_TIMEOUT, 1, MAX_TIMEOUT, 'timeoutMs')
    const maxOutput = integer(opts.maxOutputBytes, DEFAULT_OUTPUT, 0, MAX_OUTPUT, 'maxOutputBytes')
    const request: HelperRequest = {
      op: 'run', cwd: remotePath(opts.cwd ?? target.remotePath), command, timeoutMs, leaseMs: LEASE_MS,
    }
    const invocation = opts.signal?.aborted ? buildInvocation(target, request, this.config) : await this.pythonInvocation(target, REMOTE_HELPER, request)
    const { rawStdout: _raw, ...result } = await this.execute(invocation, timeoutMs, maxOutput, opts.signal)
    return result
  }

  async createMountProbe(target: RemoteTarget, signal?: AbortSignal): Promise<{ name: string; token: string }> {
    this.assertOpen()
    target = validateTarget(target)
    if (signal?.aborted) throw abortError()
    // Keep both locally before any remote I/O: even a lost response can be cleaned up.
    const probe = { name: `.dsh-ssh-probe-${randomBytes(16).toString('hex')}`, token: randomBytes(32).toString('hex') }
    const task = (async () => {
      try {
        const value = await this.request(target, { op: 'probe-create', path: target.remotePath, ...probe }, signal)
        if (value.name !== probe.name || value.token !== probe.token) throw new Error('Invalid probe response')
        if (signal?.aborted) throw abortError()
        return probe
      } catch (error) {
        try {
          // Cancellation/disposal of the creator must not cancel its compensating cleanup.
          await this.request(target, { op: 'probe-remove', path: target.remotePath, ...probe }, AbortSignal.timeout(5_000), true)
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], `Probe request failed; cleanup could not be confirmed for ${probe.name}`)
        }
        throw error
      }
    })()
    this.probes.add(task)
    try { return await task } finally { this.probes.delete(task) }
  }

  async removeMountProbe(target: RemoteTarget, name: string, token: string, signal?: AbortSignal): Promise<void> {
    if (!PROBE_NAME.test(name) || !PROBE_TOKEN.test(token)) throw new TypeError('Invalid probe name or token')
    const value = await this.request(target, { op: 'probe-remove', path: remotePath(target.remotePath), name, token }, signal)
    if (value.ok !== true) throw new Error('Invalid probe cleanup response')
  }

  dispose(): Promise<void> {
    if (this.disposing) return this.disposing
    this.disposed = true
    this.disposing = (async () => {
      for (const job of this.jobs) job.stop('aborted')
      await Promise.allSettled([...this.jobs].map(job => job.done))
      await Promise.allSettled([...this.probes])
      await this.auth.dispose()
    })()
    return this.disposing
  }

  /** Overridable only to run the real helper against local Python in isolated tests. */
  protected spawnProcess(invocation: Invocation): ChildProcessWithoutNullStreams {
    return spawn(invocation.executable, invocation.args, {
      shell: false, windowsHide: true, stdio: 'pipe', env: invocation.env ?? transportEnvironment(),
    })
  }

  private get requestTimeout(): number { return this.config.connectTimeoutMs + 15_000 }
  private assertOpen(): void { if (this.disposed) throw new Error('Remote transport is disposed') }

  private async request(target: RemoteTarget, payload: HelperRequest, signal?: AbortSignal, cleanup = false): Promise<Record<string, unknown>> {
    if (!cleanup) this.assertOpen()
    signal?.throwIfAborted()
    const invocation = await this.pythonInvocation(target, REMOTE_HELPER, payload, cleanup)
    signal?.throwIfAborted()
    const result = await this.execute(invocation, this.requestTimeout, DEFAULT_OUTPUT, signal)
    this.requireSuccess(result)
    let value: unknown
    try { value = JSON.parse(result.stdout) } catch { throw new Error('Invalid JSON from remote helper') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response from remote helper')
    return value as Record<string, unknown>
  }

  private requireSuccess(result: CommandResult): void {
    if (result.aborted) throw abortError()
    if (result.timedOut) throw Object.assign(new Error('Remote operation timed out'), { name: 'TimeoutError' })
    if (result.stdoutTruncated || result.stderrTruncated) throw new Error('Remote response exceeded the output limit')
    if (result.exitCode !== 0) {
      const hint = /UNPROTECTED PRIVATE KEY FILE|bad permissions|permissions.*too open/i.test(result.stderr)
        ? '\n本机私钥文件权限过宽，已被 OpenSSH 忽略。请将该文件的访问权限限制到当前用户后重试；插件不会自动修改私钥权限。'
        : /Permission denied|sign_and_send_pubkey|Load key|identity file|no such identity/i.test(result.stderr)
        ? '\nSSH 认证失败：请核对登录方式、用户名、密码或密钥；加密私钥请填写私钥口令，也可使用 ssh-agent。证书登录请核对证书有效期及服务器 CA 配置。'
        : /Host key verification failed/i.test(result.stderr) ? '\n请先在终端手动连接此主机并核对主机指纹，再在插件中重试。' : ''
      throw new Error(`Remote operation failed (exit ${result.exitCode ?? 'terminated'})${result.stderr ? ': ' + result.stderr.slice(-4096).trim() : ''}${hint}`)
    }
  }

  private execute(invocation: Invocation, timeoutMs: number, maxOutput: number, signal?: AbortSignal): Promise<CommandResult & { rawStdout: Buffer }> {
    const empty = { exitCode: null, stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, timedOut: false, aborted: true, rawStdout: Buffer.alloc(0) }
    if (signal?.aborted) return Promise.resolve(empty)
    const stdout = new Capture(maxOutput)
    const stderr = new Capture(maxOutput)
    let child: ChildProcessWithoutNullStreams
    try { child = this.spawnProcess(invocation) } catch (cause) { return Promise.reject(new Error('Cannot start remote transport', { cause })) }
    let stopReason: StopReason | undefined
    let settled = false
    let deadline: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let terminate: ReturnType<typeof setTimeout> | undefined
    let force: ReturnType<typeof setTimeout> | undefined
    let drain: ReturnType<typeof setTimeout> | undefined
    let finish!: (error?: Error) => void
    const kill = (sig: NodeJS.Signals) => { try { child.kill(sig) } catch { /* hard deadline below still drains */ } }
    const stop = (reason: StopReason) => {
      if (settled || stopReason) return
      stopReason = reason
      clearInterval(heartbeat)
      // EOF reaches the helper first, giving its process group time to terminate.
      child.stdin.end()
      terminate = setTimeout(() => {
        kill('SIGTERM')
        force = setTimeout(() => {
          kill('SIGKILL')
          drain = setTimeout(() => finish(), 500)
        }, 500)
      }, 1_000)
    }
    const onAbort = () => stop('aborted')
    const done = new Promise<CommandResult & { rawStdout: Buffer }>((resolve, reject) => {
      finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(deadline); clearInterval(heartbeat); clearTimeout(terminate); clearTimeout(force); clearTimeout(drain)
        signal?.removeEventListener('abort', onAbort)
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
        this.jobs.delete(job)
        if (error) { reject(error); return }
        const rawStdout = stdout.bytes()
        resolve({
          exitCode: child.exitCode, stdout: rawStdout.toString('utf8'), stderr: stderr.bytes().toString('utf8'),
          stdoutTruncated: stdout.truncated, stderrTruncated: stderr.truncated,
          timedOut: stopReason === 'timedOut', aborted: stopReason === 'aborted', rawStdout,
        })
      }
      child.stdout.on('data', (data: Buffer) => stdout.push(data))
      child.stderr.on('data', (data: Buffer) => stderr.push(data))
      // EPIPE is normal when an already-exited helper races a heartbeat.
      child.stdin.on('error', () => {})
      child.once('error', cause => finish(new Error('Cannot start remote transport', { cause })))
      child.once('close', () => finish())
      child.once('exit', () => {
        clearInterval(heartbeat)
        child.stdin.end()
        // A broken transport/descendant must not hold inherited output pipes forever.
        if (!settled) drain = setTimeout(() => finish(), 500)
      })
    })
    const job: Job = { stop, done }
    this.jobs.add(job)
    const beat = () => {
      if (!settled && !stopReason && !child.stdin.destroyed && child.stdin.writable && child.stdin.writableLength < 1024) child.stdin.write('h\n')
    }
    deadline = setTimeout(() => stop('timedOut'), timeoutMs)
    heartbeat = setInterval(beat, 1_000)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort(); else beat()
    return done
  }
}
