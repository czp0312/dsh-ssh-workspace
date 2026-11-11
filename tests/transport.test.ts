import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { REMOTE_HELPER, type HelperRequest } from '../src/remote-helper.js'
import { buildInvocation, buildPythonInvocation, decodeWslList, quotePosix, RemoteTransport, transportEnvironment, validateIdentityFile, type Invocation } from '../src/transport.js'
import type { RemoteTarget } from '../src/types.js'

const target: RemoteTarget = { kind: 'wsl', distribution: 'Test Linux', remotePath: '/test-work' }
const ssh: RemoteTarget = { kind: 'ssh', host: 'dev-alias', user: 'alice', port: 2222, remotePath: '/srv/repo' }

// Prefer installed WSL Python on Windows so the actual POSIX process-group path is
// exercised. No server, installation, user profile edits, or .dsh writes are used.
function findPython() {
  const env = transportEnvironment()
  if (process.platform === 'win32') {
    const listed = spawnSync('wsl.exe', ['--list', '--quiet'], { env, windowsHide: true, timeout: 8000 })
    if (listed.status === 0) {
      for (const distro of decodeWslList(listed.stdout).slice(0, 4)) {
        const prefix = ['--distribution', distro, '--exec', 'python3']
        if (spawnSync('wsl.exe', [...prefix, '-c', 'import sys;sys.exit(0)'], { env, windowsHide: true, timeout: 8000 }).status === 0) {
          return { executable: 'wsl.exe', prefix, pythonCommand: 'python3', wsl: true, env }
        }
      }
    }
  }
  for (const executable of [process.env.DSH_SSH_TEST_PYTHON, 'python3', 'python'].filter((value): value is string => !!value)) {
    const result = spawnSync(executable, ['-c', 'import sys;print(sys.executable)'], { env, windowsHide: true, timeout: 3000 })
    if (result.status === 0) {
      if (process.platform === 'win32') {
        // Python needs a real Bash for the foreground runner, not the obsolete
        // Windows bash.exe WSL launcher. Use Git's already-installed Bash if present.
        const git = spawnSync('where.exe', ['git.exe'], { env, windowsHide: true }).stdout?.toString().split(/\r?\n/)[0]
        if (git) {
          const bashDir = join(git, '..', '..', 'bin')
          if (existsSync(join(bashDir, 'bash.exe'))) env.PATH = `${bashDir};${env.PATH ?? env.Path ?? ''}`
        }
      }
      return { executable, prefix: [] as string[], pythonCommand: result.stdout.toString().trim().replaceAll('\\', '/'), wsl: false, env }
    }
  }
  throw new Error('Transport tests require an existing Python 3 executable (or installed WSL Python)')
}

const python = findPython()
const remote = (path: string) => python.wsl ? '/mnt/' + path[0]!.toLowerCase() + path.slice(2).replaceAll('\\', '/') : path
function pythonSync(code: string, args: string[] = []): string {
  const result = spawnSync(python.executable, [...python.prefix, '-c', code, ...args], {
    env: python.env, windowsHide: true, timeout: 8000, encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.error?.message)
  return result.stdout.trim()
}
const command = (code: string) => `${quotePosix(python.pythonCommand)} -u -c ${quotePosix(code)}`

class LocalTransport extends RemoteTransport {
  calls: { invocation: Invocation; request?: HelperRequest }[] = []
  onData?: (data: string, request?: HelperRequest) => void
  sourcePrefix = ''
  holdProbeResponse = false
  rawResponse?: string
  constructor(readonly root: string) { super() }
  protected override spawnProcess(invocation: Invocation): ChildProcessWithoutNullStreams {
    let source: string
    let request: HelperRequest | undefined
    const args: string[] = []
    if (invocation.args[0] === '--list') {
      source = 'import sys;sys.stdout.buffer.write("Ubuntu-22.04\\r\\nDebian\\r\\n".encode("utf-16le"))'
    } else if (this.rawResponse !== undefined) {
      source = this.rawResponse.length > 8192
        ? `import sys;sys.stdout.write("x"*${this.rawResponse.length})`
        : `import sys;sys.stdout.write(${JSON.stringify(this.rawResponse)})`
    } else {
      request = JSON.parse(Buffer.from(invocation.args.at(-1)!, 'base64').toString()) as HelperRequest
      const rewrite = (path: string) => path.startsWith('/test-work') ? remote(this.root) + path.slice('/test-work'.length) : path
      if ('cwd' in request) request.cwd = rewrite(request.cwd)
      if ('path' in request) request.path = rewrite(request.path)
      source = this.sourcePrefix + REMOTE_HELPER
      if (this.holdProbeResponse && request.op === 'probe-create') {
        source = `import time\ntry:\n exec(${JSON.stringify(source)})\nexcept SystemExit as status:\n if status.code == 0: time.sleep(10)\n raise\n`
      }
      args.push(Buffer.from(JSON.stringify(request)).toString('base64'))
    }
    this.calls.push({ invocation, request })
    const child = spawn(python.executable, [...python.prefix, '-u', '-c', source, ...args], {
      shell: false, windowsHide: true, stdio: 'pipe', env: python.env,
    })
    child.stdout.on('data', (data: Buffer) => this.onData?.(data.toString(), request))
    return child
  }
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ssh-transport-'))
  const transport = new LocalTransport(root)
  t.after(async () => { await transport.dispose(); await rm(root, { recursive: true, force: true }) })
  return { root, transport }
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await delay(25)
  }
  throw new Error('Test fixture did not become ready')
}

function assertDead(pid: number): void {
  const state = pythonSync(String.raw`
import os, sys, time
pid = int(sys.argv[1])
def alive():
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        k = ctypes.WinDLL("kernel32")
        k.OpenProcess.restype = wintypes.HANDLE
        k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = k.OpenProcess(0x1000, False, pid)
        if not handle: return False
        code = wintypes.DWORD()
        k.GetExitCodeProcess(handle, ctypes.byref(code))
        k.CloseHandle(handle)
        return code.value == 259
    try:
        with open("/proc/%d/stat" % pid) as stream:
            return stream.read().split(") ", 1)[1][0] not in ("Z", "X")
    except FileNotFoundError:
        return False
until = time.monotonic() + 2
while alive() and time.monotonic() < until: time.sleep(0.02)
print("alive" if alive() else "dead")
`, [String(pid)])
  assert.equal(state, 'dead', `descendant ${pid} must be terminated`)
}

test('SSH invocation quotes every remote argument and enables noninteractive host verification', () => {
  const request: HelperRequest = { op: 'run', cwd: "/space/引号'$(touch no)", command: "printf '%s' \"$HOME\"\nexit 7", timeoutMs: 1000, leaseMs: 5000 }
  const invocation = buildInvocation(ssh, request, { connectTimeoutMs: 1501, pythonExecutable: "/opt/py'thon $(no)" })
  assert.equal(invocation.executable, process.platform === 'win32' ? 'ssh.exe' : 'ssh')
  for (const option of ['BatchMode=yes', 'StrictHostKeyChecking=yes', 'ConnectTimeout=2', 'ServerAliveInterval=5', 'ForwardAgent=no', 'NumberOfPasswordPrompts=0']) {
    assert.ok(invocation.args.includes(option), option)
  }
  assert.ok(invocation.args.includes('-T'))
  const parsed = JSON.parse(pythonSync('import json,shlex,sys;print(json.dumps(shlex.split(sys.argv[1])))', [invocation.args.at(-1)!])) as string[]
  assert.deepEqual(parsed.slice(0, 4), ["/opt/py'thon $(no)", '-u', '-c', REMOTE_HELPER])
  assert.deepEqual(JSON.parse(Buffer.from(parsed[4]!, 'base64').toString()), request)
  assert.equal(quotePosix("a'b"), "'a'\"'\"'b'")
  assert.throws(() => quotePosix('a\0b'))
  assert.equal(invocation.args.at(-2), ssh.host)
})

test('WSL invocation passes distro, user, Python, and JSON as separate argv entries', () => {
  const request: HelperRequest = { op: 'inspect', path: '/a b/中文' }
  const invocation = buildInvocation({ ...target, user: 'root' }, request)
  assert.deepEqual(invocation.args.slice(0, 8), ['--distribution', 'Test Linux', '--user', 'root', '--exec', 'python3', '-u', '-c'])
  assert.equal(invocation.args[8], REMOTE_HELPER)
  assert.deepEqual(JSON.parse(Buffer.from(invocation.args[9]!, 'base64').toString()), request)
})

test('explicit SSH keys are separate local argv entries for both helper and backend tunnels', () => {
  const identityFile = join(process.cwd(), "keys with spaces", "dev'$(no).pem")
  const keyed = { ...ssh, identityFile }
  for (const invocation of [buildInvocation(keyed, { op: 'inspect', path: '/srv/repo' }), buildPythonInvocation(keyed, 'pass', { port: 12345 })]) {
    assert.equal(invocation.args[invocation.args.indexOf('-i') + 1], identityFile)
    assert.ok(invocation.args.includes('IdentitiesOnly=yes'))
    assert.ok(invocation.args.includes('PreferredAuthentications=publickey'))
    assert.ok(invocation.args.includes('BatchMode=yes'))
    assert.equal(invocation.args.at(-1)!.includes(identityFile), false, 'local key path must not enter the remote command')
  }
  const automatic = buildInvocation(ssh, { op: 'inspect', path: '/srv/repo' })
  assert.equal(automatic.args.includes('-i'), false)
  assert.equal(automatic.args.includes('IdentitiesOnly=yes'), false)
})

test('explicit SSH key metadata is checked before any process launches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-key-path-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const key = join(root, 'generated-test-placeholder')
  await writeFile(key, 'Not a real private key. Metadata-only test.', { mode: 0o600 })
  await validateIdentityFile({ ...ssh, identityFile: key })
  await assert.rejects(validateIdentityFile({ ...ssh, identityFile: root }), /不是文件|不可读/)
  const { transport } = await fixture(t)
  const missing = { ...ssh, identityFile: join(root, 'missing') }
  await assert.rejects(transport.inspect(missing), /私钥文件不存在/)
  await assert.rejects(transport.python(missing, 'pass', {}), /私钥文件不存在/)
  await assert.rejects(transport.run(missing, 'true'), /私钥文件不存在/)
  assert.equal(transport.calls.length, 0)
})

test('WSL list decoding handles UTF-16LE with/without BOM, UTF-8, blank lines, and duplicate rows', () => {
  const rows = 'Ubuntu-22.04\r\n 测试 Linux \r\n\r\nUbuntu-22.04\r\n'
  for (const buffer of [Buffer.from(rows, 'utf16le'), Buffer.from('\uFEFF' + rows, 'utf16le'), Buffer.from(rows)]) {
    assert.deepEqual(decodeWslList(buffer), ['Ubuntu-22.04', '测试 Linux'])
  }
  assert.deepEqual(decodeWslList(Buffer.alloc(0)), [])
})

test('transport environment retains OS paths/SSH agent and excludes application secrets and WSLENV', () => {
  assert.deepEqual(transportEnvironment({
    PATH: '/bin', HOME: '/home/test', SSH_AUTH_SOCK: '/tmp/agent', SystemRoot: 'C:\\Windows', LANG: 'C.UTF-8',
    OPENAI_API_KEY: 'secret', AWS_SESSION_TOKEN: 'secret', password: 'secret', dsh_endpoint: 'secret',
    DSH_API_KEY: 'secret', WSLENV: 'OPENAI_API_KEY/u:DSH_API_KEY', NODE_OPTIONS: '--require unsafe',
    LC_SECRET: 'secret', RANDOM_VARIABLE: 'not needed',
  }), { PATH: '/bin', HOME: '/home/test', SSH_AUTH_SOCK: '/tmp/agent', SystemRoot: 'C:\\Windows', LANG: 'C.UTF-8' })
})

test('the actual no-shell spawn passes the scrubbed environment to its executable', async () => {
  class EnvironmentTransport extends RemoteTransport {
    protected override spawnProcess(_invocation: Invocation): ChildProcessWithoutNullStreams {
      return super.spawnProcess({ executable: process.execPath, args: ['-e',
        'process.stdout.write(JSON.stringify({secret:process.env.SERVICE_TOKEN,dsh:process.env.DSH_TRANSPORT_TEST,wslenv:process.env.WSLENV,path:process.env.PATH,home:process.env.HOME}))',
      ] })
    }
  }
  const original = { SERVICE_TOKEN: process.env.SERVICE_TOKEN, DSH_TRANSPORT_TEST: process.env.DSH_TRANSPORT_TEST, WSLENV: process.env.WSLENV }
  process.env.SERVICE_TOKEN = 'test-only-secret'
  process.env.DSH_TRANSPORT_TEST = 'test-only-dsh-state'
  process.env.WSLENV = 'SERVICE_TOKEN/u:DSH_TRANSPORT_TEST'
  const transport = new EnvironmentTransport()
  try {
    const result = await transport.run(target, 'unused by the mock executable')
    assert.equal(result.exitCode, 0)
    const value = JSON.parse(result.stdout) as Record<string, unknown>
    assert.equal(value.secret, undefined)
    assert.equal(value.dsh, undefined)
    assert.equal(value.wslenv, undefined)
    assert.equal(value.path, process.env.PATH)
    assert.equal(value.home, process.env.HOME)
  } finally {
    await transport.dispose()
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  }
})

test('invalid identities/options are rejected before spawning, and a pre-aborted run is never replayed', async t => {
  const { transport } = await fixture(t)
  for (const bad of [{ ...ssh, host: '-oProxyCommand=bad' }, { ...ssh, port: 0 }, { ...target, distribution: '--exec' }, { ...target, remotePath: 'relative' }]) {
    await assert.rejects(transport.run(bad, 'echo unsafe'))
  }
  for (const opts of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 600001 }, { maxOutputBytes: -1 }, { cwd: 'relative' }]) {
    await assert.rejects(transport.run(target, 'echo unsafe', opts))
  }
  await assert.rejects(transport.run(target, 'a\0b'))
  await assert.rejects(transport.run(target, 'x'.repeat(8193)))
  const controller = new AbortController()
  controller.abort()
  const result = await transport.run(target, 'echo unsafe', { signal: controller.signal })
  assert.equal(result.aborted, true)
  await assert.rejects(transport.inspect(target, controller.signal), { name: 'AbortError' })
  assert.equal(transport.calls.length, 0)
})

test('listWsl/inspect/browse run the real helper and preserve Unicode, quotes, and directory names', async t => {
  const { root, transport } = await fixture(t)
  await mkdir(join(root, "b'目录"))
  await mkdir(join(root, 'Alpha'))
  await writeFile(join(root, 'file.txt'), 'not a directory')
  assert.deepEqual(await transport.listWsl(), ['Ubuntu-22.04', 'Debian'])
  const info = await transport.inspect(target)
  assert.equal(info.path, remote(root))
  assert.ok(info.home && info.user && info.platform && info.python)
  assert.deepEqual(await transport.browse(target, '/test-work'), { path: remote(root), directories: ['Alpha', "b'目录"] })
  await assert.rejects(transport.browse(target, '/test-work/missing'), /directory/)
  await assert.rejects(transport.browse(target, '/test-work/file.txt'), /directory/)
})

test('nonzero foreground exit is a result with separate stdout/stderr, not an exception', async t => {
  const { transport } = await fixture(t)
  const result = await transport.run(target, command('import sys;print("out");print("err",file=sys.stderr);sys.exit(7)'))
  assert.equal(result.exitCode, 7)
  assert.equal(result.stdout, 'out\n')
  assert.equal(result.stderr, 'err\n')
  assert.equal(result.timedOut, false)
  assert.equal(result.aborted, false)
  assert.equal(transport.calls.length, 1)
})

test('Bash startup cannot change the requested cwd; command/path stay separate positional arguments', async t => {
  const { root, transport } = await fixture(t)
  const path = join(root, "space ' 中文")
  await mkdir(path)
  const startup = join(root, 'startup.sh')
  await writeFile(startup, 'cd /\n')
  transport.sourcePrefix = `import os\nos.environ["BASH_ENV"] = ${JSON.stringify(remote(startup))}\n`
  const result = await transport.run(target, command('import os;print(os.getcwd())'), { cwd: "/test-work/space ' 中文" })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.equal(result.stdout.trim(), remote(path))
})

test('both output streams are bounded tails while excess output is drained, including a zero-byte cap', async t => {
  const { transport } = await fixture(t)
  const script = command('import sys;sys.stdout.write("A"*200000+"stdout-tail");sys.stderr.write("B"*200000+"stderr-tail")')
  const result = await transport.run(target, script, { maxOutputBytes: 127 })
  assert.equal(result.exitCode, 0)
  assert.equal(Buffer.byteLength(result.stdout), 127)
  assert.equal(Buffer.byteLength(result.stderr), 127)
  assert.ok(result.stdout.endsWith('stdout-tail'))
  assert.ok(result.stderr.endsWith('stderr-tail'))
  assert.ok(result.stdoutTruncated && result.stderrTruncated)
  const empty = await transport.run(target, script, { maxOutputBytes: 0 })
  assert.equal(empty.exitCode, 0)
  assert.equal(empty.stdout, '')
  assert.equal(empty.stderr, '')
  assert.ok(empty.stdoutTruncated && empty.stderrTruncated)
})

test('a real deadline stops the command and its descendants without retrying', async t => {
  const { transport } = await fixture(t)
  const result = await transport.run(target, command('import subprocess,sys,time;p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"]);print(p.pid,flush=True);time.sleep(60)'), { timeoutMs: 3000 })
  // The helper enforces the same deadline remotely and may report it first: 124 is its
  // timeout marker, while timedOut marks the local safety net. Either stops it once.
  assert.ok(result.timedOut || result.exitCode === 124, JSON.stringify({ exitCode: result.exitCode, timedOut: result.timedOut }))
  assert.equal(result.aborted, false)
  assert.equal(transport.calls.length, 1)
  const pid = Number(result.stdout.trim())
  assert.ok(pid > 0, 'child started before deadline')
  assertDead(pid)
})

test('asynchronous abort cleans a TERM-resistant descendant and returns an aborted result once', async t => {
  const { transport } = await fixture(t)
  const controller = new AbortController()
  transport.onData = data => { if (/\d/.test(data)) controller.abort() }
  const result = await transport.run(target, command('import subprocess,sys,time;p=subprocess.Popen([sys.executable,"-c","import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)"]);time.sleep(0.15);print(p.pid,flush=True);time.sleep(60)'), { signal: controller.signal })
  assert.equal(result.aborted, true)
  assert.equal(result.timedOut, false)
  assert.equal(transport.calls.length, 1)
  assertDead(Number(result.stdout.trim()))
})

test('successful foreground completion also cleans descendants holding inherited pipes', async t => {
  const { transport } = await fixture(t)
  const result = await transport.run(target, command('import subprocess,sys,time;p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"]);print(p.pid,flush=True)'))
  assert.equal(result.exitCode, 0, result.stderr)
  assert.equal(result.timedOut, false)
  assertDead(Number(result.stdout.trim()))
})

test('dispose aborts/drains concurrent commands, is idempotent, and rejects subsequent work', async t => {
  const { transport } = await fixture(t)
  let started = 0
  transport.onData = data => { if (data.includes('ready')) started++ }
  const pending = [transport.run(target, 'echo ready; sleep 60'), transport.run(target, 'echo ready; sleep 60')]
  await waitFor(() => started === 2 ? true : undefined)
  const disposing = transport.dispose()
  assert.equal(transport.dispose(), disposing)
  await disposing
  for (const result of await Promise.all(pending)) assert.equal(result.aborted, true)
  await assert.rejects(transport.run(target, 'echo unsafe'), /disposed/)
  await assert.rejects(transport.inspect(target), /disposed/)
  await assert.rejects(transport.listWsl(), /disposed/)
  assert.equal(transport.calls.length, 2)
})

test('probe creation is exclusive and token verification prevents deleting unrelated files', async t => {
  const { root, transport } = await fixture(t)
  const probe = await transport.createMountProbe(target)
  assert.match(probe.name, /^\.dsh-ssh-probe-[a-f0-9]{32}$/)
  assert.match(probe.token, /^[a-f0-9]{64}$/)
  assert.equal(await readFile(join(root, probe.name), 'utf8'), probe.token)
  await assert.rejects(transport.removeMountProbe(target, '../outside', probe.token), /Invalid probe/)
  await assert.rejects(transport.removeMountProbe(target, probe.name, '0'.repeat(64)), /does not match/)
  assert.equal(await readFile(join(root, probe.name), 'utf8'), probe.token)
  await transport.removeMountProbe(target, probe.name, probe.token)
  await transport.removeMountProbe(target, probe.name, probe.token)
  assert.deepEqual(await readdir(root), [])
})

test('interrupted probe creation cleans the known name/token even when its response is lost', async t => {
  const { root, transport } = await fixture(t)
  transport.holdProbeResponse = true
  const controller = new AbortController()
  transport.onData = (_data, request) => { if (request?.op === 'probe-create') controller.abort() }
  await assert.rejects(transport.createMountProbe(target, controller.signal), { name: 'AbortError' })
  assert.deepEqual(transport.calls.map(call => call.request?.op), ['probe-create', 'probe-remove'])
  const [create, remove] = transport.calls.map(call => call.request)
  assert.ok(create && remove && 'name' in create && 'name' in remove)
  assert.equal(create.name, remove.name)
  assert.deepEqual(await readdir(root), [])
})

test('dispose waits for compensating cleanup of an interrupted probe', async t => {
  const { root, transport } = await fixture(t)
  transport.holdProbeResponse = true
  let ready = false
  transport.onData = () => { ready = true }
  const task = transport.createMountProbe(target)
  // Observe rejection immediately; disposal is deliberately responsible for it.
  const rejected = assert.rejects(task, { name: 'AbortError' })
  await waitFor(() => ready ? true : undefined)
  await transport.dispose()
  await rejected
  assert.deepEqual(await readdir(root), [])
})

test('malformed, failed, and oversized metadata responses reject instead of becoming command results', async t => {
  const { transport } = await fixture(t)
  transport.rawResponse = 'not-json'
  await assert.rejects(transport.inspect(target), /Invalid JSON/)
  transport.rawResponse = JSON.stringify({ path: '/' })
  await assert.rejects(transport.inspect(target), /helper/)
  transport.rawResponse = JSON.stringify({ path: '/', directories: ['../escape'] })
  await assert.rejects(transport.browse(target, '/'), /Invalid directory/)
  transport.rawResponse = 'x'.repeat(1024 * 1024 + 1)
  await assert.rejects(transport.inspect(target), /output limit/)
})

test('missing transport executable rejects promptly', async () => {
  const transport = new RemoteTransport({ wslExecutable: join(tmpdir(), 'no-such-dsh-transport-executable') })
  try { await assert.rejects(transport.inspect(target), /Cannot start/) } finally { await transport.dispose() }
})

test('a hung transport executable that ignores EOF is killed within the bounded shutdown grace', async () => {
  class HungTransport extends RemoteTransport {
    protected override spawnProcess(_invocation: Invocation): ChildProcessWithoutNullStreams {
      return super.spawnProcess({ executable: process.execPath, args: ['-e',
        'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)',
      ] })
    }
  }
  const transport = new HungTransport()
  const started = Date.now()
  try {
    const result = await transport.run(target, 'unused by the mock executable', { timeoutMs: 500 })
    assert.equal(result.timedOut, true)
    assert.equal(result.stdout, 'ready')
    assert.ok(Date.now() - started < 4500)
  } finally { await transport.dispose() }
})

test('the helper cannot overwrite an existing probe and never follows a probe symlink', async t => {
  const { root } = await fixture(t)
  const probe = { name: '.dsh-ssh-probe-' + 'a'.repeat(32), token: 'b'.repeat(64) }
  const path = join(root, probe.name)
  await writeFile(path, 'unrelated existing content')
  const invoke = (request: HelperRequest) => spawnSync(python.executable, [
    ...python.prefix, '-u', '-c', REMOTE_HELPER, Buffer.from(JSON.stringify(request)).toString('base64'),
  ], { env: python.env, windowsHide: true, timeout: 8000, encoding: 'utf8' })
  const created = invoke({ op: 'probe-create', path: remote(root), ...probe })
  assert.equal(created.status, 1)
  assert.equal(await readFile(path, 'utf8'), 'unrelated existing content')
  // Symlinks require a privilege on native Windows. WSL/POSIX exercise this
  // check in a Linux temp directory, including targets whose content matches.
  if (process.platform === 'win32' && !python.wsl) return
  const linuxRoot = pythonSync('import tempfile;print(tempfile.mkdtemp(prefix="dsh-ssh-transport-"))')
  try {
    pythonSync('import os,sys;root,name,token=sys.argv[1:];open(os.path.join(root,"victim"),"w").write(token);os.symlink("victim",os.path.join(root,name))', [linuxRoot, probe.name, probe.token])
    const removed = invoke({ op: 'probe-remove', path: linuxRoot, ...probe })
    assert.equal(removed.status, 1)
    assert.match(removed.stderr, /not a regular file/)
    assert.equal(pythonSync('import os,sys;print(open(os.path.join(sys.argv[1],"victim")).read())', [linuxRoot]), probe.token)
  } finally {
    pythonSync('import shutil,sys;shutil.rmtree(sys.argv[1])', [linuxRoot])
  }
})

test('helper itself expires an abandoned lease or EOF, and refuses to start after initial stdin EOF', async t => {
  const { root } = await fixture(t)
  for (const mode of ['lease', 'eof', 'before-start', 'timeout'] as const) {
    const marker = join(root, mode)
    const request: HelperRequest = {
      op: 'run', cwd: remote(root), timeoutMs: mode === 'timeout' ? 300 : 10000, leaseMs: mode === 'timeout' ? 5000 : 500,
      command: command(`import pathlib,subprocess,sys,time;pathlib.Path(${JSON.stringify(remote(marker))}).touch();p=subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"]);print(p.pid,flush=True);time.sleep(60)`),
    }
    const child = spawn(python.executable, [...python.prefix, '-u', '-c', REMOTE_HELPER, Buffer.from(JSON.stringify(request)).toString('base64')], {
      shell: false, windowsHide: true, stdio: 'pipe', env: python.env,
    })
    let output = ''
    let stderr = ''
    child.stdout.on('data', data => { output += data; if (mode === 'eof') child.stdin.end() })
    child.stderr.on('data', data => { stderr += data })
    child.stdin.on('error', () => {})
    const closed = once(child, 'close')
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 8000)
    try {
      if (mode === 'before-start') child.stdin.end(); else child.stdin.write('h\n')
      const [code] = await closed
      assert.equal(code, mode === 'timeout' ? 124 : 125, stderr)
      if (mode === 'before-start') assert.equal(existsSync(marker), false)
      else assertDead(Number(output.trim()))
    } finally { clearTimeout(watchdog); child.stdin.destroy() }
  }
})

test('helper keeps a foreground command alive with periodic heartbeats', async t => {
  const { transport } = await fixture(t)
  const result = await transport.run(target, 'sleep 5.4; printf heartbeat-ok', { timeoutMs: 10000 })
  assert.equal(result.exitCode, 0, result.stderr)
  assert.equal(result.stdout, 'heartbeat-ok')
})

test('host-key failures point at in-app verification and never suggest skipping it', async () => {
  class HostKeyTransport extends RemoteTransport {
    constructor(private readonly kind: 'unknown' | 'changed') { super() }
    protected override spawnProcess(_invocation: Invocation): ChildProcessWithoutNullStreams {
      const stderr = this.kind === 'changed'
        ? 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\\nHost key verification failed.\\n'
        : 'No ED25519 host key is known for example.test and you have requested strict checking.\\nHost key verification failed.\\n'
      return super.spawnProcess({ executable: process.execPath, args: ['-e', `process.stderr.write(${JSON.stringify(stderr)});process.exit(255)`] })
    }
  }
  const unknown = new HostKeyTransport('unknown')
  try { await assert.rejects(unknown.inspect(target), /可在插件中核对主机指纹后信任该主机/) } finally { await unknown.dispose() }
  const changed = new HostKeyTransport('changed')
  try { await assert.rejects(changed.inspect(target), /插件不会自动替换主机密钥/) } finally { await changed.dispose() }
})

test('host-key verification is wired only to SSH-backed targets', async () => {
  const transport = new RemoteTransport()
  try {
    await assert.rejects(transport.inspectHostKeys(target), /只有 SSH/)
    await assert.rejects(transport.inspectHostKeys({ kind: 'docker', container: 'a'.repeat(64), remotePath: '/' }), /只有 SSH/)
    await assert.rejects(transport.trustHostKeys(target, ['SHA256:' + 'a'.repeat(43)]), /只有 SSH/)
    await assert.rejects(transport.trustHostKeys(ssh, ['not-a-fingerprint']))
    const docker: RemoteTarget = { kind: 'docker', container: 'b'.repeat(64), via: ssh, remotePath: '/' }
    await assert.rejects(transport.trustHostKeys(docker, ['not-a-fingerprint']), /无效/)
  } finally { await transport.dispose() }
})
