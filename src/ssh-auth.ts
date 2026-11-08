import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateTarget } from './model.js'
import type { RemoteTarget, SshCredentials } from './types.js'

export function validateCredentials(input: unknown): SshCredentials {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('无效的 SSH 凭据。')
  const result: SshCredentials = {}
  for (const name of ['password', 'passphrase'] as const) {
    const value = (input as Record<string, unknown>)[name]
    if (value === undefined || value === '') continue
    if (typeof value !== 'string' || value.length > 16384 || /[\0\r\n]/u.test(value)) throw new Error('SSH 密码或口令格式无效。')
    result[name] = value
  }
  return result
}

function connectionKey(input: RemoteTarget): string {
  const target = validateTarget(input)
  return target.kind !== 'ssh' ? '' : JSON.stringify([target.host.toLowerCase(), target.port ?? 22, target.user ?? '', target.auth ?? (target.identityFile ? 'key' : 'auto'), target.identityFile ?? '', target.certificateFile ?? ''])
}

/** Secrets live only here. The helper receives a random IPC capability, never a secret in argv/env/files. */
export class SshAuthBroker {
  private entries = new Map<string, { token: string; credentials: SshCredentials }>()
  private server?: Server
  private starting?: Promise<void>
  private directory?: string
  private endpoint = ''
  private sockets = new Set<Socket>()
  private disposed = false

  set(target: RemoteTarget, input: unknown): void {
    if (this.disposed) throw new Error('SSH 认证服务已关闭。')
    const key = connectionKey(target)
    const credentials = validateCredentials(input)
    if (!key || !Object.keys(credentials).length) return
    if (target.kind === 'ssh' && (target.auth === 'key' || target.auth === 'certificate') && credentials.password) throw new Error('密钥和证书方式不使用登录密码。')
    if (target.kind === 'ssh' && target.auth === 'password' && credentials.passphrase) throw new Error('仅密码方式不使用私钥口令。')
    this.entries.set(key, { token: this.entries.get(key)?.token ?? randomBytes(32).toString('hex'), credentials })
  }

  has(target: RemoteTarget): boolean { return this.entries.has(connectionKey(target)) }

  async environment(target: RemoteTarget): Promise<NodeJS.ProcessEnv> {
    if (this.disposed) throw new Error('SSH 认证服务已关闭。')
    const entry = this.entries.get(connectionKey(target))
    if (!entry) {
      if (target.kind === 'ssh' && target.auth === 'password') throw new Error('请重新输入 SSH 密码；密码仅保留在当前进程内，重启后不会保存。')
      return { SSH_ASKPASS_REQUIRE: 'never' }
    }
    await (this.starting ??= this.start())
    return {
      SSH_ASKPASS: fileURLToPath(new URL(process.platform === 'win32' ? '../lib/ssh-askpass.exe' : '../lib/ssh-askpass.cjs', import.meta.url)),
      SSH_ASKPASS_REQUIRE: 'force', DISPLAY: 'dsh-ssh:0',
      DSH_SSH_ASKPASS_PIPE: this.endpoint, DSH_SSH_ASKPASS_TOKEN: entry.token,
    }
  }

  private async start(): Promise<void> {
    if (process.platform === 'win32') this.endpoint = `\\\\.\\pipe\\dsh-ssh-${process.pid}-${randomBytes(16).toString('hex')}`
    else { this.directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-auth-')); await chmod(this.directory, 0o700); this.endpoint = join(this.directory, 'askpass.sock') }
    this.server = createServer(socket => {
      this.sockets.add(socket)
      socket.setTimeout(5000, () => socket.destroy())
      socket.on('error', () => {})
      socket.once('close', () => this.sockets.delete(socket))
      let data = ''
      socket.on('data', chunk => {
        data += chunk.toString('utf8')
        if (data.length > 32768) { socket.destroy(); return }
        const lines = data.split('\n').map(line => line.replace(/\r$/, ''))
        if (lines.length < 3) return
        const entry = [...this.entries.values()].find(item => item.token === lines[0])
        const prompt = Buffer.from(lines[1]!, 'base64').toString('utf8')
        // Never answer host-trust prompts, OTP, security-key touch/PIN or password-change prompts.
        const secret = !entry ? undefined : /(?:enter )?passphrase for (?:key|private key)\b/i.test(prompt)
          ? entry.credentials.passphrase : /(?:^password:\s*$|(?:'s|\))\s*password:\s*$)/i.test(prompt) ? entry.credentials.password : undefined
        socket.end(secret === undefined ? 'ERROR\n' : `OK\n${Buffer.from(secret, 'utf8').toString('base64')}\n`)
      })
    })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(this.endpoint, resolve) })
    this.server.unref()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.starting?.catch(() => {})
    this.entries.clear()
    for (const socket of this.sockets) socket.destroy()
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()))
    if (this.directory) await rm(this.directory, { recursive: true, force: true })
  }
}
