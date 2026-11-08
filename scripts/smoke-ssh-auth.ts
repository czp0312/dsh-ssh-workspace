/** Read the target/credentials from stdin, never argv, environment or a fixture file.
 * Does not install DSH, change sshd configuration, or write a remote project.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createConnection } from 'node:net'
import { RemoteTransport } from '../src/transport.js'
import { validateTarget } from '../src/model.js'
import type { SshCredentials, SshTarget } from '../src/types.js'

let input = ''
const stream = process.argv[2] === '--input-pipe' && process.argv[3]?.startsWith('\\\\.\\pipe\\dsh-auth-smoke-') ? createConnection(process.argv[3]) : process.stdin
for await (const chunk of stream) { input += chunk; if (input.length > 65536) throw new Error('Input too large') }
const request = JSON.parse(input) as { target: SshTarget; credentials?: SshCredentials }
input = ''
const target = validateTarget(request.target) as SshTarget
const directory = resolve('.test-artifacts')
await mkdir(directory, { recursive: true })
const host = target.port && target.port !== 22 ? `[${target.host}]:${target.port}` : target.host
const knownHostsFile = join(directory, `ssh-auth-host-${target.host}-${target.port ?? 22}.known_hosts`)
const existing = spawnSync('ssh-keygen', ['-F', host, '-f', join(homedir(), '.ssh', 'known_hosts')], { encoding: 'utf8', windowsHide: true })
const scan = existing.status === 0 ? existing : spawnSync('ssh-keyscan', ['-T', '8', '-p', String(target.port ?? 22), '-t', 'rsa,ecdsa,ed25519', target.host], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
if (scan.stdout?.split(/\r?\n/).some(line => line && !line.startsWith('#'))) await writeFile(knownHostsFile, scan.stdout, { mode: 0o600 })
else {
  // Win32 ssh-keyscan can select a KEX it does not implement. For an explicitly
  // authorized test host only, use TOFU in this isolated store with no credentials.
  const trust = spawnSync('ssh', ['-T', '-p', String(target.port ?? 22), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'PreferredAuthentications=none', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHostsFile}`, '--', `${target.user || 'test'}@${target.host}`, 'true'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  try { if (!(await readFile(knownHostsFile, 'utf8')).trim()) throw new Error() }
  catch { throw new Error('No host key available: ' + (trust.stderr || trust.error?.message || '').slice(-1024)) }
}
const fingerprints = spawnSync('ssh-keygen', ['-lf', knownHostsFile], { encoding: 'utf8', windowsHide: true }).stdout.trim()
const transport = new RemoteTransport({ knownHostsFile })
try {
  transport.setCredentials(target, request.credentials)
  const info = await transport.inspect(target)
  const browse = await transport.browse(target, info.home)
  const command = await transport.run({ ...target, remotePath: info.home }, 'printf "dsh-auth-smoke-ok"', { timeoutMs: 15000, maxOutputBytes: 4096 })
  if (command.exitCode !== 0 || command.stdout !== 'dsh-auth-smoke-ok') throw new Error('Remote command smoke check failed')
  console.log(JSON.stringify({ ok: true, auth: target.auth ?? 'auto', host: target.host, port: target.port ?? 22, user: info.user, platform: info.platform, python: info.python, homeBrowse: browse.path === info.home, commands: true, dshInstalledOrStarted: false, hostTrust: existing.status === 0 ? 'existing OpenSSH known_hosts' : 'isolated first-use test store', fingerprints }))
} catch (error) {
  let message = error instanceof Error ? error.message : String(error)
  for (const secret of Object.values(request.credentials ?? {})) if (secret) message = message.replaceAll(secret, '[redacted]')
  console.log(JSON.stringify({ ok: false, auth: target.auth, host: target.host, error: message }))
  process.exitCode = 1
} finally { request.credentials = undefined; await transport.dispose() }
