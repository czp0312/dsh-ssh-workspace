import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { Script, createContext } from 'node:vm'
import { JSDOM } from 'jsdom'

// Exercise the published classic-script entry, including DSH's require boundary.
// Import ReactDOM after installing the DOM so React enables native input events.
const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost' })
const { window } = dom
for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : window[key] })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createElement, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const require = createRequire(import.meta.url)
const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
test.after(() => dom.window.close())

async function mount({ respond, initialSaved = [], hostPaths } = {}) {
  const calls = []
  const opened = []
  const saved = [...initialSaved]
  const cleanup = []
  const slots = new Map()
  const imported = []
  let definition
  const context = createContext({
    window: { __ModuleLoader__: { load: entry => { definition = entry } } },
    document: window.document, HTMLElement: window.HTMLElement, Node: window.Node,
    AbortController, queueMicrotask, console, setInterval, clearInterval,
    __DSH_HOST_PATHS__: hostPaths,
  })
  new Script(bundle, { filename: 'lib/client.js' }).runInContext(context)
  assert.equal(definition?.id, manifest.name)
  const plugin = definition.factory(id => {
    imported.push(id)
    assert.ok(['react', 'react/jsx-runtime'].includes(id), `Unexpected browser dependency: ${id}`)
    return require(id)
  })
  assert.deepEqual(Array.from(plugin.inject), ['connection', 'slots', 'uiWorkspace', 'layout', 'fileUpload'])
  assert.equal(typeof plugin.apply, 'function')
  let main
  const selectPanel = id => {
    if (!main) throw new Error('Main panel has not registered')
    main.root.render(id === main.options.key ? createElement(main.Component, main.options.inject()) : null)
  }
  const navigation = { startSession: id => { opened.push(id); selectPanel(null) } }
  const host = {
    effect(setup) { const dispose = setup(); if (typeof dispose === 'function') cleanup.push(dispose) },
    get(name) { return name === 'uiWorkspace' ? navigation : name === 'layout' ? { selectPanel } : undefined },
    slots: {
      inject(_name, setup) { return setup() },
      register(options, Component) {
        assert.ok(['sidebar.panellist', 'main'].includes(options.name))
        if (options.name === 'main') assert.equal(options.key, 'dsh-ssh-workspaces', 'native main is a keyed slot')
        const element = document.createElement('div')
        document.body.append(element)
        const root = createRoot(element)
        if (options.name === 'main') main = { root, options, Component }
        else root.render(createElement('button', { onClick: () => selectPanel(options.id), title: options.label }, createElement(Component, options.inject()), options.label))
        slots.set(options.name, element)
        const dispose = () => { root.unmount(); element.remove() }
        cleanup.push(dispose)
        return dispose
      },
    },
    connection: { rpc: { async call(channel, endpoint, input, signal) {
      assert.equal(channel, '/api')
      assert.ok(endpoint.startsWith('dsh-ssh-workspaces/'))
      assert.ok(signal instanceof AbortSignal)
      const method = endpoint.slice('dsh-ssh-workspaces/'.length)
      calls.push({ method, input: JSON.parse(JSON.stringify(input)), signal })
      if (respond) {
        const result = respond(method, input, signal)
        if (result !== undefined) return result
      }
      switch (method) {
        case 'status': return { ok: true, value: { pluginVersion: manifest.version, verifiedDshVersion: '0.2.2-rc.1', platform: 'win32', workspaces: [...saved] } }
        case 'wsl/list': return { ok: true, value: ['Ubuntu-22.04'] }
        case 'browse': return { ok: true, value: { path: input.path, directories: ['subproject'] } }
        case 'test': return { ok: true, value: { path: input.target.remotePath, home: '/home/test', user: 'test', platform: 'Linux', python: '3.10.12' } }
        case 'add': {
          const record = { id: 'remote-1', workspaceId: 'native-1', mode: input.mode, title: input.title || 'project', target: input.target, localPath: '\\\\wsl.localhost\\Ubuntu-22.04\\home\\test\\project', createdAt: 1, registered: true, connectionState: 'connected', online: true }
          saved.push(record)
          return { ok: true, value: record }
        }
        default: throw new Error(`Unexpected method: ${method}`)
      }
    } } },
  }
  await act(async () => { plugin.apply(host) })
  return {
    calls, opened, imported, saved, slots,
    async dispose() { await act(async () => { for (const dispose of cleanup.reverse()) dispose() }) },
  }
}

const button = (text, root = document) => {
  const found = [...root.querySelectorAll('button')].find(element => element.textContent.trim() === text || element.getAttribute('aria-label') === text || element.title === text)
  assert.ok(found, `Missing button: ${text}`)
  return found
}
const click = async element => { await act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }) }
const input = async (suffix, value) => {
  const element = document.querySelector(`input[id$="-${suffix}"]`)
  assert.ok(element, `Missing input: ${suffix}`)
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}
const select = async (suffix, value) => {
  const element = document.querySelector(`select[id$="-${suffix}"]`)
  assert.ok(element, `Missing select: ${suffix}`)
  await act(async () => { element.value = value; element.dispatchEvent(new window.Event('change', { bubbles: true })) })
}

test('published classic script registers a native sidebar panel outside the account menu', async () => {
  const fixture = await mount()
  try {
    assert.ok(fixture.imported.includes('react'))
    assert.ok(fixture.imported.includes('react/jsx-runtime'))
    assert.equal(document.querySelectorAll('style[data-dsh-ssh-workspaces]').length, 1)
    assert.equal(document.querySelector('[role="dialog"]'), null)
    const opener = button('远程工作区')
    assert.deepEqual([...fixture.slots.keys()], ['sidebar.panellist', 'main'])
    await click(opener)
    assert.ok(document.querySelector('[role="region"]'))
    assert.equal(document.querySelector('[role="dialog"]'), null)
    assert.match(document.querySelector('.dsh-ssh__intro').textContent, /完整|远程 DSH 后端/)
    assert.equal(fixture.calls[0].method, 'status')
    await click(button('关闭远程工作区管理'))
    assert.equal(document.querySelector('[role="region"]'), null)
  } finally { await fixture.dispose() }
  assert.equal(document.querySelector('style[data-dsh-ssh-workspaces]'), null)
})

test('published plugin marks a remote project before opening its manager and removes icons on unload', async () => {
  const native = document.createElement('div')
  native.setAttribute('role', 'treeitem')
  native.setAttribute('data-row-key', 'workspace:existing-wsl')
  native.innerHTML = '<span></span><span></span><span><span>Existing project</span></span><span></span>'
  document.body.append(native)
  const fixture = await mount({ initialSaved: [{
    id: 'existing', workspaceId: 'existing-wsl', registered: true,
    target: { kind: 'wsl', distribution: 'Ubuntu-22.04' },
  }] })
  try {
    assert.equal(document.querySelector('[role="region"]'), null)
    assert.match(native.querySelector('.dsh-ssh-project-badge').title, /WSL.*轻量模式/)
  } finally { await fixture.dispose() }
  assert.equal(native.querySelector('.dsh-ssh-project-badge'), null)
  assert.equal(native.querySelector('span:nth-child(3)').className, '')
  native.remove()
})

test('WSL browse, test, add and navigation use native current-window services', async () => {
  const fixture = await mount()
  try {
    await click(button('远程工作区'))
    await click(button('WSL'))
    assert.equal(document.querySelector('select').value, 'Ubuntu-22.04')
    await input('path', '/home/test/project')
    await input('title', 'WSL project')
    await click(button('浏览目录'))
    assert.ok(button('subproject'))
    await click(button('测试连接'))
    assert.match(document.querySelector('.dsh-ssh__success').textContent, /Linux.*Python 3\.10\.12/)
    await click(button('添加到工作区'))
    const request = fixture.calls.find(call => call.method === 'add')
    assert.deepEqual(request.input, { target: { kind: 'wsl', distribution: 'Ubuntu-22.04', remotePath: '/home/test/project' }, mode: 'full', title: 'WSL project' })
    assert.match(document.querySelector('.dsh-ssh__registration').textContent, /已连接/)
    await click(button('在当前窗口打开 WSL project'))
    assert.deepEqual(fixture.opened, ['native-1'])
    assert.equal(document.querySelector('[role="region"]'), null)
  } finally { await fixture.dispose() }
})

test('RPC errors remain visible and closing aborts and ignores late responses', async () => {
  let finish
  const fixture = await mount({ respond(method) {
    if (method === 'test') return { ok: false, error: { message: 'Remote directory unavailable' } }
    if (method === 'browse') return new Promise(resolve => { finish = resolve })
  } })
  try {
    await click(button('远程工作区'))
    await click(button('WSL'))
    await click(button('测试连接'))
    assert.equal(document.querySelector('[role="alert"]').textContent, 'Remote directory unavailable')
    await click(button('浏览目录'))
    const pending = fixture.calls.find(call => call.method === 'browse')
    assert.equal(pending.signal.aborted, false)
    await click(button('关闭远程工作区管理'))
    assert.equal(pending.signal.aborted, true)
    await act(async () => { finish({ ok: true, value: { path: '/late', directories: ['late-result'] } }) })
    await click(button('远程工作区'))
    assert.equal(document.querySelector('.dsh-ssh__browser'), null)
  } finally { await fixture.dispose() }
})

test('SSH project setup deploys a backend without asking for an SSHFS mount', async () => {
  const fixture = await mount()
  try {
    await click(button('远程工作区'))
    await input('host', 'dev-alias')
    await input('path', '/srv/project')
    assert.equal(document.querySelector('input[id$="-localPath"]'), null)
    await click(button('添加到工作区'))
    assert.deepEqual(fixture.calls.find(call => call.method === 'add').input, { target: { kind: 'ssh', host: 'dev-alias', remotePath: '/srv/project' }, mode: 'full' })
    assert.match(document.querySelector('.dsh-ssh__form-footer').textContent, /远端 DSH.*不自动复制本机密钥/)
  } finally { await fixture.dispose() }
})

test('SSH explicit key paths are used by connection tests, directory browsing and full backend setup', async () => {
  const fixture = await mount()
  try {
    await click(button('远程工作区'))
    await input('host', 'dev-alias')
    await select('sshAuth', 'key')
    assert.equal(button('选择密钥文件').disabled, true, 'web clients can enter paths manually')
    await click(button('测试连接'))
    assert.match(document.querySelector('[role="alert"]').textContent, /私钥文件路径/)
    assert.equal(fixture.calls.some(call => call.method === 'test'), false)
    await input('identityFile', 'C:\\Keys with spaces\\dev.pem')
    await click(button('测试连接'))
    await click(button('浏览目录'))
    await click(button('添加到工作区'))
    for (const method of ['test', 'browse', 'add']) assert.equal(fixture.calls.find(call => call.method === method).input.target.identityFile, 'C:\\Keys with spaces\\dev.pem')
    assert.match(document.querySelector('.dsh-ssh__connection').textContent, /密钥：C:\\Keys with spaces\\dev.pem/)
  } finally { await fixture.dispose() }
})

test('native private-key file selection uses only the host path bridge', async () => {
  let selected
  const fixture = await mount({ hostPaths: { pathFor(file) { selected = file; return 'C:\\Keys\\dev.pem' } } })
  try {
    await click(button('远程工作区'))
    await select('sshAuth', 'key')
    assert.equal(button('选择密钥文件').disabled, false)
    const file = new window.File(['synthetic test data'], 'dev.pem')
    file.text = file.arrayBuffer = () => { throw new Error('Private key contents must not be read') }
    const picker = document.querySelector('input[type="file"]')
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] })
    await act(async () => { picker.dispatchEvent(new window.Event('change', { bubbles: true })) })
    assert.equal(selected, file)
    assert.equal(document.querySelector('input[id$="-identityFile"]').value, 'C:\\Keys\\dev.pem')
    assert.equal(fixture.calls.some(call => /upload/.test(call.method)), false)
  } finally { await fixture.dispose() }
})

test('all four login modes mask secrets and password authentication keeps credentials outside the target', async () => {
  const fixture = await mount()
  try {
    await click(button('远程工作区'))
    assert.deepEqual([...document.querySelector('select[id$="-sshAuth"]').options].map(item => item.textContent), ['自动选择', '仅密码', '密钥', '证书'])
    await input('host', 'test-host')
    await select('sshAuth', 'password')
    assert.equal(document.querySelector('input[id$="-identityFile"]'), null)
    assert.equal(document.querySelector('input[id$="-password"]').type, 'password')
    await click(button('测试连接'))
    assert.equal(fixture.calls.some(call => call.method === 'test'), false)
    await input('password', 'synthetic-password')
    await click(button('测试连接')); await click(button('浏览目录')); await click(button('添加到工作区'))
    for (const method of ['test', 'browse', 'add']) {
      const payload = fixture.calls.find(call => call.method === method).input
      assert.equal(payload.target.auth, 'password'); assert.deepEqual(payload.credentials, { password: 'synthetic-password' })
      assert.equal(JSON.stringify(payload.target).includes('synthetic-password'), false)
    }
    assert.equal(JSON.stringify(fixture.saved).includes('synthetic-password'), false)
    assert.equal(document.querySelector('input[id$="-password"]').value, '')
  } finally { await fixture.dispose() }
})

test('certificates require both certificate and private key, and hidden credentials never cross login-mode boundaries', async () => {
  const fixture = await mount()
  try {
    await click(button('远程工作区')); await input('host', 'test-host')
    await input('password', 'hidden-password'); await select('sshAuth', 'certificate')
    await input('identityFile', 'C:\\Keys\\test.key'); await input('passphrase', 'synthetic-passphrase')
    await click(button('测试连接')); assert.equal(fixture.calls.some(call => call.method === 'test'), false)
    await input('certificateFile', 'C:\\Keys\\test-cert.pub'); await click(button('测试连接'))
    const call = fixture.calls.find(call => call.method === 'test')
    assert.equal(call.input.target.auth, 'certificate'); assert.equal(call.input.target.certificateFile, 'C:\\Keys\\test-cert.pub')
    assert.deepEqual(call.input.credentials, { passphrase: 'synthetic-passphrase' })
    await select('sshAuth', 'password'); await click(button('测试连接'))
    const password = fixture.calls.filter(call => call.method === 'test').at(-1).input
    assert.equal(password.target.identityFile, undefined); assert.equal(password.target.certificateFile, undefined)
    assert.deepEqual(password.credentials, { password: 'hidden-password' })
    await click(button('WSL')); await click(button('测试连接'))
    assert.equal(fixture.calls.filter(call => call.method === 'test').at(-1).input.credentials, undefined)
  } finally { await fixture.dispose() }
})

test('saved password projects can receive new in-memory credentials without re-creating the workspace', async () => {
  const row = { id: 'saved-ssh', workspaceId: 'native-ssh', title: 'saved-password-project', mode: 'light', target: { kind: 'ssh', host: 'test-host', auth: 'password', remotePath: '/srv/project' }, registered: true }
  const fixture = await mount({ initialSaved: [row], respond(method, input) { if (method === 'reconnect') return { ok: true, value: row } } })
  try {
    await click(button('远程工作区')); await click(button('设置 saved-password-project 的连接模式'))
    const secret = document.querySelector('.dsh-ssh__credentials input[type="password"]')
    assert.ok(secret)
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(secret, 'synthetic-new-password'); secret.dispatchEvent(new window.Event('input', { bubbles: true })) })
    await act(async () => document.querySelector('.dsh-ssh__credentials').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    assert.deepEqual(fixture.calls.find(call => call.method === 'reconnect').input, { id: 'saved-ssh', credentials: { password: 'synthetic-new-password' } })
    assert.equal(fixture.calls.some(call => call.method === 'add'), false)
    assert.equal(document.querySelector('.dsh-ssh__credentials'), null)
  } finally { await fixture.dispose() }
})

test('switching to auto authentication or WSL never submits the hidden SSH key path', async () => {
  const fixture = await mount()
  try {
    await click(button('远程工作区'))
    await input('host', 'dev-alias')
    await select('sshAuth', 'key')
    await input('identityFile', 'C:\\Keys\\dev.pem')
    await click(document.querySelector('input[value="light"]'))
    assert.equal(document.querySelector('input[id$="-localPath"]').required, true)
    assert.match(document.querySelector('.dsh-ssh__new').textContent, /同一凭据建立 SSHFS 挂载/)
    await select('sshAuth', 'auto')
    await click(button('测试连接'))
    assert.equal(Object.hasOwn(fixture.calls.find(call => call.method === 'test').input.target, 'identityFile'), false)
    await click(button('WSL'))
    assert.equal(document.querySelector('input[id$="-identityFile"]'), null)
    await click(button('测试连接'))
    assert.equal(Object.hasOwn(fixture.calls.filter(call => call.method === 'test').at(-1).input.target, 'identityFile'), false)
    await click(button('SSH'))
    await select('sshAuth', 'key')
    assert.equal(document.querySelector('input[id$="-identityFile"]').value, 'C:\\Keys\\dev.pem')
  } finally { await fixture.dispose() }
})

test('SSH and WSL each remember their mode and lightweight WSL sends no deployment request', async () => {
  const fixture = await mount()
  try {
    await click(button('远程工作区'))
    await click(document.querySelector('input[type="radio"][value="light"]'))
    assert.ok(document.querySelector('input[id$="-localPath"]'))
    assert.match(document.querySelector('.dsh-ssh__intro').textContent, /远端不安装 DSH/)
    await click(button('WSL'))
    assert.equal(document.querySelector('input[value="full"]').checked, true)
    await click(document.querySelector('input[type="radio"][value="light"]'))
    assert.equal(document.querySelector('input[id$="-localPath"]'), null)
    await input('path', '/home/test/project')
    await click(button('SSH'))
    assert.equal(document.querySelector('input[value="light"]').checked, true)
    await click(button('WSL'))
    await click(button('添加到工作区'))
    assert.deepEqual(fixture.calls.find(call => call.method === 'add').input, { target: { kind: 'wsl', distribution: 'Ubuntu-22.04', remotePath: '/home/test/project' }, mode: 'light' })
    assert.match(document.querySelector('.dsh-ssh__connection').textContent, /轻量.*本机 Agent/)
    assert.match(document.querySelector('.dsh-ssh__form-footer').textContent, /不安装 DSH.*Native/)
  } finally { await fixture.dispose() }
})

test('switching back to full mode excludes a previously entered mount path', async () => {
  const fixture = await mount()
  try {
    await click(button('远程工作区'))
    await input('host', 'dev-alias')
    await click(document.querySelector('input[value="light"]'))
    await input('localPath', 'Z:\\project')
    await click(document.querySelector('input[value="full"]'))
    await click(button('添加到工作区'))
    const request = fixture.calls.find(call => call.method === 'add').input
    assert.equal(request.mode, 'full')
    assert.equal(Object.hasOwn(request, 'localPath'), false)
  } finally { await fixture.dispose() }
})

test('disconnect keeps a saved folder, changes its state and offers explicit reconnection', async () => {
  const row = { id: 'remote-1', workspaceId: 'native-1', title: 'saved-project', mode: 'light', target: { kind: 'wsl', distribution: 'Ubuntu-22.04', remotePath: '/home/test/project' }, localPath: 'Z:\\project', registered: true, connectionState: 'connected', online: true }
  const fixture = await mount({ initialSaved: [row], respond(method) {
    if (method === 'disconnect') { Object.assign(row, { disconnected: true, connectionState: 'disconnected', online: false }); return { ok: true, value: null } }
    if (method === 'reconnect') { Object.assign(row, { disconnected: false, connectionState: 'connected', online: true }); return { ok: true, value: row } }
  } })
  try {
    await click(button('远程工作区'))
    assert.equal(button('在当前窗口打开 saved-project').disabled, false)
    await click(button('断开 saved-project'))
    assert.equal(fixture.calls.some(call => call.method === 'remove'), false)
    assert.equal(document.querySelector('.dsh-ssh__connection').dataset.connectionState, 'disconnected')
    assert.equal(button('在当前窗口打开 saved-project').disabled, true)
    assert.match(document.querySelector('.dsh-ssh__notice').textContent, /挂载不卸载/)
    await click(button('连接 saved-project'))
    assert.equal(document.querySelector('.dsh-ssh__connection').dataset.connectionState, 'connected')
    assert.equal(fixture.calls.some(call => call.method === 'add'), false)
  } finally { await fixture.dispose() }
})

test('saved connection settings choose a different mode without editing the original history identity', async () => {
  const row = { id: 'remote-light', workspaceId: 'original-local', title: 'mode-project', mode: 'light', target: { kind: 'wsl', distribution: 'Ubuntu-22.04', remotePath: '/home/test/project' }, localPath: 'Z:\\project', registered: true, connectionState: 'connected' }
  let fixture
  fixture = await mount({ initialSaved: [row], respond(method, input) {
    if (method === 'reconnect') { const full = { ...row, id: 'remote-full', workspaceId: 'dsh-remote:host:project', mode: 'full' }; fixture.saved.push(full); return { ok: true, value: full } }
  } })
  try {
    await click(button('远程工作区')); await click(button('设置 mode-project 的连接模式'))
    await select('mode', 'full')
    assert.equal(fixture.calls.some(call => call.method === 'reconnect'), false, 'a selection is only applied on submit')
    assert.match(document.querySelector('.dsh-ssh__credentials').textContent, /不会迁移旧会话/)
    await act(async () => document.querySelector('.dsh-ssh__credentials').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    assert.deepEqual(fixture.calls.find(call => call.method === 'reconnect').input, { id: 'remote-light', mode: 'full' })
    assert.equal(fixture.saved[0].workspaceId, 'original-local')
    assert.equal(document.querySelectorAll('.dsh-ssh__connection').length, 2)
    assert.equal(fixture.calls.some(call => call.method === 'remove' || call.method === 'disconnect'), false)
    assert.match(document.querySelector('.dsh-ssh__notice').textContent, /原模式入口与会话历史保留/)
  } finally { await fixture.dispose() }
})

test('a failed full-to-light connection preserves the full project and allows mount-path correction', async () => {
  const row = { id: 'remote-full', workspaceId: 'dsh-remote:host:project', title: 'full-project', mode: 'full', target: { kind: 'ssh', host: 'test-host', remotePath: '/project' }, localPath: '/project', registered: true, connectionState: 'connected' }
  const fixture = await mount({ initialSaved: [row], respond(method) { if (method === 'reconnect') return { ok: false, error: { message: '本机挂载目录与远程目录不一致' } } } })
  try {
    await click(button('远程工作区')); await click(button('设置 full-project 的连接模式'))
    await select('mode', 'light')
    const mount = document.querySelector('input[id$="-mount"]')
    assert.equal(mount.value, '', 'a remote POSIX path must never be mistaken for a local mount path')
    await input('mount', 'Z:\\mapped-project')
    await act(async () => document.querySelector('.dsh-ssh__credentials').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    assert.deepEqual(fixture.calls.find(call => call.method === 'reconnect').input, { id: 'remote-full', mode: 'light', localPath: 'Z:\\mapped-project' })
    assert.equal(document.querySelectorAll('.dsh-ssh__connection').length, 1)
    assert.ok(document.querySelector('.dsh-ssh__credentials'))
    assert.equal(fixture.saved[0].mode, 'full')
    assert.equal(button('在当前窗口打开 full-project').disabled, false)
    assert.match(document.querySelector('[role="alert"]').textContent, /不一致/)
  } finally { await fixture.dispose() }
})

test('a persisted registration alone never displays a green online state', async () => {
  const fixture = await mount({ initialSaved: [{ id: 'old', workspaceId: 'native-old', mode: 'light', title: 'legacy-project', registered: true, target: { kind: 'wsl', distribution: 'Ubuntu-22.04', remotePath: '/project' } }] })
  try {
    await click(button('远程工作区'))
    assert.match(document.querySelector('.dsh-ssh__registration').textContent, /未连接/)
    assert.equal(document.querySelector('.dsh-ssh__connection').dataset.connectionState, 'disconnected')
    assert.equal(button('连接 legacy-project').disabled, false)
  } finally { await fixture.dispose() }
})
