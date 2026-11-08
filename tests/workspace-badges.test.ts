import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { installWorkspaceBadges } from '../src/workspace-badges.js'
import type { WorkspaceView } from '../src/types.js'

const project = (workspaceId: string, patch: Partial<WorkspaceView> = {}): WorkspaceView => ({
  id: workspaceId, workspaceId, title: 'same-name', localPath: '', createdAt: 1,
  target: { kind: 'wsl', distribution: 'Ubuntu-22.04', remotePath: '/home/test/project' },
  registered: true, ...patch,
})
function row(document: Document, id: string): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute('role', 'treeitem')
  element.setAttribute('data-row-key', `workspace:${id}`)
  element.setAttribute('aria-expanded', 'false')
  element.innerHTML = '<span><svg></svg></span><span><svg></svg></span><span class="native-title-container"><span class="native-title">same-name</span></span><span><button>New session</button></span>'
  document.body.append(element)
  return element
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('project title icons use workspace IDs and cover legacy light WSL and full SSH', () => {
  const dom = new JSDOM('<body></body>')
  const { document } = dom.window
  const light = row(document, 'wsl-light')
  const full = row(document, 'dsh-remote:server:workspace')
  const local = row(document, 'local')
  const badges = installWorkspaceBadges(document)
  try {
    badges.update([project('wsl-light'), project('dsh-remote:server:workspace', {
      mode: 'full', target: { kind: 'ssh', host: 'dev-server', user: 'developer', port: 2222, remotePath: '/srv/project' },
    })])
    assert.match(light.querySelector('.dsh-ssh-project-badge')!.getAttribute('title')!, /WSL · Ubuntu-22\.04.*轻量模式/)
    const icon = full.querySelector('.dsh-ssh-project-badge')!
    assert.match(icon.getAttribute('title')!, /SSH · developer@dev-server:2222.*全量模式/)
    assert.equal(icon.getAttribute('aria-label'), icon.getAttribute('title'))
    assert.ok(icon.querySelector('svg path'))
    assert.equal(local.querySelector('.dsh-ssh-project-badge'), null)
    assert.equal(local.querySelector('.native-title-container')!.className, 'native-title-container')
    for (const item of [light, full, local]) assert.equal(item.querySelector('.native-title')!.textContent, 'same-name')
  } finally { badges.dispose(); dom.window.close() }
})

test('icons survive rerenders and recreated rows without duplicates and clean up on dispose', async () => {
  const dom = new JSDOM('<body></body>')
  const { document } = dom.window
  const badges = installWorkspaceBadges(document)
  try {
    badges.update([project('remote', { mode: 'full' })])
    let native = row(document, 'remote')
    await tick()
    const icon = native.querySelector('.dsh-ssh-project-badge')
    assert.ok(icon)
    for (let i = 0; i < 3; i++) {
      native.querySelector('.native-title')!.textContent = `renamed-${i}`
      native.setAttribute('aria-expanded', String(i % 2 === 0))
      await tick()
      assert.equal(native.querySelectorAll('.dsh-ssh-project-badge').length, 1)
      assert.equal(native.querySelector('.dsh-ssh-project-badge'), icon)
    }
    native.children[2]!.innerHTML = '<span class="native-title">replaced</span>'
    await tick()
    assert.equal(native.querySelectorAll('.dsh-ssh-project-badge').length, 1)
    native.remove()
    native = row(document, 'remote')
    await tick()
    assert.equal(native.querySelectorAll('.dsh-ssh-project-badge').length, 1)
    badges.dispose()
    assert.equal(document.querySelector('.dsh-ssh-project-badge'), null)
    assert.equal(document.querySelector('.dsh-ssh-project-label'), null)
    assert.equal(native.querySelector('.native-title')!.textContent, 'same-name')
    row(document, 'remote')
    await tick()
    assert.equal(document.querySelector('.dsh-ssh-project-badge'), null)
  } finally { badges.dispose(); dom.window.close() }
})

test('removed and unregistered projects lose their icons, reused local rows stay unmarked', async () => {
  const dom = new JSDOM('<body></body>')
  const { document } = dom.window
  const native = row(document, 'remote')
  const badges = installWorkspaceBadges(document)
  try {
    badges.update([project('remote')])
    native.setAttribute('data-row-key', 'workspace:local')
    await tick()
    assert.equal(native.querySelector('.dsh-ssh-project-badge'), null)
    native.setAttribute('data-row-key', 'workspace:remote')
    await tick()
    assert.ok(native.querySelector('.dsh-ssh-project-badge'))
    badges.update([project('remote', { registered: false })])
    assert.equal(native.querySelector('.dsh-ssh-project-badge'), null)
    badges.update([project('remote', { removedAt: 123 })])
    assert.equal(native.querySelector('.dsh-ssh-project-badge'), null)
    badges.update([])
    assert.equal(native.querySelector('.dsh-ssh-project-label'), null)
  } finally { badges.dispose(); dom.window.close() }
})

test('unexpected native structure is left untouched', () => {
  const dom = new JSDOM('<body><div role="treeitem" data-row-key="workspace:remote"><span>same-name</span></div></body>')
  const badges = installWorkspaceBadges(dom.window.document)
  try {
    const before = dom.window.document.body.innerHTML
    badges.update([project('remote')])
    assert.equal(dom.window.document.body.innerHTML, before)
  } finally { badges.dispose(); dom.window.close() }
})

test('live connection status updates the same sidebar icon and manual disconnection overrides stale online data', () => {
  const dom = new JSDOM('<body></body>')
  const native = row(dom.window.document, 'remote')
  const badges = installWorkspaceBadges(dom.window.document)
  try {
    badges.update([project('remote', { connectionState: 'connected' })])
    const icon = native.querySelector<HTMLElement>('.dsh-ssh-project-badge')!
    assert.equal(icon.dataset.connectionState, 'connected')
    assert.match(icon.title, /已连接/)
    for (const [state, text] of [['connecting', '连接中'], ['error', '连接异常'], ['disconnected', '未连接']] as const) {
      badges.update([project('remote', { connectionState: state })])
      assert.equal(native.querySelector('.dsh-ssh-project-badge'), icon)
      assert.equal(icon.dataset.connectionState, state)
      assert.ok(icon.title.includes(text))
      assert.equal(icon.getAttribute('aria-label'), icon.title)
    }
    badges.update([project('remote', { disconnected: true, online: true, connectionState: 'connected' })])
    assert.equal(icon.dataset.connectionState, 'disconnected')
    assert.equal(native.querySelectorAll('.dsh-ssh-project-badge').length, 1)
  } finally { badges.dispose(); dom.window.close() }
})
