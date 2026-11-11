import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { classifyHostKeyFailure } from '../src/host-key.js'
import {
  decodeHostKeyBlob, fingerprintOf, hostKeyEntryName, hostKeyProbeInvocation, HostKeys, hostPatternMatches,
  matchesHost, parseHostKeyEntryName, parseKnownHosts, parseLearnedHostKeys,
} from '../src/host-keys.js'
import type { RemoteTarget, SshTarget } from '../src/types.js'

/** A structurally valid SSH key blob: type length, type name, key material. */
function blob(type: string, fill: number): string {
  const name = Buffer.from(type, 'latin1')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(name.length)
  return Buffer.concat([header, name, Buffer.alloc(32, fill)]).toString('base64')
}

const ED = (fill: number) => blob('ssh-ed25519', fill)
const RSA = (fill: number) => blob('ssh-rsa', fill)

const ssh: SshTarget = { kind: 'ssh', host: 'example.test', user: 'alice', port: 2222, remotePath: '/srv/app' }

interface ScanKey { name: string; type: string; blob: string }

async function fixture(t: TestContext, scan: ScanKey[], options: { knownHostsFile?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-hostkeys-'))
  const knownHostsFile = options.knownHostsFile ?? join(directory, 'known_hosts')
  let keys = scan
  let ranProbe = 0
  const hostKeys = new HostKeys({
    sshExecutable: 'ssh-does-not-run',
    knownHostsFile,
    connectTimeoutMs: 1_000,
    runProbe: async invocation => {
      ranProbe++
      const file = invocation.args.find(argument => argument.startsWith('UserKnownHostsFile='))!.slice('UserKnownHostsFile='.length)
      if (keys.length) await writeFile(file, keys.map(key => `${key.name} ${key.type} ${key.blob}`).join('\n') + '\n')
      return { stderr: 'alice@example.test: Permission denied (publickey).', timedOut: false }
    },
  })
  t.after(() => rm(directory, { recursive: true, force: true }))
  return {
    directory, knownHostsFile, hostKeys,
    probes: () => ranProbe,
    setScan: (next: ScanKey[]) => { keys = next },
  }
}

const store = (...lines: string[]) => lines.join('\n') + '\n'

test('host-key failures are classified without matching unrelated SSH errors', () => {
  assert.equal(classifyHostKeyFailure('No ED25519 host key is known for 189.24.90.115 and you have requested strict checking. Host key verification failed.'), 'unknown')
  assert.equal(classifyHostKeyFailure('Host key verification failed.'), 'unknown')
  assert.equal(classifyHostKeyFailure('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!'), 'changed')
  assert.equal(classifyHostKeyFailure('Host key for example.test has changed'), 'changed')
  assert.equal(classifyHostKeyFailure('Permission denied (publickey).'), undefined)
  assert.equal(classifyHostKeyFailure('no such identity: /keys/dev'), undefined)
  assert.equal(classifyHostKeyFailure(''), undefined)
  assert.equal(classifyHostKeyFailure(undefined), undefined)
})

test('key blobs are re-typed locally and fingerprint exactly like OpenSSH', async t => {
  const decoded = decodeHostKeyBlob(ED(1))
  assert.equal(decoded?.type, 'ssh-ed25519')
  assert.match(fingerprintOf(decoded!.blob), /^SHA256:[A-Za-z0-9+/]{43}$/)
  assert.equal(decodeHostKeyBlob(blob('ssh-unknown-type', 1)), undefined)
  assert.equal(decodeHostKeyBlob('ssh-ed25519'), undefined)
  assert.equal(decodeHostKeyBlob('!!!not-base64!!!'), undefined)
  assert.equal(decodeHostKeyBlob(''), undefined)

  // Cross-check against the OpenSSH tools this plugin invokes when they exist.
  const probe = spawnSync('ssh-keygen', ['-?'], { windowsHide: true })
  if (probe.error) return
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ssh-keygen-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const keyFile = join(directory, 'id_ed25519')
  if (spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyFile], { windowsHide: true }).status !== 0) return
  const published = (await readFile(`${keyFile}.pub`, 'utf8')).trim().split(/\s+/)
  const listed = spawnSync('ssh-keygen', ['-lf', `${keyFile}.pub`], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\s+/)
  const real = decodeHostKeyBlob(published[1]!)
  assert.equal(real?.type, 'ssh-ed25519')
  assert.equal(fingerprintOf(real!.blob), listed[1])
})

test('known-hosts parsing handles patterns, hashed entries, markers and junk', () => {
  const rows = parseKnownHosts(store(
    '# comment',
    '',
    `example.test ${'ssh-ed25519'} ${ED(1)}`,
    `*.example.test ssh-rsa ${RSA(2)}`,
    `!bad.example.test ssh-rsa ${RSA(3)}`,
    `@revoked example.test ssh-ed25519 ${ED(4)}`,
    `@cert-authority *.example.test ssh-ed25519 ${ED(5)}`,
    'garbage line',
    `example.test ssh-ed25519 ${blob('ssh-ed25519x', 6)}`,
  ))
  assert.equal(rows.length, 5)
  const plain = rows[0]!
  assert.ok(matchesHost(plain, 'example.test'))
  assert.ok(!matchesHost(plain, 'other.test'))
  assert.ok(matchesHost(rows[1]!, 'deep.example.test'))
  assert.ok(!matchesHost(rows[2]!, 'bad.example.test'))
  assert.equal(rows[3]!.marker, '@revoked')
  assert.equal(rows[4]!.marker, '@cert-authority')
  assert.ok(hostPatternMatches('Example.Test', 'example.test'), 'host names compare case-insensitively')
  assert.ok(hostPatternMatches('host?', 'host1'))
  assert.ok(!hostPatternMatches('[a].example', 'a.example'), 'patterns are literal, never regular expressions')

  const salt = Buffer.from('a fixed salt')
  const hashed = createHmac('sha1', salt).update('example.test').digest('base64')
  const hashedStore = parseKnownHosts(`|1|${salt.toString('base64')}|${hashed} ssh-ed25519 ${ED(7)}\n`)
  assert.equal(hashedStore.length, 1)
  assert.ok(matchesHost(hashedStore[0]!, 'example.test'))
  assert.ok(!matchesHost(hashedStore[0]!, 'other.test'))
})

test('learned host keys are validated, deduplicated and bounded', () => {
  const rows = parseLearnedHostKeys(store(
    `example.test ssh-ed25519 ${ED(1)}`,
    `[example.test]:2222 ssh-ed25519 ${ED(1)}`,
    `example.test ssh-rsa ${RSA(2)}`,
    `bad name ssh-ed25519 ${ED(3)}`,
    `-oProxyCommand=bogus ssh-ed25519 ${ED(4)}`,
    `|1|a|b ssh-ed25519 ${ED(5)}`,
    `example.test ssh-ed25519 ${blob('not-a-key', 6)}`,
    ...Array.from({ length: 20 }, (_, index) => `many.test ssh-ed25519 ${blob('ssh-ed25519', 40 + index)}`),
  ))
  assert.equal(rows.length, 16)
  assert.deepEqual(rows.slice(0, 2).map(row => row.name), ['example.test', '[example.test]:2222'])
  assert.equal(new Set(rows.map(row => `${row.name}\u0000${row.type}\u0000${row.fingerprint}`)).size, rows.length)
})

test('known-hosts entry names round-trip for default, custom and IPv6 ports', () => {
  assert.equal(hostKeyEntryName('example.test', 22), 'example.test')
  assert.equal(hostKeyEntryName('example.test', 2222), '[example.test]:2222')
  assert.equal(hostKeyEntryName('[2001:db8::1]', 22), '2001:db8::1')
  assert.equal(hostKeyEntryName('[2001:db8::1]', 2200), '[2001:db8::1]:2200')
  for (const [name, expected] of [['example.test', { host: 'example.test', port: 22 }], ['[example.test]:2222', { host: 'example.test', port: 2222 }], ['2001:db8::1', { host: '2001:db8::1', port: 22 }]] as const) {
    assert.deepEqual(parseHostKeyEntryName(name), expected)
  }
})

test('the host-key probe isolates trust, uses the user ssh configuration and never prompts', () => {
  const directory = join(tmpdir(), 'dsh-ssh-probe-directory')
  const invocation = hostKeyProbeInvocation(ssh, { sshExecutable: 'ssh.exe', connectTimeoutMs: 5_500, probeDirectory: directory })
  assert.equal(invocation.executable, 'ssh.exe')
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=accept-new', 'NumberOfPasswordPrompts=0', 'PreferredAuthentications=none', 'PasswordAuthentication=no', 'PubkeyAuthentication=no', 'ForwardAgent=no', 'ForwardX11=no', 'ClearAllForwardings=yes', 'HashKnownHosts=no', 'ConnectTimeout=6']) {
    assert.ok(invocation.args.includes(option), option)
  }
  assert.ok(invocation.args.includes(`UserKnownHostsFile=${join(directory, 'known_hosts')}`))
  assert.ok(invocation.args.includes(`GlobalKnownHostsFile=${join(directory, 'no-global-known-hosts')}`))
  assert.equal(invocation.args.some(argument => argument === 'StrictHostKeyChecking=no'), false)
  assert.equal(invocation.args.at(-2), '--')
  assert.equal(invocation.args.at(-1), 'example.test')
  assert.equal(invocation.args[invocation.args.indexOf('-p') + 1], '2222')
  assert.equal(invocation.args[invocation.args.indexOf('-l') + 1], 'alice')

  const ipv6 = hostKeyProbeInvocation({ ...ssh, host: '[2001:db8::1]', port: undefined, user: undefined }, { sshExecutable: 'ssh', connectTimeoutMs: 1_000, probeDirectory: directory })
  assert.equal(ipv6.args.at(-1), '2001:db8::1')
  assert.equal(ipv6.args.includes('-p'), false)
  assert.equal(ipv6.args.includes('-l'), false)
})

test('inspection reports unknown, partial, known and changed without touching the store', async t => {
  const first = ED(1)
  const { hostKeys, knownHostsFile } = await fixture(t, [{ name: 'example.test', type: 'ssh-ed25519', blob: first }])
  const unknown = await hostKeys.inspect(ssh, {})
  assert.equal(unknown.state, 'unknown')
  assert.equal(unknown.host, 'example.test')
  assert.equal(unknown.port, 2222)
  assert.equal(unknown.entries.length, 1)
  assert.deepEqual(unknown.entries[0], { type: 'ssh-ed25519', fingerprint: fingerprintOf(Buffer.from(first, 'base64')), trusted: false })
  assert.deepEqual(unknown.conflicts, [])
  assert.equal(unknown.knownHostsFile, knownHostsFile)

  await writeFile(knownHostsFile, store(`example.test ssh-ed25519 ${first}`))
  assert.equal((await hostKeys.inspect(ssh, {})).state, 'known')

  await writeFile(knownHostsFile, store(`example.test ssh-rsa ${RSA(2)}`))
  const partial = await hostKeys.inspect(ssh, {})
  assert.equal(partial.state, 'partial')
  assert.equal(partial.entries[0]!.trusted, false)

  await writeFile(knownHostsFile, store(`example.test ssh-ed25519 ${ED(9)}`))
  const changed = await hostKeys.inspect(ssh, {})
  assert.equal(changed.state, 'changed')
  assert.deepEqual(changed.conflicts, [{ type: 'ssh-ed25519', fingerprint: fingerprintOf(Buffer.from(first, 'base64')), existing: fingerprintOf(Buffer.from(ED(9), 'base64')) }])
  assert.equal(await readFile(knownHostsFile, 'utf8'), store(`example.test ssh-ed25519 ${ED(9)}`), 'inspection never rewrites the store')
})

test('trust appends confirmed fingerprints once and keeps existing records', async t => {
  const first = ED(1)
  const fingerprint = fingerprintOf(Buffer.from(first, 'base64'))
  const { hostKeys, knownHostsFile } = await fixture(t, [{ name: 'example.test', type: 'ssh-ed25519', blob: first }])

  const trusted = await hostKeys.trust(ssh, [fingerprint], {})
  assert.deepEqual(trusted.added, [{ type: 'ssh-ed25519', fingerprint }])
  assert.equal(await readFile(knownHostsFile, 'utf8'), store(`example.test ssh-ed25519 ${first}`))
  assert.equal((await hostKeys.inspect(ssh, {})).state, 'known')

  const again = await hostKeys.trust(ssh, [fingerprint], {})
  assert.deepEqual(again.added, [])
  assert.equal(await readFile(knownHostsFile, 'utf8'), store(`example.test ssh-ed25519 ${first}`), 'trusting twice never duplicates the line')

  await writeFile(knownHostsFile, `unrelated.test ssh-rsa ${RSA(3)}`)
  const appended = await hostKeys.trust(ssh, [fingerprint], {})
  assert.deepEqual(appended.added, [{ type: 'ssh-ed25519', fingerprint }])
  assert.equal(await readFile(knownHostsFile, 'utf8'), `unrelated.test ssh-rsa ${RSA(3)}\n` + `example.test ssh-ed25519 ${first}\n`)
})

test('trust never replaces a changed or revoked record and rejects stale fingerprints', async t => {
  const first = ED(1)
  const fingerprint = fingerprintOf(Buffer.from(first, 'base64'))
  const { hostKeys, knownHostsFile, setScan } = await fixture(t, [{ name: 'example.test', type: 'ssh-ed25519', blob: first }])

  await writeFile(knownHostsFile, store(`example.test ssh-ed25519 ${ED(9)}`))
  await assert.rejects(hostKeys.trust(ssh, [fingerprint], {}), /不一致/)
  assert.equal(await readFile(knownHostsFile, 'utf8'), store(`example.test ssh-ed25519 ${ED(9)}`))

  await writeFile(knownHostsFile, store(`@revoked example.test ssh-ed25519 ${first}`))
  await assert.rejects(hostKeys.trust(ssh, [fingerprint], {}), /不一致/)

  await writeFile(knownHostsFile, '')
  setScan([{ name: 'example.test', type: 'ssh-ed25519', blob: ED(7) }])
  await assert.rejects(hostKeys.trust(ssh, [fingerprint], {}), /已经变化/)
  assert.equal(await readFile(knownHostsFile, 'utf8'), '')

  for (const invalid of [[], ['not-a-fingerprint'], [fingerprint, 'SHA256:short'], Array.from({ length: 17 }, () => fingerprint)]) {
    await assert.rejects(hostKeys.trust(ssh, invalid as string[], {}))
  }
})

test('only SSH-backed targets can be inspected and host resolution failures are explained', async t => {
  const { hostKeys, setScan } = await fixture(t, [{ name: 'example.test', type: 'ssh-ed25519', blob: ED(1) }])
  await assert.rejects(hostKeys.inspect({ kind: 'wsl', distribution: 'Ubuntu', remotePath: '/' }, {}), /只有 SSH/)
  await assert.rejects(hostKeys.inspect({ kind: 'docker', container: 'a'.repeat(64), remotePath: '/' }, {}), /只有 SSH/)

  const dockerVia: RemoteTarget = { kind: 'docker', container: 'b'.repeat(64), via: ssh, remotePath: '/' }
  assert.equal((await hostKeys.inspect(dockerVia, {})).host, 'example.test')

  setScan([])
  const unreachable = await fixture(t, [])
  await assert.rejects(unreachable.hostKeys.inspect(ssh, {}))

  const failing = new HostKeys({
    sshExecutable: 'ssh', knownHostsFile: join(unreachable.directory, 'known_hosts'), connectTimeoutMs: 1_000,
    runProbe: async () => ({ stderr: 'ssh: Could not resolve hostname example.test: Name or service not known', timedOut: false }),
  })
  await assert.rejects(failing.inspect(ssh, {}), /无法获取 example.test 的主机密钥：ssh: Could not resolve hostname/)

  const slow = new HostKeys({
    sshExecutable: 'ssh', knownHostsFile: join(unreachable.directory, 'known_hosts'), connectTimeoutMs: 1_000,
    runProbe: async () => ({ stderr: '', timedOut: true }),
  })
  await assert.rejects(slow.inspect(ssh, {}), /超时/)
})
