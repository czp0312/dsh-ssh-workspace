import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const log = await readFile(resolve(process.argv[2] ?? '.test-artifacts/server.log'), 'utf8')
const launch = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)?.[0]
assert.ok(launch, 'The isolated DSH server has not started')
const origin = new URL(launch).origin
const login = await fetch(launch, { redirect: 'manual' })
const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
assert.ok(cookie, 'DSH did not issue a browser credential')

async function rpc(endpoint, payload = {}, authenticated = true) {
  const method = `dsh-ssh-workspaces/${endpoint}`
  const rpcId = randomUUID()
  const response = await fetch(`${origin}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, ...(authenticated ? { cookie } : {}) },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  if (!authenticated) return response
  assert.equal(response.status, 200, `RPC ${endpoint} failed: HTTP ${response.status}`)
  const envelope = await response.json()
  assert.equal(envelope.rpcId, rpcId)
  assert.ok(envelope.result.ok, envelope.result.error?.message)
  return envelope.result.value
}

assert.equal((await rpc('status', {}, false)).status, 401)
const before = await rpc('status')
const distros = await rpc('wsl/list')
assert.ok(distros.includes('Ubuntu-22.04'))
const target = { kind: 'wsl', distribution: 'Ubuntu-22.04', remotePath: '/' }
const info = await rpc('test', { target })
target.remotePath = info.home
const record = await rpc('add', { target, mode: 'light', title: 'WSL 插件隔离测试' })
const duplicate = await rpc('add', { target, mode: 'light' })
assert.equal(record.id, duplicate.id)
assert.equal(record.workspaceId, duplicate.workspaceId)
const added = await rpc('status')
assert.equal(added.workspaces.find(row => row.id === record.id)?.registered, true)
assert.match(record.localPath, /^\\\\wsl\.localhost\\/i)
if (process.argv.includes('--agent')) {
  const response = await fetch(`${origin}/api/dsh-ssh-test-agent`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify({ cwd: record.localPath }),
  })
  const body = await response.text()
  assert.equal(response.status, 200, body)
  // The fixture route creates an idle native Agent; no model request or user credential is used.
  const proof = JSON.parse(body)
  assert.deepEqual(proof, { remoteTool: true, localShellBlocked: true, rootUnaffected: true })
}
const state = JSON.parse(await readFile(resolve('.test-artifacts/dsh-home/ssh-workspaces.json'), 'utf8'))
assert.equal(state.workspaces.find(row => row.id === record.id)?.workspaceId, record.workspaceId)
await rpc('remove', { id: record.id })
assert.equal((await rpc('status')).workspaces.some(row => row.id === record.id), false)
const tombstones = JSON.parse(await readFile(resolve('.test-artifacts/dsh-home/ssh-workspaces.json'), 'utf8'))
assert.ok(tombstones.workspaces.find(row => row.id === record.id)?.removedAt)
console.log(JSON.stringify({ pluginVersion: before.pluginVersion, dshVersion: before.verifiedDshVersion, authentication: 'passed', distribution: target.distribution, nativeWorkspaceRegistration: 'passed', duplicateAdd: 'passed', removalAndOldSessionRouting: 'passed' }, null, 2))
