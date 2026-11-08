import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import test from 'node:test'
import { buildDockerInvocation, buildPythonInvocation, RemoteTransport, type Invocation } from '../src/transport.js'
import { targetKey, validateTarget } from '../src/model.js'
import { SshAuthBroker } from '../src/ssh-auth.js'
import type { DockerTarget, RemoteTarget } from '../src/types.js'

const docker: DockerTarget = { kind: 'docker', container: 'demo-api', context: 'dev', user: '1000:1000', remotePath: '/workspace' }
const via = { kind: 'ssh' as const, host: 'docker-host', user: 'developer', port: 2222, auth: 'password' as const, remotePath: '/' }

test('Docker identities preserve context, container case and execution user, while dropping untrusted extra fields', () => {
  assert.deepEqual(validateTarget({ ...docker, password: 'never-store', unexpected: true }), docker)
  const { context: _context, ...withoutContext } = docker
  assert.deepEqual(validateTarget({ ...docker, context: undefined, via: { ...via, password: 'never-store' } }), { ...withoutContext, via })
  for (const input of [
    { ...docker, container: '-v' }, { ...docker, container: 'demo;echo' }, { ...docker, context: '--host' },
    { ...docker, context: 'dev context' }, { ...docker, user: '-root' }, { ...docker, user: 'root\n' },
    { ...docker, via }, { ...docker, context: undefined, via: { kind: 'wsl', distribution: 'Ubuntu', remotePath: '/' } },
  ]) assert.throws(() => validateTarget(input))
  assert.notEqual(targetKey(docker), targetKey({ ...docker, context: 'prod' }))
  assert.notEqual(targetKey(docker), targetKey({ ...docker, user: 'root' }))
  assert.notEqual(targetKey(docker), targetKey({ ...docker, container: 'Demo-api' }))
  assert.notEqual(targetKey({ ...docker, context: undefined, via }), targetKey({ ...docker, context: undefined, via: { ...via, host: 'other' } }))
})

test('Docker Python and tunnel argv use exec -i without a TTY or local shell; SSH Docker retains strict authentication', () => {
  const local = buildPythonInvocation(docker, 'print("ok")', { path: '/folder with spaces' }, { dockerExecutable: 'test-docker' })
  assert.equal(local.executable, 'test-docker')
  assert.deepEqual(local.args.slice(0, 9), ['--context', 'dev', 'exec', '-i', '--user', '1000:1000', 'demo-api', 'python3', '-u'])
  assert.match(local.args.at(-2)!, /pwd.getpwuid/)
  assert.equal(local.args.includes('-t'), false)
  const remote = buildPythonInvocation({ ...docker, context: undefined, via }, 'print("ok")', {}, {}, true)
  assert.ok(remote.args.includes('StrictHostKeyChecking=yes'))
  assert.ok(remote.args.includes('PreferredAuthentications=password'))
  assert.match(remote.args.at(-1)!, /^'docker' 'exec' '-i'/)
  const list = buildDockerInvocation({ context: 'remote-context' }, ['ps', '--all', '--format', '{{json .}}'])
  assert.deepEqual(list.args, ['--context', 'remote-context', 'ps', '--all', '--format', '{{json .}}'])
})

test('Docker on SSH shares the existing in-memory password broker without persisting credentials on its target', async () => {
  const auth = new SshAuthBroker()
  try {
    const target: DockerTarget = { ...docker, context: undefined, via }
    auth.set(target, { password: 'synthetic-test-password' })
    assert.equal(auth.has(via), true)
    const env = await auth.environment(target)
    assert.equal(env.SSH_ASKPASS_REQUIRE, 'force')
    assert.equal(JSON.stringify(target).includes('synthetic-test-password'), false)
    assert.equal(JSON.stringify(env).includes('synthetic-test-password'), false)
  } finally { await auth.dispose() }
})

test('Docker discovery pins running containers to full IDs and refuses stopped containers', async () => {
  class DockerTransport extends RemoteTransport {
    calls: Invocation[] = []
    running = true
    protected override spawnProcess(invocation: Invocation): ChildProcessWithoutNullStreams {
      this.calls.push(invocation)
      const value = invocation.args.includes('inspect') ? { id: 'a'.repeat(64), running: this.running }
        : { ID: 'a'.repeat(64), Names: 'demo-api', Image: 'demo:latest', State: 'running', Status: 'Up' }
      return spawn(process.execPath, ['-e', 'console.log(process.argv[1])', JSON.stringify(value)], { stdio: 'pipe', windowsHide: true })
    }
  }
  const transport = new DockerTransport()
  try {
    const rows = await transport.listDocker({ context: 'dev' })
    assert.equal(rows[0]!.name, 'demo-api')
    assert.equal(rows[0]!.id.length, 64)
    const pinned = await transport.canonicalTarget(docker)
    assert.equal(pinned.kind === 'docker' && pinned.container, 'a'.repeat(64))
    transport.running = false
    await assert.rejects(transport.canonicalTarget(docker), /尚未运行/)
    assert.equal(transport.calls.some(row => row.args.includes('start') || row.args.includes('run')), false)
  } finally { await transport.dispose() }
})
