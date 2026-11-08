import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { WorkspaceStore } from '../src/storage.js'
import type { SavedWorkspace } from '../src/types.js'

async function fixture(t: TestContext) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'dsh-ssh-storage-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'state.json')
  const record = (id = 'remote-1'): SavedWorkspace => ({
    id, workspaceId: `native-${id}`, title: `Project ${id}`,
    localPath: join(directory, 'disconnected', id),
    target: { kind: 'ssh', host: 'dev.example', user: 'alice', remotePath: '/srv/repo' },
    createdAt: 1,
  })
  return { directory, path, record, store: new WorkspaceStore(path) }
}

test('a missing ledger loads empty without creating a file', async t => {
  const { path, store } = await fixture(t)
  assert.deepEqual(store.list(), [])
  assert.deepEqual(await store.load(), [])
  await assert.rejects(fs.access(path), { code: 'ENOENT' })
})

test('save/load round-trip a versioned ledger without checking mount availability', async t => {
  const { path, record, store } = await fixture(t)
  const source = record()
  await assert.rejects(fs.access(source.localPath), { code: 'ENOENT' })
  await store.save([source])
  const document = JSON.parse(await fs.readFile(path, 'utf8'))
  assert.equal(document.schemaVersion, 1)
  assert.deepEqual(document.workspaces, [source])
  assert.deepEqual(await new WorkspaceStore(path).load(), [source])
  assert.deepEqual(store.list(), [source])
})

test('nested state directories are created and target/native paths are canonicalized', async t => {
  const { directory, record } = await fixture(t)
  const path = join(directory, 'nested', 'state.json')
  const store = new WorkspaceStore(path)
  const source = record()
  const localPath = join(source.localPath, 'old', '..')
  await store.save([{ ...source, localPath, target: { ...source.target, remotePath: '/srv/old/../repo/' } }])
  assert.deepEqual(await new WorkspaceStore(path).load(), [source])
})

test('SSH key paths survive saving and reloading without storing key contents', async t => {
  const { directory, path, record, store } = await fixture(t)
  const source = record()
  const identityFile = join(directory, 'keys with spaces', 'id_ed25519')
  source.target = { kind: 'ssh', host: 'dev-server', remotePath: '/srv/repo', identityFile }
  await store.save([source])
  const loaded = await new WorkspaceStore(path).load()
  assert.deepEqual(loaded[0]?.target, source.target)
})

test('tombstones including timestamp zero survive saving, loading, and list copies', async t => {
  const { path, record, store } = await fixture(t)
  const records = [record('active'), { ...record('removed'), removedAt: 10 }, { ...record('zero'), removedAt: 0 }]
  await store.save(records)
  assert.deepEqual(store.list(), records)
  assert.deepEqual(await new WorkspaceStore(path).load(), records)
  assert.equal(Object.hasOwn(store.list()[0]!, 'removedAt'), false)
})

test('list/load return detached records and nested targets', async t => {
  const { record, store } = await fixture(t)
  const original = record()
  await store.save([original])
  original.title = 'caller mutation'
  original.target.remotePath = '/caller'
  const loaded = await store.load()
  loaded[0]!.title = 'reader mutation'
  loaded[0]!.target.remotePath = '/reader'
  ;(loaded as SavedWorkspace[]).push(record('extra'))
  const listed = store.list()
  listed[0]!.target.remotePath = '/list'
  assert.equal(store.list().length, 1)
  assert.equal(store.list()[0]!.title, 'Project remote-1')
  assert.equal(store.list()[0]!.target.remotePath, '/srv/repo')
})

test('invalid JSON throws and preserves the previous snapshot and corrupt file', async t => {
  const { path, record, store } = await fixture(t)
  const original = record()
  await store.save([original])
  const corrupt = '{"schemaVersion":1,"workspaces":['
  await fs.writeFile(path, corrupt)
  await assert.rejects(store.load(), /JSON/u)
  assert.deepEqual(store.list(), [original])
  assert.equal(await fs.readFile(path, 'utf8'), corrupt)
  await assert.rejects(new WorkspaceStore(path).load(), /JSON/u)
})

test('unsupported schemas and malformed persisted records never silently reset state', async t => {
  const { path, record, store } = await fixture(t)
  const original = record()
  await store.save([original])
  const invalidRecords = [
    null, [], {}, { ...original, id: '' }, { ...original, workspaceId: 1 },
    { ...original, title: 'bad\nname' }, { ...original, localPath: 'relative/mount' },
    { ...original, localPath: `${original.localPath}\0bad` },
    { ...original, createdAt: -1 }, { ...original, createdAt: '1' },
    ...[-1, null, '10', true].map(removedAt => ({ ...original, removedAt })),
    { ...original, target: { ...original.target, remotePath: 'relative' } },
    { ...original, target: { ...original.target, host: '-option' } },
    { ...original, target: { ...original.target, port: 65536 } },
  ]
  const documents = [null, [], {}, { schemaVersion: 2, workspaces: [] },
    { schemaVersion: '1', workspaces: [] }, { schemaVersion: 1, workspaces: {} },
    ...invalidRecords.map(value => ({ schemaVersion: 1, workspaces: [value] })),
    { schemaVersion: 1, workspaces: [original, original] },
  ]
  for (const document of documents) {
    const source = JSON.stringify(document)
    await fs.writeFile(path, source)
    await assert.rejects(store.load())
    assert.deepEqual(store.list(), [original])
    assert.equal(await fs.readFile(path, 'utf8'), source)
  }
})

test('invalid save data, including nonfinite tombstone timestamps, leaves disk and memory unchanged', async t => {
  const { path, directory, record, store } = await fixture(t)
  const original = record()
  await store.save([original])
  const source = await fs.readFile(path, 'utf8')
  for (const removedAt of [NaN, Infinity, -Infinity, -1]) {
    await assert.rejects(store.save([{ ...original, removedAt }]), /removedAt/u)
  }
  await assert.rejects(store.save([{ ...original, localPath: 'relative' }]), /absolute/u)
  await assert.rejects(store.save([original, original]), /Duplicate/u)
  assert.deepEqual(store.list(), [original])
  assert.equal(await fs.readFile(path, 'utf8'), source)
  assert.deepEqual(await fs.readdir(directory), ['state.json'])
})

test('rename failure preserves the old ledger, cleans up staging, and does not poison later saves', async t => {
  const { path, directory, record, store } = await fixture(t)
  const original = record('before')
  await store.save([original])
  const source = await fs.readFile(path, 'utf8')
  const rename = fs.rename
  const failure = t.mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
    if (to === path) throw Object.assign(new Error('rename denied'), { code: 'EACCES' })
    return rename(from, to)
  })
  await assert.rejects(store.save([record('after')]), /rename denied/u)
  assert.equal(await fs.readFile(path, 'utf8'), source)
  assert.deepEqual(store.list(), [original])
  assert.deepEqual(await fs.readdir(directory), ['state.json'])
  failure.mock.restore()
  await store.save([record('recovered')])
  assert.deepEqual(await new WorkspaceStore(path).load(), [record('recovered')])
})

test('writes are serialized, snapshots detach at invocation, and the old file remains until rename', { timeout: 10_000 }, async t => {
  const { path, record, store } = await fixture(t)
  const original = record('original')
  await store.save([original])
  const source = await fs.readFile(path, 'utf8')
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const order: string[] = []
  let active = 0
  let maximum = 0
  const rename = fs.rename
  t.mock.method(fs, 'rename', async (...[from, to]: Parameters<typeof fs.rename>) => {
    if (to !== path) return rename(from, to)
    active += 1
    maximum = Math.max(maximum, active)
    try {
      const staged = JSON.parse(await fs.readFile(from, 'utf8'))
      order.push(staged.workspaces[0].id)
      if (order.length === 1) {
        entered.resolve()
        await release.promise
      }
      return await rename(from, to)
    } finally { active -= 1 }
  })
  const first = store.save([record('first')])
  const secondInput = [record('second')]
  const expected = record('second')
  const second = store.save(secondInput)
  secondInput[0]!.title = 'mutated after save'
  secondInput[0]!.target.remotePath = '/mutated'
  secondInput.push(record('unrequested'))
  try {
    await entered.promise
    assert.equal(await fs.readFile(path, 'utf8'), source)
    assert.deepEqual(store.list(), [original])
  } finally { release.resolve() }
  await Promise.all([first, second])
  assert.equal(maximum, 1)
  assert.deepEqual(order, ['first', 'second'])
  assert.deepEqual(await new WorkspaceStore(path).load(), [expected])
})

test('a load queued after a save observes that save', async t => {
  const { record, store } = await fixture(t)
  const write = store.save([record()])
  const read = store.load()
  await write
  assert.deepEqual(await read, [record()])
})

test('permission/read errors propagate without discarding a loaded snapshot', async t => {
  const { path, record, store } = await fixture(t)
  const original = record()
  await store.save([original])
  const readFile = fs.readFile
  const failure = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    if (args[0] === path) throw Object.assign(new Error('read denied'), { code: 'EACCES' })
    return readFile(...args)
  })
  await assert.rejects(store.load(), /read denied/u)
  assert.deepEqual(store.list(), [original])
  failure.mock.restore()
  assert.deepEqual(await store.load(), [original])
})

test('saved ledger permissions are owner-only on POSIX', { skip: process.platform === 'win32' }, async t => {
  const { path, record, store } = await fixture(t)
  await store.save([record()])
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600)
  await store.save([{ ...record(), removedAt: 2 }])
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600)
})
