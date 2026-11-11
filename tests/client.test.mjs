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

async function mount({ respond, initialSaved = [], hostPaths, navigate } = {}) {
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
  assert.deepEqual(Array.from(plugin.inject), ['connection'])
  assert.equal(typeof plugin.apply, 'function')
  let main
  const selectPanel = id => {
    if (!main) throw new Error('Main panel has not registered')
    main.root.render(id === main.options.key ? createElement(main.Component, main.options.inject()) : null)
  }
  const navigation = { async openWorkspace(id) { if (navigate) await navigate(id); opened.push(id); selectPanel(null) }, startSession: id => { throw new Error('Use the awaitable native navigation, not the fire-and-forget shortcut') } }
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

/** A synthetic OpenSSH SHA256 fingerprint: the prefix plus 43 unpadded base64 characters. */
const fingerprint = letter => `SHA256:${letter.repeat(43)}`

const groupedRow = (id, changes = {}) => ({ id, workspaceId: `native-${id}`, title: id, mode: 'full', backendId: 'shared', registered: true, connectionState: 'connected', backendHealth: { connectionState: 'connected' }, target: { kind: 'wsl', distribution: 'DemoLinux', remotePath: `/srv/${id}` }, ...changes })

test('one environment lists mixed modes together and switching one project never marks siblings as reconnecting', async () => {
  const rows = [groupedRow('api'), groupedRow('worker'), groupedRow('tools', { mode: 'light', backendId: undefined })]
  const before = structuredClone(rows)
  let finish
  const fixture = await mount({ initialSaved: rows, respond(method) {
    if (method === 'reconnect') return new Promise(resolve => { finish = resolve })
  } })
  try {
    await click(button('远程工作区'))
    const list = document.querySelector('.dsh-ssh__projects')
    assert.equal(list.querySelectorAll('.dsh-ssh__connection').length, 3)
    assert.deepEqual([...list.querySelectorAll('[data-mode]')].map(item => item.dataset.mode), ['full', 'full', 'light'])
    assert.equal(document.querySelector('.dsh-ssh__backend').querySelector('.dsh-ssh__connection'), null, 'connection controls do not own the project list')
    assert.equal(list.querySelectorAll('button[aria-label$=的连接模式]').length, 3)
    await click(button('设置 api 的连接模式'))
    assert.match(document.querySelector('.dsh-ssh__credentials').textContent, /仅为「api」选择模式.*其他项目保持原模式/)
    await select('mode', 'light')
    await act(async () => document.querySelector('.dsh-ssh__credentials').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    assert.deepEqual(fixture.calls.find(call => call.method === 'reconnect').input, { id: 'api', mode: 'light' })
    assert.equal(document.querySelector('.dsh-ssh__backend').getAttribute('aria-busy'), 'false')
    assert.equal(document.querySelector('[data-project-id=worker]').dataset.connectionState, 'connected')
    assert.equal(document.querySelector('[data-project-id=tools]').dataset.connectionState, 'connected')
    assert.equal(button('断开 DemoLinux 的全量连接').textContent, '断开连接', 'a mode switch is not a cancellable shared reconnect')
    assert.equal(button('断开 DemoLinux 的全量连接').disabled, true)
    assert.deepEqual(rows, before)
    await act(async () => finish({ ok: true, value: { ...rows[0], id: 'api-light', workspaceId: 'native-api-light', mode: 'light', backendId: undefined } }))
    assert.equal(fixture.calls.some(call => ['connection/reconnect', 'disconnect', 'remove'].includes(call.method)), false)
    assert.equal(document.querySelector('[data-project-id=worker] [data-mode]').dataset.mode, 'full')
    assert.deepEqual(rows, before, 'mode switching leaves every existing identity and history intact')
  } finally { await fixture.dispose() }
})

test('shared actions affect the complete group even with filtered projects', async () => {
  const rows = [groupedRow('api'), groupedRow('worker'), groupedRow('other', { backendId: 'root' }), groupedRow('light', { mode: 'light', backendId: undefined })]
  const fixture = await mount({ initialSaved: rows, respond(method) {
    if (method === 'disconnect') { rows.filter(row => row.backendId === 'shared').forEach(row => Object.assign(row, { disconnected: true, connectionState: 'disconnected', backendHealth: { connectionState: 'disconnected' } })); return { ok: true, value: null } }
  } })
  try {
    await click(button('远程工作区'))
    assert.equal(document.querySelectorAll('.dsh-ssh__environment').length, 1)
    assert.equal(document.querySelectorAll('.dsh-ssh__backend').length, 2)
    assert.equal(document.querySelectorAll('.dsh-ssh__connection [aria-label^=断开]').length, 1)
    const field = document.querySelector('input[type=search]')
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(field, 'worker'); field.dispatchEvent(new window.Event('input', { bubbles: true })) })
    assert.equal(document.querySelectorAll('.dsh-ssh__connection').length, 1)
    assert.match(document.querySelector('.dsh-ssh__environment-note').textContent, /隐藏了 1 个受影响项目/)
    await click(button('断开连接'))
    assert.deepEqual(fixture.calls.filter(call => call.method === 'disconnect').map(call => call.input), [{ id: 'api' }])
    assert.equal(rows[2].connectionState, 'connected')
    assert.equal(rows[3].connectionState, 'connected')
    assert.match(document.querySelector('.dsh-ssh__notice').textContent, /2 个项目离线/)
    assert.match(document.querySelector('.dsh-ssh__environment-name').textContent, /部分连接/)
    assert.equal(rows[1].workspaceId, 'native-worker')
  } finally { await fixture.dispose() }
})

test('pending shared reconnect reaches every child and can be cancelled once', async () => {
  const rows = [groupedRow('api', { disconnected: true }), groupedRow('worker', { disconnected: true })]
  const fixture = await mount({ initialSaved: rows, respond(method, payload, signal) {
    if (method === 'connection/reconnect') return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    if (method === 'disconnect') return { ok: true, value: null }
  } })
  try {
    await click(button('远程工作区')); await click(button('连接 DemoLinux 的全量连接'))
    assert.equal(fixture.calls.filter(call => call.method === 'connection/reconnect').length, 1)
    assert.ok([...document.querySelectorAll('.dsh-ssh__connection')].every(item => item.dataset.connectionState === 'connecting'))
    await click(button('取消连接'))
    assert.equal(fixture.calls.find(call => call.method === 'connection/reconnect').signal.aborted, true)
    assert.equal(fixture.calls.filter(call => call.method === 'disconnect').length, 1)
    assert.ok([...document.querySelectorAll('.dsh-ssh__connection')].every(item => item.dataset.connectionState === 'disconnected'))
  } finally { await fixture.dispose() }
})

test('missing registration keeps backend controls and connection auth cannot switch modes', async () => {
  const rows = [groupedRow('missing', { registered: false, connectionState: 'error', target: { kind: 'ssh', host: 'demo', auth: 'password', remotePath: '/gone' } }), groupedRow('api', { target: { kind: 'ssh', host: 'demo', auth: 'password', remotePath: '/srv/api' } })]
  const fixture = await mount({ initialSaved: rows, respond(method) { if (method === 'connection/reconnect') return { ok: true, value: null } } })
  try {
    await click(button('远程工作区'))
    assert.equal(button('断开连接').disabled, false)
    assert.equal(button('重新添加 missing 的目录').disabled, false)
    await click(button('连接认证'))
    assert.equal(document.querySelector('select[id$="-mode"]'), null)
    assert.match(document.querySelector('.dsh-ssh__credentials').textContent, /不修改项目模式/)
    await act(async () => document.querySelector('.dsh-ssh__credentials').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })))
    assert.deepEqual(fixture.calls.find(call => call.method === 'connection/reconnect').input, { id: 'missing', force: true })
    assert.equal(fixture.calls.some(call => call.method === 'reconnect'), false)
    assert.equal(rows[0].registered, false)
  } finally { await fixture.dispose() }
})

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
    assert.match(document.querySelector('.dsh-ssh__form-footer').textContent, /远端 DSH.*不自动复制本机密钥/)
    await click(button('添加到工作区'))
    assert.deepEqual(fixture.calls.find(call => call.method === 'add').input, { target: { kind: 'ssh', host: 'dev-alias', remotePath: '/srv/project' }, mode: 'full' })
    assert.equal(document.querySelector('.dsh-ssh__new'), null, 'successful add returns to projects')
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
    await click(button('连接认证'))
    assert.match(document.querySelector('.dsh-ssh__credentials').textContent, /密钥.*C:\\Keys with spaces\\dev.pem/)
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
    await click(button('添加项目'))
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
    assert.match(document.querySelector('.dsh-ssh__form-footer').textContent, /不安装 DSH.*Native/)
    await click(button('添加到工作区'))
    assert.deepEqual(fixture.calls.find(call => call.method === 'add').input, { target: { kind: 'wsl', distribution: 'Ubuntu-22.04', remotePath: '/home/test/project' }, mode: 'light' })
    assert.match(document.querySelector('.dsh-ssh__connection').textContent, /轻量.*本机 Agent/)
    assert.equal(document.querySelector('.dsh-ssh__new'), null)
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
    assert.equal(document.querySelector('[aria-label="在当前窗口打开 saved-project"]'), null, 'offline projects offer Connect, not an unusable Open action')
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
    assert.match(document.querySelector('.dsh-ssh__scope').textContent, /Agent 与模型：本机 DSH/)
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

test('Docker supports context discovery, a separate SSH engine identity, and lightweight shared paths', async () => {
  const containerId = 'a'.repeat(64)
  const fixture = await mount({ respond(method) {
    if (method === 'docker/list') return { ok: true, value: [{ id: containerId, name: 'demo-api', image: 'demo:latest', state: 'running', status: 'Up' }] }
  } })
  try {
    await click(button('远程工作区')); await click(button('DOCKER'))
    await input('context', 'development')
    await click(button('读取容器'))
    assert.deepEqual(fixture.calls.find(call => call.method === 'docker/list').input, { context: 'development' })
    await click(document.querySelector('.dsh-ssh__container-list button'))
    assert.equal(document.querySelector('input[id$="-container"]').value, containerId)
    await select('dockerLocation', 'ssh')
    await input('host', 'docker-host'); await input('port', '2222'); await input('user', 'developer')
    await input('dockerUser', 'app-user')
    await select('sshAuth', 'password'); await input('password', 'synthetic-docker-password')
    await input('path', '/workspace/demo')
    await click(button('测试连接'))
    const tested = fixture.calls.find(call => call.method === 'test').input
    assert.deepEqual(tested.target, { kind: 'docker', container: containerId, user: 'app-user', remotePath: '/workspace/demo', via: { kind: 'ssh', host: 'docker-host', port: 2222, user: 'developer', auth: 'password', remotePath: '/' } })
    assert.deepEqual(tested.credentials, { password: 'synthetic-docker-password' })
    assert.equal(tested.target.context, undefined, 'a hidden context is not sent to an SSH engine')
    await click(document.querySelector('input[type="radio"][value="light"]'))
    await input('localPath', 'D:\\shared-demo')
    await click(button('添加到工作区'))
    assert.equal(fixture.calls.find(call => call.method === 'add').input.localPath, 'D:\\shared-demo')
    assert.equal(fixture.calls.find(call => call.method === 'add').input.mode, 'light')
  } finally { await fixture.dispose() }
})

test('Skill sync defaults to missing items and requires explicit selection and overwrite for differences', async () => {
  const row = { id: 'full', workspaceId: 'remote-project', title: 'demo-project', mode: 'full', registered: true, connectionState: 'connected', target: { kind: 'wsl', distribution: 'Ubuntu', remotePath: '/workspace' } }
  let applied = false
  const fixture = await mount({ initialSaved: [row], respond(method, payload) {
    if (method === 'skills/preview') return { ok: true, value: { planId: 'plan', destination: '/home/demo/.dsh/skills', items: [
      { id: 'missing', name: 'new-skill', description: 'New skill', bytes: 100, files: 1, source: 'user-dsh', state: applied ? 'equal' : 'missing' },
      { id: 'different', name: 'changed-skill', description: 'Changed skill', bytes: 200, files: 2, source: 'custom', state: applied ? 'equal' : 'different' },
      { id: 'same', name: 'same-skill', description: 'Same skill', bytes: 100, files: 1, source: 'user-agents', state: 'equal' },
      { id: 'untouched', name: 'unselected-skill', description: 'Keep local', bytes: 100, files: 1, source: 'user-dsh', state: 'missing' },
    ] } }
    if (method === 'skills/apply') { applied = true; return { ok: true, value: { items: payload.selected.map(id => ({ id, name: id, status: id === 'missing' ? 'created' : 'updated' })) } } }
  } })
  try {
    await click(button('远程工作区')); await click(button('同步本机 Skill 到 demo-project'))
    const boxes = () => [...document.querySelectorAll('.dsh-ssh__skill-list input')]
    assert.deepEqual(boxes().map(box => box.checked), [true, false, false, true])
    assert.deepEqual(boxes().map(box => box.disabled), [false, true, true, false])
    await click(boxes()[3])
    await click(document.querySelector('.dsh-ssh__sync-overwrite input'))
    assert.equal(boxes()[1].checked, false, 'permission to overwrite never selects differences automatically')
    await click(boxes()[1])
    await click(button('同步所选 2 项'))
    assert.deepEqual(fixture.calls.find(call => call.method === 'skills/apply').input, { id: 'full', planId: 'plan', selected: ['missing', 'different'], overwrite: true })
    assert.ok(document.querySelector('[aria-label="同步结果"]'))
    assert.ok(boxes().every(box => !box.checked), 'recomparison after applying must not select previously unselected missing skills')
    assert.deepEqual(boxes().map(box => box.disabled), [true, true, true, false])
    assert.equal(button('同步所选 0 项').disabled, true)
    await click(button('返回工作区'))
    assert.ok(document.querySelector('.dsh-ssh__saved'))
  } finally { await fixture.dispose() }
})

test('saved projects open on the dashboard and a second directory reuses the selected device without credentials', async () => {
  const row = { id: 'full-ssh', workspaceId: 'remote-one', title: 'API', mode: 'full', registered: true, connectionState: 'connected', target: { kind: 'ssh', host: 'demo-host', user: 'developer', port: 2222, auth: 'key', identityFile: '~/.ssh/demo', remotePath: '/srv/api' } }
  const fixture = await mount({ initialSaved: [row] })
  try {
    await click(button('远程工作区'))
    assert.equal(document.querySelector('.dsh-ssh__new'), null)
    assert.match(document.querySelector('.dsh-ssh__saved').textContent, /1 个已连接/)
    await click(button('向 demo-host:2222 添加项目'))
    assert.equal(document.querySelector('input[id$="-host"]').value, 'demo-host')
    assert.equal(document.querySelector('input[id$="-port"]').value, '2222')
    assert.equal(document.querySelector('input[id$="-identityFile"]').value, '~/.ssh/demo')
    assert.equal(document.querySelector('input[id$="-path"]').value, '/srv')
    assert.equal(document.querySelector('input[id$="-title"]').value, '')
    assert.equal(document.querySelector('input[id$="-passphrase"]').value, '')
    await input('path', '/srv/worker')
    await click(button('添加到工作区'))
    const request = fixture.calls.find(call => call.method === 'add').input
    assert.equal(request.target.remotePath, '/srv/worker')
    assert.equal(request.credentials, undefined)
    assert.equal(fixture.saved[0].target.remotePath, '/srv/api')
    assert.equal(document.querySelector('.dsh-ssh__new'), null)
  } finally { await fixture.dispose() }
})

test('failed native navigation reports the failure and keeps connection actions usable', async () => {
  const row = { id: 'full', workspaceId: 'remote-one', title: 'API', mode: 'full', registered: true, connectionState: 'connected', target: { kind: 'wsl', distribution: 'Ubuntu', remotePath: '/srv/api' } }
  const fixture = await mount({ initialSaved: [row], navigate: async () => { throw new Error('Remote workspace stream unavailable') } })
  try {
    await click(button('远程工作区'))
    await click(button('在当前窗口打开 API'))
    assert.match(document.querySelector('[role="alert"]').textContent, /无法打开项目.*stream unavailable/)
    assert.ok(document.querySelector('.dsh-ssh__saved'))
    assert.equal(button('断开 Ubuntu 的全量连接').disabled, false)
    assert.deepEqual(fixture.opened, [])
  } finally { await fixture.dispose() }
})

test('a missing full registration offers explicit re-add with the original directory instead of a misleading open action', async () => {
  const row = { id: 'missing', workspaceId: 'remote-old', title: 'API', mode: 'full', registered: false, connectionState: 'error', connectionError: '远端项目登记已不存在', target: { kind: 'wsl', distribution: 'Ubuntu', remotePath: '/srv/api' } }
  const fixture = await mount({ initialSaved: [row] })
  try {
    await click(button('远程工作区'))
    assert.equal(document.querySelector('button[aria-label="在当前窗口打开 API"]'), null)
    assert.match(document.querySelector('.dsh-ssh__connection').textContent, /旧会话保留在远端/)
    await click(button('重新添加 API 的目录'))
    assert.equal(document.querySelector('input[id$="-path"]').value, '/srv/api')
    assert.equal(document.querySelector('input[id$="-title"]').value, 'API')
    assert.equal(fixture.calls.filter(call => call.method === 'add').length, 0, 'opening recovery never writes before explicit add')
  } finally { await fixture.dispose() }
})

const keydown = async (element, key) => {
  await act(async () => { element.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
}

test('Escape closes menus and inner layers before leaving the project list intact', async () => {
  const fixture = await mount({ initialSaved: [groupedRow('api')] })
  try {
    await click(button('远程工作区'))
    const dialog = document.querySelector('[role="region"]')
    await click(button('添加项目'))
    assert.ok(document.querySelector('.dsh-ssh__new'))
    await keydown(dialog, 'Escape')
    assert.equal(document.querySelector('.dsh-ssh__new'), null)
    assert.ok(document.querySelector('.dsh-ssh__saved'))

    const row = document.querySelector('[data-project-id=api]')
    const menu = row.querySelector('details.dsh-ssh__more')
    menu.open = true
    await act(async () => { document.querySelector('.dsh-ssh__header').dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })) })
    assert.equal(menu.open, false, 'clicking outside a menu dismisses it')
    menu.open = true
    await keydown(dialog, 'Escape')
    assert.equal(menu.open, false, 'Escape dismisses an open menu first')
    assert.ok(document.querySelector('.dsh-ssh__saved'))

    await click(button('设置 api 的连接模式'))
    assert.ok(document.querySelector('.dsh-ssh__credentials'))
    await keydown(dialog, 'Escape')
    assert.equal(document.querySelector('.dsh-ssh__credentials'), null)
    assert.ok(document.querySelector('.dsh-ssh__saved'), 'Escape never closes the whole panel from the root view')
  } finally { await fixture.dispose() }
})

test('remote directory breadcrumbs jump to any ancestor path', async () => {
  const fixture = await mount()
  try {
    await click(button('远程工作区'))
    await click(button('WSL'))
    await input('path', '/home/test/project')
    await click(button('浏览目录'))
    const crumbs = () => [...document.querySelectorAll('.dsh-ssh__crumbs button')]
    assert.deepEqual(crumbs().map(item => item.textContent), ['/', 'home', 'test', 'project'])
    assert.equal(crumbs().at(-1).disabled, true, 'the current directory is not a navigation target')
    await click(crumbs().find(item => item.textContent === 'home'))
    assert.equal(fixture.calls.filter(call => call.method === 'browse').at(-1).input.path, '/home')
    assert.equal(document.querySelector('input[id$="-path"]').value, '/home')
    assert.ok(document.querySelector('.dsh-ssh__browser'), 'breadcrumb navigation keeps the browser open')
    await click(button('上一级'))
    assert.equal(fixture.calls.filter(call => call.method === 'browse').at(-1).input.path, '/')
    assert.ok(button('subproject'))
  } finally { await fixture.dispose() }
})

test('an unknown host-key failure in the add form inspects fingerprints and retries the test once after trust', async () => {
  const ed = fingerprint('A')
  const rsa = fingerprint('B')
  const target = { kind: 'ssh', host: 'demo.example', remotePath: '/srv/project' }
  let tests = 0
  const fixture = await mount({ respond(method) {
    if (method === 'test') {
      tests += 1
      if (tests === 1) return { ok: false, error: { message: 'Remote operation failed (exit 255): No ED25519 host key is known for demo.example and you have requested strict checking.\nHost key verification failed.' } }
      return { ok: true, value: { path: '/srv/project', home: '/home/test', user: 'test', platform: 'Linux', python: '3.10.12' } }
    }
    if (method === 'hostkey/inspect') return { ok: true, value: { host: 'demo.example', port: 22, knownHostsFile: '/home/test/.ssh/known_hosts', state: 'partial', entries: [
      { type: 'ssh-ed25519', fingerprint: ed, trusted: false },
      { type: 'ssh-rsa', fingerprint: rsa, trusted: true },
    ], conflicts: [] } }
    if (method === 'hostkey/trust') return { ok: true, value: { knownHostsFile: '/home/test/.ssh/known_hosts', added: [{ type: 'ssh-ed25519', fingerprint: ed }] } }
  } })
  try {
    await click(button('远程工作区'))
    await input('host', 'demo.example')
    await input('path', '/srv/project')
    await input('password', 'synthetic-password')
    await click(button('测试连接'))
    assert.equal(fixture.calls.filter(call => call.method === 'test').length, 1, 'the first attempt still runs exactly once')
    const inspect = fixture.calls.find(call => call.method === 'hostkey/inspect')
    assert.deepEqual(inspect.input, { target }, 'inspection sends the target only, never credentials')
    const panel = document.querySelector('.dsh-ssh__hostkey')
    assert.ok(panel, 'a host-key failure opens the verification panel')
    assert.equal(panel.getAttribute('role'), 'group')
    assert.deepEqual(fixture.calls.filter(call => call.method === 'hostkey/inspect').map(call => Object.keys(call.input)), [['target']])
    assert.match(panel.textContent, /主机密钥验证/)
    assert.match(panel.textContent, /严格主机密钥校验/)
    assert.match(panel.textContent, /demo\.example/)
    assert.match(panel.textContent, /端口 22/)
    assert.ok(panel.textContent.includes(ed), 'the presented fingerprint is visible')
    assert.ok(panel.textContent.includes(rsa), 'every scanned key type is visible')
    assert.match(panel.textContent, /未记录/)
    assert.match(panel.textContent, /已在 known_hosts/)
    const trustButton = button('信任并重试')
    assert.equal(trustButton.disabled, false)
    await click(trustButton)
    const trust = fixture.calls.find(call => call.method === 'hostkey/trust')
    assert.deepEqual(trust.input, { target, fingerprints: [ed] }, 'only untrusted fingerprints are trusted and never an existing record')
    assert.equal(JSON.stringify(fixture.calls.filter(call => call.method.startsWith('hostkey')).map(call => call.input)).includes('synthetic-password'), false)
    assert.equal(fixture.calls.filter(call => call.method === 'test').length, 2, 'trust repeats the failed test exactly once')
    assert.equal(document.querySelector('.dsh-ssh__hostkey'), null)
    assert.match(document.querySelector('.dsh-ssh__success').textContent, /Linux.*Python 3\.10\.12/)
  } finally { await fixture.dispose() }
})

test('a changed host key never offers trust and can be dismissed before retrying', async () => {
  const presented = fingerprint('C')
  const existing = fingerprint('D')
  const fixture = await mount({ respond(method) {
    if (method === 'test') return { ok: false, error: { message: '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key for demo.example has changed' } }
    if (method === 'hostkey/inspect') return { ok: true, value: { host: 'demo.example', port: 2222, knownHostsFile: '/home/test/.ssh/known_hosts', state: 'changed', entries: [{ type: 'ssh-ed25519', fingerprint: presented, trusted: true }], conflicts: [{ type: 'ssh-ed25519', fingerprint: presented, existing }] } }
  } })
  try {
    await click(button('远程工作区'))
    await input('host', 'demo.example')
    await input('port', '2222')
    await input('path', '/srv/project')
    await click(button('测试连接'))
    const panel = document.querySelector('.dsh-ssh__hostkey')
    assert.ok(panel)
    assert.equal(panel.dataset.state, 'changed')
    assert.ok(panel.textContent.includes(presented))
    assert.ok(panel.textContent.includes(existing))
    assert.match(panel.textContent, /不会自动替换已有主机密钥/)
    assert.match(panel.textContent, /ssh-keygen -R demo\.example/)
    assert.equal(panel.querySelector('.dsh-ssh__button--primary'), null, 'a changed key is never trusted from the UI')
    assert.equal(fixture.calls.some(call => call.method === 'hostkey/trust'), false)
    await click(button('关闭'))
    assert.equal(document.querySelector('.dsh-ssh__hostkey'), null)
    await click(button('测试连接'))
    assert.ok(document.querySelector('.dsh-ssh__hostkey'), 'a repeated failure reopens the panel')
    await click(button('WSL'))
    assert.equal(document.querySelector('.dsh-ssh__hostkey'), null, 'switching tabs resets the panel')
    assert.equal(document.querySelector('.dsh-ssh__error'), null, 'the old form error is cleared with the target')
  } finally { await fixture.dispose() }
})

test('host-key inspection failures and already-trusted keys stay informational', async () => {
  let inspected = false
  const fixture = await mount({ respond(method) {
    if (method === 'test') return { ok: false, error: { message: 'Host key verification failed.' } }
    if (method === 'hostkey/inspect') {
      if (!inspected) return { ok: false, error: { message: 'ssh-keyscan 未返回主机密钥。' } }
      return { ok: true, value: { host: 'demo.example', port: 22, knownHostsFile: '/home/test/.ssh/known_hosts', state: 'known', entries: [{ type: 'ssh-ed25519', fingerprint: fingerprint('E'), trusted: true }], conflicts: [] } }
    }
  } })
  try {
    await click(button('远程工作区'))
    await input('host', 'demo.example')
    await input('path', '/srv/project')
    await click(button('测试连接'))
    let panel = document.querySelector('.dsh-ssh__hostkey')
    assert.ok(panel)
    assert.match(panel.querySelector('.dsh-ssh__error').textContent, /ssh-keyscan 未返回主机密钥/)
    assert.equal(panel.querySelector('.dsh-ssh__button--primary'), null, 'an inspection error never offers trust')
    await click(button('关闭'))
    inspected = true
    await click(button('测试连接'))
    panel = document.querySelector('.dsh-ssh__hostkey')
    assert.ok(panel)
    assert.match(panel.textContent, /无需再次信任/)
    assert.equal(panel.querySelector('.dsh-ssh__button--primary'), null, 'a known key never offers trust')
    assert.equal(fixture.calls.some(call => call.method === 'hostkey/trust'), false)
  } finally { await fixture.dispose() }
})

test('a saved SSH reconnect opens the verification panel and retries the same reconnect after trust', async () => {
  const ed = fingerprint('F')
  const row = { id: 'saved-ssh', workspaceId: 'native-ssh', title: 'saved-ssh', mode: 'light', registered: true, disconnected: true, target: { kind: 'ssh', host: 'saved.example', remotePath: '/srv/project' } }
  let reconnects = 0
  const fixture = await mount({ initialSaved: [row], respond(method) {
    if (method === 'reconnect') {
      reconnects += 1
      if (reconnects === 1) return { ok: false, error: { message: 'Remote operation failed (exit 255): No ED25519 host key is known for saved.example and you have requested strict checking.\nHost key verification failed.' } }
      return { ok: true, value: { ...row, disconnected: false, connectionState: 'connected' } }
    }
    if (method === 'hostkey/inspect') return { ok: true, value: { host: 'saved.example', port: 22, knownHostsFile: '/home/test/.ssh/known_hosts', state: 'unknown', entries: [{ type: 'ssh-ed25519', fingerprint: ed, trusted: false }], conflicts: [] } }
    if (method === 'hostkey/trust') return { ok: true, value: { knownHostsFile: '/home/test/.ssh/known_hosts', added: [{ type: 'ssh-ed25519', fingerprint: ed }] } }
  } })
  try {
    await click(button('远程工作区'))
    await click(button('连接 saved-ssh'))
    assert.equal(fixture.calls.filter(call => call.method === 'reconnect').length, 1)
    const panel = document.querySelector('.dsh-ssh__saved .dsh-ssh__hostkey')
    assert.ok(panel, 'the reconnect failure shows the panel in the saved-connection error area')
    assert.deepEqual(fixture.calls.find(call => call.method === 'hostkey/inspect').input, { target: row.target })
    await click(button('信任并重试'))
    assert.deepEqual(fixture.calls.find(call => call.method === 'hostkey/trust').input, { target: row.target, fingerprints: [ed] })
    assert.equal(fixture.calls.filter(call => call.method === 'reconnect').length, 2)
    assert.equal(document.querySelector('.dsh-ssh__hostkey'), null)
    assert.match(document.querySelector('.dsh-ssh__notice').textContent, /已重新连接/)
  } finally { await fixture.dispose() }
})

test('a shared full backend host-key failure retries the connection after trust', async () => {
  const ed = fingerprint('G')
  const row = { id: 'full-ssh', workspaceId: 'native-full', title: 'full-ssh', mode: 'full', backendId: 'backend-1', registered: true, disconnected: true, target: { kind: 'ssh', host: 'shared.example', port: 2222, remotePath: '/srv/api' } }
  let connections = 0
  const fixture = await mount({ initialSaved: [row], respond(method) {
    if (method === 'connection/reconnect') {
      connections += 1
      if (connections === 1) return { ok: false, error: { message: 'Remote operation failed (exit 255): No ED25519 host key is known for shared.example and you have requested strict checking.\nHost key verification failed.' } }
      return { ok: true, value: null }
    }
    if (method === 'hostkey/inspect') return { ok: true, value: { host: 'shared.example', port: 2222, knownHostsFile: '/home/test/.ssh/known_hosts', state: 'unknown', entries: [{ type: 'ssh-ed25519', fingerprint: ed, trusted: false }], conflicts: [] } }
    if (method === 'hostkey/trust') return { ok: true, value: { knownHostsFile: '/home/test/.ssh/known_hosts', added: [{ type: 'ssh-ed25519', fingerprint: ed }] } }
  } })
  try {
    await click(button('远程工作区'))
    await click(button('连接 shared.example:2222 的全量连接'))
    assert.equal(fixture.calls.filter(call => call.method === 'connection/reconnect').length, 1)
    assert.ok(document.querySelector('.dsh-ssh__saved .dsh-ssh__hostkey'), 'the shared connection failure uses the same panel')
    assert.deepEqual(fixture.calls.find(call => call.method === 'hostkey/inspect').input, { target: row.target })
    await click(button('信任并重试'))
    assert.deepEqual(fixture.calls.find(call => call.method === 'hostkey/trust').input, { target: row.target, fingerprints: [ed] })
    assert.equal(fixture.calls.filter(call => call.method === 'connection/reconnect').length, 2, 'trust retries the shared connection rather than a project reconnect')
    assert.equal(document.querySelector('.dsh-ssh__hostkey'), null)
    assert.match(document.querySelector('.dsh-ssh__notice').textContent, /全量后端已连接/)
  } finally { await fixture.dispose() }
})

test('an add host-key failure opens the panel, resets when the dialog closes, and trust retries the add once', async () => {
  const ed = fingerprint('H')
  const target = { kind: 'ssh', host: 'add.example', remotePath: '/srv/new' }
  let adds = 0
  const fixture = await mount({ respond(method) {
    if (method === 'add') {
      adds += 1
      if (adds < 3) return { ok: false, error: { message: 'Remote operation failed (exit 255): No ED25519 host key is known for add.example and you have requested strict checking.\nHost key verification failed.' } }
      return { ok: true, value: { id: 'remote-hostkey', workspaceId: 'native-hostkey', title: 'new-project', mode: 'full', target, createdAt: 1, registered: true, connectionState: 'connected', online: true } }
    }
    if (method === 'hostkey/inspect') return { ok: true, value: { host: 'add.example', port: 22, knownHostsFile: '/home/test/.ssh/known_hosts', state: 'unknown', entries: [{ type: 'ssh-ed25519', fingerprint: ed, trusted: false }], conflicts: [] } }
    if (method === 'hostkey/trust') return { ok: true, value: { knownHostsFile: '/home/test/.ssh/known_hosts', added: [{ type: 'ssh-ed25519', fingerprint: ed }] } }
  } })
  try {
    await click(button('远程工作区'))
    await input('host', 'add.example')
    await input('path', '/srv/new')
    await click(button('添加到工作区'))
    assert.equal(fixture.calls.filter(call => call.method === 'add').length, 1)
    assert.ok(document.querySelector('.dsh-ssh__new .dsh-ssh__hostkey'), 'the add form shows the panel below its error')
    await click(button('关闭远程工作区管理'))
    await click(button('远程工作区'))
    assert.equal(document.querySelector('.dsh-ssh__hostkey'), null, 'reopening the dialog never restores a stale panel')
    await click(button('添加到工作区'))
    assert.equal(fixture.calls.filter(call => call.method === 'add').length, 2)
    const panel = document.querySelector('.dsh-ssh__hostkey')
    assert.ok(panel, 'the repeated failure reopens the panel')
    assert.match(panel.textContent, /未记录/)
    await click(button('信任并重试'))
    assert.deepEqual(fixture.calls.find(call => call.method === 'hostkey/trust').input, { target, fingerprints: [ed] })
    assert.equal(fixture.calls.filter(call => call.method === 'add').length, 3, 'trust retries the add exactly once')
    assert.equal(document.querySelector('.dsh-ssh__hostkey'), null)
    assert.match(document.querySelector('.dsh-ssh__notice').textContent, /已添加「new-project」/)
    assert.ok(document.querySelector('.dsh-ssh__saved'))
  } finally { await fixture.dispose() }
})
