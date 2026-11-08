import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import {
  remoteWorkdir, sshfsUncPath, targetKey, toRemotePath,
  validateAddRequest, validateTarget, wslUncPath,
} from '../src/model.js'
import type { RemoteTarget, SavedWorkspace, SshTarget, WslTarget } from '../src/types.js'

const ssh: SshTarget = { kind: 'ssh', host: 'dev.example', user: 'alice', remotePath: '/srv/repo' }
const wsl: WslTarget = { kind: 'wsl', distribution: 'Ubuntu', remotePath: '/home/alice/repo' }
const saved = (localPath: string, target: RemoteTarget = ssh): SavedWorkspace => ({
  id: 'remote-1', workspaceId: 'native-1', title: 'Remote repo', localPath, target, createdAt: 1,
})

test('target validation returns canonical connection data without mutating input', () => {
  const input = { ...ssh, host: ' dev.example ', user: ' alice ', remotePath: '/srv//old/../repo/' }
  assert.deepEqual(validateTarget(input), ssh)
  assert.equal(input.remotePath, '/srv//old/../repo/')
  assert.deepEqual(validateTarget({ ...wsl, remotePath: '//home/./alice/../' }), { ...wsl, remotePath: '/home' })
  assert.deepEqual(validateTarget({ kind: 'ssh', host: 'alias', remotePath: '/' }), { kind: 'ssh', host: 'alias', remotePath: '/' })
})

test('target validation rejects malformed shapes, unsupported kinds, and invalid ports', () => {
  for (const input of [null, undefined, [], '', {}, { ...ssh, kind: 'server' }]) {
    assert.throws(() => validateTarget(input))
  }
  for (const port of [0, -1, 65536, 1.2, NaN, Infinity, '22', null]) {
    assert.throws(() => validateTarget({ ...ssh, port }), /port/u)
  }
  for (const port of [1, 22, 65535]) assert.equal((validateTarget({ ...ssh, port }) as SshTarget).port, port)
})

test('SSH identity files accept local paths and home-relative paths but reject pasted keys and unsupported formats', () => {
  const path = join(process.cwd(), 'keys', 'dev key.pem')
  assert.equal((validateTarget({ ...ssh, identityFile: ` ${path} ` }) as SshTarget).identityFile, path)
  assert.equal((validateTarget({ ...ssh, identityFile: '~/.ssh/id_ed25519' }) as SshTarget).identityFile, '~/.ssh/id_ed25519')
  for (const identityFile of ['', 'relative/key', 42, null, '-----BEGIN OPENSSH PRIVATE KEY-----', path + '\n']) {
    assert.throws(() => validateTarget({ ...ssh, identityFile }))
  }
  assert.throws(() => validateTarget({ ...ssh, identityFile: path + '.pub' }), /公钥/)
  assert.throws(() => validateTarget({ ...ssh, identityFile: path + '.ppk' }), /OpenSSH/)
  assert.notEqual(targetKey(ssh), targetKey({ ...ssh, identityFile: path }))
  assert.notEqual(targetKey({ ...ssh, identityFile: path }), targetKey({ ...ssh, identityFile: path + '2' }))
  assert.equal(targetKey(ssh), JSON.stringify(['ssh', ssh.host, 22, 'alice', '/srv/repo']))
})

test('targets reject option-like identifiers and embedded control characters', () => {
  for (const host of ['', ' ', '-host', ' -oProxyCommand=bad', 'alice@host', 'host name', 'host/repo', 'host\\repo']) {
    assert.throws(() => validateTarget({ ...ssh, host }))
  }
  for (const distribution of ['', '-Ubuntu', '..', 'Ubuntu/repo', 'Ubuntu\\repo', 'Ubuntu:bad']) {
    assert.throws(() => validateTarget({ ...wsl, distribution }))
  }
  for (const user of ['', '-root', ' root name', 'a/b', 'a\\b']) {
    assert.throws(() => validateTarget({ ...ssh, user }))
    assert.throws(() => validateTarget({ ...wsl, user }))
  }
  for (const control of ['\0', '\n', '\r', '\t', '\x1b', '\x7f', '\x85']) {
    for (const input of [
      { ...ssh, host: `dev${control}` }, { ...ssh, user: `a${control}` },
      { ...ssh, remotePath: `/srv/${control}` }, { ...wsl, distribution: `Ubuntu${control}` },
    ]) assert.throws(() => validateTarget(input), /control/u)
  }
})

test('remote paths must be POSIX absolute paths, with dot segments normalized', () => {
  for (const remotePath of ['', '.', '../repo', '~/repo', 'C:/repo', '\\home\\repo', '/repo\\child', null]) {
    assert.throws(() => validateTarget({ ...ssh, remotePath }))
  }
  assert.equal(validateTarget({ ...ssh, remotePath: '/../../etc/' }).remotePath, '/etc')
  assert.equal(validateTarget({ ...ssh, remotePath: '/folder with spaces/repo ' }).remotePath, '/folder with spaces/repo ')
})

test('SSH accepts aliases, IPv4, and IPv6 without treating user@host as a host', () => {
  for (const host of ['my-config-alias', '192.0.2.10', '::1', '[2001:db8::1]', 'fe80::1%eth0']) {
    assert.equal((validateTarget({ ...ssh, host }) as SshTarget).host, host)
  }
  assert.throws(() => validateTarget({ ...ssh, host: 'alice@dev.example' }), /separately/u)
})

test('add requests validate optional display text and canonical native mount paths', () => {
  const mount = join(process.cwd(), 'offline-mount')
  assert.deepEqual(validateAddRequest({ target: ssh, title: ' Project ', localPath: join(mount, 'old', '..') }), {
    target: ssh, title: 'Project', localPath: mount,
  })
  assert.deepEqual(validateAddRequest({ target: wsl, title: '  ' }), { target: wsl })
  for (const input of [null, [], {}, { target: ssh, title: 1 }, { target: ssh, title: 'bad\nname' },
    { target: ssh, localPath: 'relative' }, { target: ssh, localPath: '/bad\0path' }]) {
    assert.throws(() => validateAddRequest(input))
  }
  if (process.platform === 'win32') {
    assert.throws(() => validateAddRequest({ target: ssh, localPath: '\\root-relative' }))
  }
})

test('WSL share paths preserve distribution and use canonical Linux path components', () => {
  assert.equal(wslUncPath(wsl), '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo')
  assert.equal(wslUncPath({ ...wsl, remotePath: '/' }), '\\\\wsl.localhost\\Ubuntu\\')
  assert.equal(wslUncPath({ ...wsl, user: 'root', remotePath: '/home//alice/../repo/' }), '\\\\wsl.localhost\\Ubuntu\\home\\repo')
})

test('WSL drvfs paths use native drive paths without changing the remote target', () => {
  for (const [remotePath, expected] of [
    ['/mnt/c', 'C:\\'], ['/mnt/c/', 'C:\\'], ['/mnt/d/Work/my repo', 'D:\\Work\\my repo'],
    ['/mnt/Z/work/../repo', 'Z:\\repo'],
  ]) {
    const target = { ...wsl, distribution: 'Debian', remotePath: remotePath! }
    assert.equal(wslUncPath(target), expected)
    assert.equal(target.remotePath, remotePath)
    assert.equal(target.distribution, 'Debian')
  }
  for (const remotePath of ['/mnt/cousin/repo', '/mnt/cc/repo', '/MNT/c/repo', '/mnt/c/..']) {
    assert.ok(wslUncPath({ ...wsl, remotePath }).startsWith('\\\\wsl.localhost\\Ubuntu\\'))
  }
  const target = { ...wsl, remotePath: '/mnt/c/work' }
  assert.equal(toRemotePath('c:\\WORK\\child', saved(wslUncPath(target), target), 'win32'), '/mnt/c/work/child')
})

test('SSHFS root-relative key shares use the inspected user and explicit default port', () => {
  assert.throws(() => sshfsUncPath({ ...ssh, identityFile: '~/.ssh/custom_key' }, 'alice'), /挂载路径.*全量模式/)
  assert.equal(sshfsUncPath(ssh, 'actual-user'), '\\\\sshfs.kr\\actual-user@dev.example!22\\srv\\repo')
  assert.equal(sshfsUncPath({ ...ssh, port: 2222, remotePath: '/var/old/../repo/' }, 'alice'), '\\\\sshfs.kr\\alice@dev.example!2222\\var\\repo')
  assert.equal(sshfsUncPath({ ...ssh, remotePath: '/' }, 'alice'), '\\\\sshfs.kr\\alice@dev.example!22\\')
  for (const host of ['::1', '[2001:db8::1]', 'alias!2222']) {
    assert.throws(() => sshfsUncPath({ ...ssh, host }, 'alice'), /existing mount/u)
  }
  for (const user of ['a@domain', '-root', 'bad\\user', 'bad\nuser']) {
    assert.throws(() => sshfsUncPath(ssh, user))
  }
})

test('Windows mapping respects components and case while preserving child spelling', () => {
  const workspace = saved('Z:\\mount\\repo')
  for (const [local, expected] of [
    ['Z:\\mount\\repo', '/srv/repo'], ['z:/MOUNT/REPO/', '/srv/repo'],
    ['Z:\\mount\\repo\\Src\\index.ts', '/srv/repo/Src/index.ts'],
    ['Z:\\mount\\repo\\old\\..\\new', '/srv/repo/new'],
  ]) assert.equal(toRemotePath(local!, workspace, 'win32'), expected)
  for (const local of ['Z:\\mount\\repo-other', 'Z:\\mount\\repo\\..\\outside', 'Y:\\mount\\repo',
    'repo\\child', 'Z:repo', '\\mount\\repo', 'Z:\\mount\\repo\\bad\0child', '\\\\?\\Z:\\mount\\repo']) {
    assert.equal(toRemotePath(local, workspace, 'win32'), undefined, local)
  }
})

test('UNC containment includes server and share boundaries', () => {
  const workspace = saved('\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo', wsl)
  assert.equal(toRemotePath('\\\\WSL.LOCALHOST\\ubuntu\\HOME\\ALICE\\REPO\\src', workspace, 'win32'), '/home/alice/repo/src')
  for (const local of ['\\\\wsl.localhost\\Debian\\home\\alice\\repo',
    '\\\\other-host\\Ubuntu\\home\\alice\\repo', '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo-copy']) {
    assert.equal(toRemotePath(local, workspace, 'win32'), undefined)
  }
})

test('POSIX mount containment is case sensitive and root mappings work', () => {
  const workspace = saved('/mount/repo')
  assert.equal(toRemotePath('/mount/repo/src', workspace, 'linux'), '/srv/repo/src')
  assert.equal(toRemotePath('/mount/repo/./child/../src', workspace, 'darwin'), '/srv/repo/src')
  for (const local of ['/mount/Repo', '/mount/repo-copy', '/mount/repo/../outside', 'relative', '/mount/repo/back\\slash']) {
    assert.equal(toRemotePath(local, workspace, 'linux'), undefined)
  }
  assert.equal(toRemotePath('/child', saved('/', { ...ssh, remotePath: '/' }), 'linux'), '/child')
})

test('remote cwd uses mapped current directory and permits full POSIX relative access', () => {
  const workspace = saved('Z:\\mount\\repo')
  const cwd = 'Z:\\mount\\repo\\src'
  assert.equal(remoteWorkdir(undefined, cwd, workspace, 'win32'), '/srv/repo/src')
  assert.equal(remoteWorkdir('', cwd, workspace, 'win32'), '/srv/repo/src')
  assert.equal(remoteWorkdir('./child', cwd, workspace, 'win32'), '/srv/repo/src/child')
  assert.equal(remoteWorkdir('../../other', cwd, workspace, 'win32'), '/srv/other')
  assert.equal(remoteWorkdir('../../../../etc', cwd, workspace, 'win32'), '/etc')
  assert.equal(remoteWorkdir('/var/old/../tmp/', cwd, workspace, 'win32'), '/var/tmp')
})

test('native Windows cwd inputs translate only when contained in the mount', () => {
  const workspace = saved('Z:\\mount\\repo')
  const cwd = 'Z:\\mount\\repo\\src'
  assert.equal(remoteWorkdir('z:/MOUNT/REPO/lib', cwd, workspace, 'win32'), '/srv/repo/lib')
  assert.equal(remoteWorkdir('..\\lib', cwd, workspace, 'win32'), '/srv/repo/lib')
  for (const input of ['Z:\\outside', 'Z:\\mount\\repo-copy', 'Y:\\repo', '..\\..\\outside', '\\outside', '//other/share', 'C:relative']) {
    assert.throws(() => remoteWorkdir(input, cwd, workspace, 'win32'), /outside|drive-relative/u)
  }
  assert.throws(() => remoteWorkdir(undefined, 'Z:\\elsewhere', workspace, 'win32'), /outside/u)
  assert.throws(() => remoteWorkdir('/tmp\n', cwd, workspace, 'win32'), /control/u)
})

test('POSIX hosts translate mount paths and retain Linux absolute/relative cwd semantics', () => {
  const workspace = saved('/mount/repo')
  assert.equal(remoteWorkdir('/mount/repo/lib', '/mount/repo/src', workspace, 'linux'), '/srv/repo/lib')
  assert.equal(remoteWorkdir('/tmp', '/mount/repo/src', workspace, 'linux'), '/tmp')
  assert.equal(remoteWorkdir('//tmp/./child', '/mount/repo', workspace, 'linux'), '/tmp/child')
  assert.equal(remoteWorkdir('../..', '/mount/repo', workspace, 'linux'), '/')
  assert.throws(() => remoteWorkdir('C:\\outside', '/mount/repo', workspace, 'linux'), /outside/u)
  assert.throws(() => remoteWorkdir(undefined, '/mount/repo-sibling', workspace, 'linux'), /outside/u)
})

test('target keys normalize paths/default ports and exclude display data', () => {
  assert.equal(targetKey(ssh), targetKey({ ...ssh, host: 'DEV.EXAMPLE', port: 22, remotePath: '/srv//old/../repo/' }))
  const display = { ...ssh, title: 'Changed display name' }
  assert.equal(targetKey(ssh), targetKey(display))
  for (const target of [{ ...ssh, user: 'bob' }, { ...ssh, host: 'other' },
    { ...ssh, port: 2222 }, { ...ssh, remotePath: '/srv/Repo' }, wsl]) {
    assert.notEqual(targetKey(ssh), targetKey(target))
  }
  assert.equal(targetKey(wsl), targetKey({ ...wsl, distribution: 'ubuntu' }))
  assert.notEqual(targetKey(wsl), targetKey({ ...wsl, user: 'root' }))
  assert.notEqual(targetKey(wsl), targetKey({ ...wsl, distribution: 'Debian' }))
})
