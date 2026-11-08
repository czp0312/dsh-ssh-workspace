import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SkillSync, localSkillRegistry, readSkillBundle, type SkillRegistry } from '../src/skills-sync.js'
import { SKILLS_HELPER } from '../src/skills-helper.js'
import { RemoteTransport, type Invocation } from '../src/transport.js'
import type { RemoteTarget } from '../src/types.js'

// Real Linux IO tests exercise atomic replacement, permissions and CAS without
// touching a user's DSH home or using a model/SSH server.
const executable = process.platform === 'win32' ? 'wsl.exe' : 'python3'
const prefix = process.platform === 'win32' ? ['-d', 'Ubuntu-22.04', '--exec', 'python3'] : []
const available = spawnSync(executable, [...prefix, '-c', 'import fcntl'], { windowsHide: true, timeout: 8000 }).status === 0
const target: RemoteTarget = { kind: 'wsl', distribution: 'Ubuntu-22.04', remotePath: '/tmp' }
const skill = (name: string, body = 'Follow this workflow.') => `---\nname: ${name}\ndescription: Demo ${name}\n---\n${body}\n`

function python(source: string, args: string[] = []): string {
  const result = spawnSync(executable, [...prefix, '-c', source, ...args], { windowsHide: true, timeout: 8000, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

async function fixture(t: test.TestContext) {
  const local = await mkdtemp(join(tmpdir(), 'dsh-skills-source-'))
  const remote = python('import tempfile;print(tempfile.mkdtemp(prefix="dsh-ssh-skills-"))')
  assert.ok(remote.startsWith('/tmp/dsh-ssh-skills-'))
  class LinuxTransport extends RemoteTransport {
    override async pythonInvocation(_target: RemoteTarget, script: string, request: unknown): Promise<Invocation> {
      const source = `import os\nos.environ['DSH_HOME']=${JSON.stringify(remote + '/dsh')}\nos.environ['DSH_AGENTS_HOME']=${JSON.stringify(remote + '/agents')}\n` + script
      return { executable, args: [...prefix, '-u', '-c', source, Buffer.from(JSON.stringify(request)).toString('base64')] }
    }
  }
  const transport = new LinuxTransport()
  t.after(async () => {
    await transport.dispose()
    assert.ok(local.startsWith(join(tmpdir(), 'dsh-skills-source-')))
    await rm(local, { recursive: true, force: true })
    python('import shutil,sys;shutil.rmtree(sys.argv[1])', [remote])
  })
  const definitions: Awaited<ReturnType<SkillRegistry['list']>> = []
  const registry: SkillRegistry = { list: async () => definitions }
  const sync = new SkillSync(() => registry, transport)
  const connection = new AbortController()
  const request = () => new AbortController().signal
  const preview = () => sync.preview('project', target, connection.signal, request())
  const add = async (name: string, source = 'user-dsh') => {
    const path = join(local, name, 'SKILL.md')
    await mkdir(join(local, name), { recursive: true })
    await writeFile(path, skill(name))
    const definition = { name, description: 'Demo ' + name, source, path }
    definitions.push(definition)
    return definition
  }
  return { local, remote, transport, sync, connection, request, preview, add, definitions }
}

test('local discovery retains a default preset scope and releases it even when its provider fails', async () => {
  const key = {}
  let leases = 0
  const presets = { async acquireScope() { leases++; return { key, async [Symbol.asyncDispose]() { leases-- } } } }
  let shouldFail = false
  const local = localSkillRegistry({ async list(options) { assert.equal(options?.scope, key); assert.equal(leases, 1); if (shouldFail) throw new Error('provider failed'); return [] } }, presets)
  assert.deepEqual(await local.list(), [])
  assert.equal(leases, 0)
  shouldFail = true
  await assert.rejects(local.list(), /provider failed/)
  assert.equal(leases, 0)
})

test('selected skills transfer instructions and resources, keep remote-only skills, and compare equal after import', { skip: !available }, async t => {
  const f = await fixture(t)
  await f.add('code-review')
  const selected = await f.add('release-notes', 'user-agents')
  await f.add('packaged-office', 'bundled')
  await mkdir(join(f.local, 'release-notes', 'scripts'))
  await writeFile(join(f.local, 'release-notes', 'scripts', 'run.sh'), '#!/bin/sh\nprintf skill-ok\n')
  await writeFile(join(f.local, 'release-notes', 'reference.bin'), Buffer.alloc(256 * 1024, 42))
  await writeFile(join(f.local, 'release-notes', '😀.txt'), 'emoji resource')
  await writeFile(join(f.local, 'release-notes', '\ue000.txt'), 'private-use Unicode resource')
  await writeFile(join(f.local, 'release-notes', '.env'), 'SECRET=do-not-transfer')
  python('import os,sys;root=sys.argv[1];os.makedirs(root+"/dsh/skills/remote-only");open(root+"/dsh/skills/remote-only/SKILL.md","w").write(sys.argv[2])', [f.remote, skill('remote-only')])
  const plan = await f.preview()
  assert.deepEqual(plan.items.map(row => row.name), ['code-review', 'release-notes'])
  assert.ok(plan.items.every(row => row.state === 'missing'))
  const item = plan.items.find(row => row.name === selected.name)!
  const result = await f.sync.apply('project', plan.planId, [item.id], false, f.request())
  assert.equal(result.items[0]!.status, 'created')
  assert.equal(python('import subprocess,sys;print(subprocess.check_output([sys.argv[1]+"/dsh/skills/release-notes/scripts/run.sh"],text=True))', [f.remote]), 'skill-ok')
  assert.equal(python('import os,sys;print(os.path.getsize(sys.argv[1]+"/dsh/skills/release-notes/reference.bin"))', [f.remote]), '262144', 'bulk resources cross stdin rather than exceeding argv limits')
  assert.equal(python('import os,sys;root=sys.argv[1];print(os.path.exists(root+"/dsh/skills/remote-only/SKILL.md"),os.path.exists(root+"/dsh/skills/code-review"),os.path.exists(root+"/dsh/skills/release-notes/.env"))', [f.remote]), 'True False False')
  assert.equal((await f.preview()).items.find(row => row.name === 'release-notes')!.state, 'equal')
  await assert.rejects(f.sync.apply('project', plan.planId, [item.id], false, f.request()), /过期/)
})

test('updates require explicit overwrite and detect both source edits and concurrent remote edits', { skip: !available }, async t => {
  const f = await fixture(t)
  const source = await f.add('code-review')
  const initial = await f.preview()
  await f.sync.apply('project', initial.planId, [initial.items[0]!.id], false, f.request())
  await writeFile(source.path!, skill('code-review', 'New local instructions'))
  const update = await f.preview()
  assert.equal(update.items[0]!.state, 'different')
  await assert.rejects(f.sync.apply('project', update.planId, [update.items[0]!.id], false, f.request()), /允许覆盖/)
  python('import sys;open(sys.argv[1]+"/dsh/skills/code-review/SKILL.md","a").write("remote edit")', [f.remote])
  await assert.rejects(f.sync.apply('project', update.planId, [update.items[0]!.id], true, f.request()), /远端技能已变化/)
  const refreshed = await f.preview()
  const result = await f.sync.apply('project', refreshed.planId, [refreshed.items[0]!.id], true, f.request())
  assert.equal(result.items[0]!.status, 'updated')
  const sourcePlan = await f.preview()
  await writeFile(source.path!, skill('code-review', 'Changed after preview'))
  // Force selection of a new diff after editing an already equal source.
  const changedPlan = await f.preview()
  await writeFile(source.path!, skill('code-review', 'Changed again'))
  await assert.rejects(f.sync.apply('project', changedPlan.planId, [changedPlan.items[0]!.id], true, f.request()), /本机技能.*已变化/)
  assert.equal(sourcePlan.items[0]!.state, 'equal')
  python('import sys;open(sys.argv[1]+"/dsh/skills/code-review/.env","w").write("KEEP_REMOTE_DATA=1")', [f.remote])
  const protectedPlan = await f.preview()
  assert.equal(protectedPlan.items[0]!.state, 'blocked')
  assert.match(protectedPlan.items[0]!.reason!, /远端技能包含/)
  assert.equal(python('import sys;print(open(sys.argv[1]+"/dsh/skills/code-review/.env").read())', [f.remote]), 'KEEP_REMOTE_DATA=1')
})

test('sync plans are bound to a workspace and connection; compatibility-root skills cannot be silently shadowed', { skip: !available }, async t => {
  const f = await fixture(t)
  await f.add('code-review')
  const plan = await f.preview()
  await assert.rejects(f.sync.apply('other-project', plan.planId, [plan.items[0]!.id], false, f.request()), /过期/)
  f.connection.abort()
  await assert.rejects(f.sync.apply('project', plan.planId, [plan.items[0]!.id], false, f.request()), /过期/)
  python('import os,sys;root=sys.argv[1];os.makedirs(root+"/agents/skills/different-folder");open(root+"/agents/skills/different-folder/SKILL.md","w").write(sys.argv[2])', [f.remote, skill('code-review')])
  const fresh = await f.sync.preview('project', target, new AbortController().signal, f.request())
  assert.equal(fresh.items[0]!.state, 'blocked')
  assert.match(fresh.items[0]!.reason!, /兼容目录/)
})

test('the remote importer rejects traversal and symlink targets without changing outside files', { skip: !available }, async t => {
  const f = await fixture(t)
  await f.add('code-review')
  const bundle = await readSkillBundle(f.definitions[0]!)
  const preview = await f.transport.pythonInput<any>(target, SKILLS_HELPER, { op: 'preview' })
  const result = await f.transport.pythonInput<any>(target, SKILLS_HELPER, { op: 'apply', expected: preview.hash, items: [{ id: 'attack', name: 'code-review', entry: 'code-review', files: [{ path: '../outside', data: 'dGVzdA==', executable: false }], hash: bundle.hash }] })
  assert.equal(result.items[0].status, 'failed')
  assert.match(result.items[0].message, /路径/)
  python('import os,sys;root=sys.argv[1];os.mkdir(root+"/outside");open(root+"/outside/SKILL.md","w").write(sys.argv[2]);os.symlink(root+"/outside",root+"/dsh/skills/code-review")', [f.remote, skill('code-review')])
  const catalog = await f.transport.pythonInput<any>(target, SKILLS_HELPER, { op: 'preview' })
  const linked = await f.transport.pythonInput<any>(target, SKILLS_HELPER, { op: 'apply', expected: catalog.hash, items: [{ id: 'attack', name: 'code-review', entry: 'code-review', ...bundle, overwrite: true }] })
  assert.equal(linked.items[0].status, 'failed')
  assert.equal(python('import sys;print(open(sys.argv[1]+"/outside/SKILL.md").read())', [f.remote]), skill('code-review').trim())
})
