import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { SshAuthBroker, validateCredentials } from '../src/ssh-auth.js'
import { buildPythonInvocation, transportEnvironment, RemoteTransport } from '../src/transport.js'
import { validateTarget } from '../src/model.js'
import type { SshTarget } from '../src/types.js'

const target: SshTarget = { kind: 'ssh', host: 'test.example', user: 'test', port: 2222, remotePath: '/', auth: 'password' }
async function answer(env: NodeJS.ProcessEnv, prompt: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = process.platform === 'win32' ? spawn(env.SSH_ASKPASS!, [prompt], { env: { ...transportEnvironment(), ...env }, windowsHide: true })
    : spawn(process.execPath, [fileURLToPath(new URL('../lib/ssh-askpass.cjs', import.meta.url)), prompt], { env: { ...transportEnvironment(), ...env } })
  let stdout = '', stderr = ''
  child.stdout!.on('data', data => { stdout += data }); child.stderr!.on('data', data => { stderr += data })
  const [code] = await once(child, 'close')
  return { code, stdout, stderr }
}

test('passwords/passphrases travel through the actual askpass executable without appearing in its environment', async () => {
  const broker = new SshAuthBroker()
  try {
    broker.set(target, { password: '  synthetic password 密码  ' })
    const env = await broker.environment(target)
    assert.equal(JSON.stringify(env).includes('synthetic password'), false)
    const reply = await answer(env, "test@test.example's password: ")
    assert.equal(reply.code, 0); assert.equal(reply.stdout.trimEnd(), '  synthetic password 密码'); assert.equal(reply.stderr, '')
    broker.set(target, { password: 'replacement-secret' })
    assert.equal((await answer(env, "test@test.example's password: ")).stdout.trim(), 'replacement-secret', 'existing tunnel capabilities survive a credential update')
    const keyed: SshTarget = { ...target, auth: 'key', identityFile: process.platform === 'win32' ? 'C:\\Keys\\test.key' : '/keys/test.key' }
    broker.set(keyed, { passphrase: 'synthetic-phrase' })
    const keyEnv = await broker.environment(keyed)
    assert.equal((await answer(keyEnv, "Enter passphrase for key 'test.key': ")).stdout.trim(), 'synthetic-phrase')
    for (const prompt of ['Are you sure you want to continue connecting (yes/no)?', 'Enter PIN for authenticator:', 'Verification code:', 'New password:']) {
      const rejected = await answer(env, prompt)
      assert.notEqual(rejected.code, 0); assert.equal(rejected.stdout, '')
    }
    const rejected = await answer({ ...env, DSH_SSH_ASKPASS_TOKEN: 'invalid' }, "test@test.example's password: ")
    assert.notEqual(rejected.code, 0); assert.equal(rejected.stdout, '')
    // A partially written/oversized request cannot retain a socket indefinitely.
    const client = createConnection(env.DSH_SSH_ASKPASS_PIPE!)
    client.on('error', () => {}); await once(client, 'connect'); client.write('x'.repeat(33000)); await once(client, 'close')
  } finally { await broker.dispose() }
  await assert.rejects(broker.environment(target), /已关闭/)
})

test('credentials reject control characters and remain isolated by authentication identity', async () => {
  for (const invalid of [null, 'password', { password: 5 }, { passphrase: 'bad\nline' }, { password: '\0' }]) assert.throws(() => validateCredentials(invalid))
  assert.deepEqual(validateCredentials({ password: ' spaces ', arbitrary: 'not retained' }), { password: ' spaces ' })
  const transport = new RemoteTransport()
  try {
    await assert.rejects(transport.pythonInvocation(target, 'pass', {}), /重新输入 SSH 密码/)
    transport.setCredentials(target, { password: 'not-an-argument' })
    const invocation = await transport.pythonInvocation(target, 'pass', {})
    assert.ok(invocation.args.includes('BatchMode=no'))
    assert.equal(JSON.stringify(invocation).includes('not-an-argument'), false)
    await assert.rejects(transport.pythonInvocation({ ...target, user: 'another' }, 'pass', {}), /重新输入 SSH 密码/)
  } finally { await transport.dispose() }
})

test('password, key, certificate and automatic modes produce distinct OpenSSH authentication constraints', () => {
  const password = buildPythonInvocation(target, 'pass', {}, {}, true)
  for (const option of ['PreferredAuthentications=password', 'PubkeyAuthentication=no', 'KbdInteractiveAuthentication=no']) assert.ok(password.args.includes(option))
  const identityFile = process.platform === 'win32' ? 'C:\\Keys with spaces\\test.key' : '/keys with spaces/test.key'
  const certificateFile = identityFile + '-cert.pub'
  const cert: SshTarget = { ...target, auth: 'certificate', identityFile, certificateFile }
  const certificate = buildPythonInvocation(cert, 'pass', {})
  assert.ok(certificate.args.includes(`CertificateFile=${certificateFile}`))
  assert.ok(certificate.args.includes('PreferredAuthentications=publickey'))
  assert.ok(certificate.args.includes('PasswordAuthentication=no'))
  assert.equal(certificate.args.at(-1)!.includes(identityFile), false)
  assert.throws(() => validateTarget({ ...target, identityFile }), /仅密码/)
  assert.throws(() => validateTarget({ ...cert, certificateFile: undefined }), /证书/)
  assert.throws(() => validateTarget({ ...cert, auth: 'key' }), /证书文件只能/)
  const parsed = validateTarget({ ...target, password: 'must not persist', credentials: { password: 'must not persist' } })
  assert.equal(JSON.stringify(parsed).includes('must not persist'), false)
})
