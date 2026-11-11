import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, createHmac } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { isHostKeyFingerprint } from './host-key.js'
import { validateTarget } from './model.js'
import { sshTarget as sshTargetOf, type HostKeyConflict, type HostKeyEntry, type HostKeyInspection, type HostKeyTrustResult, type RemoteTarget, type SshTarget } from './types.js'

const KEY_TYPE = /^(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp(?:256|384|521)|sk-(?:ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)$/
const KEY_NAME = /^[A-Za-z0-9_.:\[\]-]{1,512}$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const MAX_KEYS = 16
const MAX_PROBE_OUTPUT = 64 * 1024

export interface HostKeyOptions {
  sshExecutable: string
  /** Optional separate host-key store, primarily for isolated integration tests. */
  knownHostsFile?: string
  connectTimeoutMs: number
  /** Test seam: replace the local OpenSSH probe with a deterministic fake. */
  runProbe?: (invocation: { executable: string; args: string[] }, env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ stderr: string; timedOut: boolean }>
}

interface LearnedKey { name: string; type: string; blob: Buffer; fingerprint: string }

interface StoredKey {
  names: string[]
  /** `@cert-authority` or `@revoked` on the line. */
  marker?: string
  type: string
  blob: Buffer
  hashed?: { salt: Buffer; hash: Buffer }
}

export function fingerprintOf(blob: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')
}

/** A host key blob is typed: 4-byte big-endian length, type name, key material. */
export function decodeHostKeyBlob(encoded: string): { type: string; blob: Buffer } | undefined {
  if (!BASE64.test(encoded) || encoded.length > 8192) return undefined
  const blob = Buffer.from(encoded, 'base64')
  if (blob.length < 8 || blob.length > 4096) return undefined
  const length = blob.readUInt32BE(0)
  if (length < 1 || length > 128 || 4 + length > blob.length) return undefined
  const type = blob.subarray(4, 4 + length).toString('latin1')
  return KEY_TYPE.test(type) ? { type, blob } : undefined
}

/** Parse a known-hosts file, including hashed (`|1|salt|hash`), wildcard and marker lines. */
export function parseKnownHosts(text: string): StoredKey[] {
  const keys: StoredKey[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let fields = line.split(/\s+/)
    let marker: string | undefined
    if (fields[0]?.startsWith('@')) { marker = fields[0]; fields = fields.slice(1) }
    if (fields.length < 3) continue
    const [names, type, encoded] = fields
    if (!names || !type || !encoded) continue
    const decoded = decodeHostKeyBlob(encoded)
    if (!decoded || decoded.type !== type) continue
    const key: StoredKey = { names: names.split(','), marker, type, blob: decoded.blob }
    if (names.startsWith('|1|')) {
      const [, , salt, hash] = names.split('|')
      if (!salt || !hash) continue
      key.hashed = { salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') }
    }
    keys.push(key)
  }
  return keys
}

/** Host-pattern matching as OpenSSH does it in known_hosts: wildcards, negation, no regex. */
export function hostPatternMatches(pattern: string, name: string): boolean {
  if (pattern.startsWith('!')) return false
  const source = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  try { return new RegExp('^' + source + '$', 'i').test(name) } catch { return false }
}

export function matchesHost(key: StoredKey, name: string): boolean {
  if (key.hashed) {
    const digest = createHmac('sha1', key.hashed.salt).update(name).digest()
    return digest.length === key.hashed.hash.length && digest.equals(key.hashed.hash)
  }
  return key.names.some(pattern => hostPatternMatches(pattern, name))
}

/** Parse the private store ssh itself wrote; the server controls these bytes, so validate them. */
export function parseLearnedHostKeys(text: string): LearnedKey[] {
  const keys = new Map<string, LearnedKey>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('@')) continue
    const fields = line.split(/\s+/)
    if (fields.length < 3) continue
    const [names, type, encoded] = fields
    if (!names || !type || !encoded) continue
    const decoded = decodeHostKeyBlob(encoded)
    if (!decoded || decoded.type !== type) continue
    for (const name of names.split(',')) {
      if (!KEY_NAME.test(name) || name.startsWith('-')) continue
      const fingerprint = fingerprintOf(decoded.blob)
      const id = `${name}\u0000${type}\u0000${fingerprint}`
      if (!keys.has(id)) keys.set(id, { name, type: decoded.type, blob: decoded.blob, fingerprint })
    }
  }
  return [...keys.values()].slice(0, MAX_KEYS)
}

/** OpenSSH formatting of the host field: `[host]:port` unless the port is 22. */
export function hostKeyEntryName(host: string, port: number): string {
  const bare = host.replace(/^\[([^\]]+)\]$/, '$1')
  return port === 22 ? bare : `[${bare}]:${port}`
}

/** Inverse of {@link hostKeyEntryName}: recover the address and port ssh actually uses. */
export function parseHostKeyEntryName(name: string): { host: string; port: number } {
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(name)
  if (bracketed) return { host: bracketed[1]!, port: Number(bracketed[2]!) }
  return { host: name.replace(/^\[([^\]]+)\]$/, '$1'), port: 22 }
}

/** Probe argv: learn the host key into an isolated store, then fail before authentication. */
export function hostKeyProbeInvocation(target: SshTarget, options: HostKeyOptions & { probeDirectory: string }): { executable: string; args: string[] } {
  const host = target.host.replace(/^\[([^\]]+)\]$/, '$1')
  return {
    executable: options.sshExecutable,
    args: [
      '-T', '-N',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${join(options.probeDirectory, 'known_hosts')}`,
      '-o', `GlobalKnownHostsFile=${join(options.probeDirectory, 'no-global-known-hosts')}`,
      '-o', 'HashKnownHosts=no',
      '-o', `ConnectTimeout=${Math.max(1, Math.ceil(options.connectTimeoutMs / 1000))}`,
      '-o', 'NumberOfPasswordPrompts=0',
      '-o', 'PreferredAuthentications=none',
      '-o', 'PasswordAuthentication=no',
      '-o', 'PubkeyAuthentication=no',
      '-o', 'KbdInteractiveAuthentication=no',
      '-o', 'ForwardAgent=no',
      '-o', 'ForwardX11=no',
      '-o', 'PermitLocalCommand=no',
      '-o', 'ClearAllForwardings=yes',
      ...(target.port === undefined ? [] : ['-p', String(target.port)]),
      ...(target.user ? ['-l', target.user] : []),
      '--', host,
    ],
  }
}

function expandPath(path: string): string {
  return /^~[/\\]/.test(path) ? join(homedir(), path.slice(2)) : path
}

async function readIfExists(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw new Error(`无法读取已知主机文件 ${path}。`, { cause: error })
  }
}

function lastMeaningfulLine(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !/^Warning: Permanently added/i.test(line) && !line.startsWith('debug'))
  const line = lines.at(-1)
  return line ? line.slice(0, 300) : undefined
}

type ProbeResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function probeProcess(executable: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env })
    } catch (cause) { reject(new Error('无法启动本机 SSH 客户端以读取主机密钥。', { cause })); return }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let captured = 0
    let settled = false
    let timedOut = false
    let failure: Error | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let kill: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer); clearTimeout(kill)
      child.stdout?.destroy(); child.stderr?.destroy()
      if (failure) reject(failure)
      else resolve({ code: child.exitCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), timedOut })
    }
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (captured >= MAX_PROBE_OUTPUT) return
      captured += chunk.length
      target.push(chunk)
    }
    child.stdout?.on('data', collect(stdout))
    child.stderr?.on('data', collect(stderr))
    child.once('error', cause => { failure = new Error('无法启动本机 SSH 客户端以读取主机密钥。', { cause }); finish() })
    child.once('close', finish)
    timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      kill = setTimeout(() => child.kill('SIGKILL'), 1_000)
    }, timeoutMs)
  })
}

/** A host key that contradicts an existing record is reported, never replaced. */
function compareWithKnown(keys: LearnedKey[], stored: StoredKey[]): { trusted: Set<string>; conflicts: HostKeyConflict[] } {
  const trusted = new Set<string>()
  const conflicts: HostKeyConflict[] = []
  const seen = new Set<string>()
  const conflict = (entry: HostKeyConflict) => {
    const id = `${entry.type}\u0000${entry.fingerprint}\u0000${entry.existing}`
    if (!seen.has(id)) { seen.add(id); conflicts.push(entry) }
  }
  for (const key of keys) {
    for (const row of stored) {
      if (row.type !== key.type || !matchesHost(row, key.name)) continue
      if (row.marker === '@revoked') conflict({ type: key.type, fingerprint: key.fingerprint, existing: '@revoked' })
      else if (row.marker) continue
      else if (row.blob.equals(key.blob)) trusted.add(key.fingerprint)
      else conflict({ type: key.type, fingerprint: key.fingerprint, existing: fingerprintOf(row.blob) })
    }
  }
  return { trusted, conflicts }
}

/** Reads host keys through the user's own ssh configuration and stores confirmed ones. */
export class HostKeys {
  constructor(private readonly options: HostKeyOptions) {}

  knownHostsPath(): string {
    return expandPath(this.options.knownHostsFile ?? join(homedir(), '.ssh', 'known_hosts'))
  }

  async inspect(input: RemoteTarget, env: NodeJS.ProcessEnv): Promise<HostKeyInspection> {
    const target = this.sshTarget(input)
    const keys = await this.learn(target, env)
    const knownHostsFile = this.knownHostsPath()
    const stored = parseKnownHosts(await readIfExists(knownHostsFile))
    const { trusted, conflicts } = compareWithKnown(keys, stored)
    // One display row per distinct fingerprint; a learned file can alias one key to several names.
    const entries: HostKeyEntry[] = []
    const displayed = new Set<string>()
    for (const key of keys) {
      if (displayed.has(key.fingerprint)) continue
      displayed.add(key.fingerprint)
      entries.push({ type: key.type, fingerprint: key.fingerprint, trusted: trusted.has(key.fingerprint) })
    }
    const anyKnown = stored.some(row => !row.marker && keys.some(key => matchesHost(row, key.name)))
    const state: HostKeyInspection['state'] = conflicts.length ? 'changed'
      : entries.every(entry => entry.trusted) ? 'known'
      : entries.some(entry => entry.trusted) || anyKnown ? 'partial' : 'unknown'
    const primary = parseHostKeyEntryName(keys[0]!.name)
    return { host: primary.host, port: target.port ?? primary.port, knownHostsFile, state, entries, conflicts }
  }

  /** Append only fingerprints the user just confirmed against a fresh scan. */
  async trust(input: RemoteTarget, fingerprints: string[], env: NodeJS.ProcessEnv): Promise<HostKeyTrustResult> {
    if (!Array.isArray(fingerprints) || fingerprints.length === 0 || fingerprints.length > MAX_KEYS || !fingerprints.every(isHostKeyFingerprint)) {
      throw new Error('主机密钥指纹无效，请重新核对。')
    }
    const target = this.sshTarget(input)
    const keys = await this.learn(target, env)
    const requested = new Set(fingerprints)
    const wanted = keys.filter(key => requested.has(key.fingerprint))
    if (requested.size !== wanted.length) throw new Error('主机返回的主机密钥已经变化，请重新核对指纹后再信任。')
    const knownHostsFile = this.knownHostsPath()
    const storedText = await readIfExists(knownHostsFile)
    const stored = parseKnownHosts(storedText)
    const { conflicts } = compareWithKnown(wanted, stored)
    if (conflicts.length) {
      throw new Error(`主机密钥与 ${knownHostsFile} 中已有的记录不一致，插件不会自动替换。请核对服务器指纹，确认无误后删除该主机的旧记录再重试。`)
    }
    const lines: string[] = []
    const added: HostKeyTrustResult['added'] = []
    for (const key of wanted) {
      const present = stored.some(row => !row.marker && row.type === key.type && matchesHost(row, key.name) && row.blob.equals(key.blob))
      if (present) continue
      lines.push(`${key.name} ${key.type} ${key.blob.toString('base64')}`)
      if (!added.some(entry => entry.fingerprint === key.fingerprint)) added.push({ type: key.type, fingerprint: key.fingerprint })
    }
    if (lines.length) {
      await mkdir(dirname(knownHostsFile), { recursive: true, mode: 0o700 })
      const prefix = storedText && !storedText.endsWith('\n') ? '\n' : ''
      try {
        await appendFile(knownHostsFile, prefix + lines.join('\n') + '\n', { mode: 0o600 })
      } catch (error) {
        throw new Error(`无法写入已知主机文件 ${knownHostsFile}。`, { cause: error })
      }
    }
    return { knownHostsFile, added }
  }

  private sshTarget(input: RemoteTarget): SshTarget {
    const target = sshTargetOf(validateTarget(input))
    if (!target) throw new Error('只有 SSH 连接需要核对主机密钥。')
    return target
  }

  private async learn(target: SshTarget, env: NodeJS.ProcessEnv): Promise<LearnedKey[]> {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-hostkey-'))
    try {
      const invocation = hostKeyProbeInvocation(target, { ...this.options, probeDirectory: directory })
      const timeoutMs = this.options.connectTimeoutMs + 10_000
      const result = this.options.runProbe
        ? await this.options.runProbe(invocation, env, timeoutMs)
        : await probeProcess(invocation.executable, invocation.args, env, timeoutMs)
      let text = ''
      try { text = await readFile(join(directory, 'known_hosts'), 'utf8') } catch { /* ssh writes it only after a key exchange */ }
      const keys = parseLearnedHostKeys(text)
      if (keys.length) return keys
      if (result.timedOut) throw new Error(`读取 ${target.host} 的主机密钥超时，请检查网络、端口和 SSH 配置。`)
      const reason = lastMeaningfulLine(result.stderr)
      throw new Error(reason ? `无法获取 ${target.host} 的主机密钥：${reason}` : `无法获取 ${target.host} 的主机密钥，请检查网络、端口和 SSH 配置。`)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
}
