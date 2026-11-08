import { useEffect, useId, useRef, useSyncExternalStore, type ComponentType } from 'react'
import stylesheet from './client.css'
import { installBackendRouter } from './client-router.js'
import { installWorkspaceBadges } from './workspace-badges.js'
import { connectionState, CONNECTION_LABELS } from './connection-status.js'
import { RPC_CHANNEL, RPC_PREFIX, type AddWorkspaceRequest, type RemoteDirectory, type RemoteInfo, type RemoteTarget, type ReconnectRequest, type SavedWorkspace, type WorkspaceView, type WorkspaceMode, type SshCredentials } from './types.js'

type Disposer = () => void
type Kind = RemoteTarget['kind']
type Area = 'status' | 'distros' | 'form' | 'connections'
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { message: string } }

interface HostStatus {
  pluginVersion: string
  verifiedDshVersion: string
  platform: string
  workspaces: WorkspaceView[]
}

interface Endpoints {
  status: { input: Record<string, never>; output: HostStatus }
  'wsl/list': { input: Record<string, never>; output: string[] }
  browse: { input: { target: RemoteTarget; path: string; credentials?: SshCredentials }; output: RemoteDirectory }
  test: { input: { target: RemoteTarget; credentials?: SshCredentials }; output: RemoteInfo }
  add: { input: AddWorkspaceRequest; output: SavedWorkspace }
  reconnect: { input: ReconnectRequest; output: SavedWorkspace }
  disconnect: { input: { id: string }; output: void }
  remove: { input: { id: string }; output: void }
}

/** The client boundary deliberately does not import the host's augmented Context. */
interface ClientContext {
  connection: {
    rpc: { call<T>(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<T>> }
  }
  slots: {
    inject(name: 'sidebar.panellist' | 'main', setup: () => Disposer): Disposer
    register<P extends object>(options: {
      name: 'sidebar.panellist' | 'main'
      id: string
      key?: string
      label?: string
      order?: number
      inject: () => P
    }, component: ComponentType<P>): Disposer
  }
  get(name: string): any
  effect(setup: () => void | Disposer, label?: string): unknown
}

interface Draft {
  mode: WorkspaceMode
  title: string
  host: string
  port: string
  user: string
  sshAuth: 'auto' | 'password' | 'key' | 'certificate'
  identityFile: string
  certificateFile: string
  password: string
  passphrase: string
  distribution: string
  remotePath: string
  localPath: string
}

interface Snapshot {
  open: boolean
  tab: Kind
  drafts: Record<Kind, Draft>
  status: HostStatus | null
  distros: string[]
  distrosLoaded: boolean
  directory: RemoteDirectory | null
  info: RemoteInfo | null
  pending: readonly string[]
  errors: Record<Area, string | null>
  notice: string | null
  confirmRemove: string | null
  reauth: { id: string; mode: WorkspaceMode; localPath: string; password: string; passphrase: string } | null
}

const emptyDraft = (): Draft => ({ mode: 'full', title: '', host: '', port: '', user: '', sshAuth: 'auto', identityFile: '', certificateFile: '', password: '', passphrase: '', distribution: '', remotePath: '/', localPath: '' })
const mutationPending = (state: Snapshot): boolean => state.pending.some(key => key === 'add' || /^(reconnect|disconnect|remove):/.test(key))
const errorText = (error: unknown): string => error instanceof Error ? error.message : '操作未完成，请重试。'
const joinRemote = (path: string, name: string): string => name.startsWith('/') ? name : `${path.replace(/\/+$/, '')}/${name}`
const parentRemote = (path: string): string => path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

/** One immutable snapshot store is shared by the two independently mounted slots. */
function createManager(ctx: ClientContext, onChanged: () => void = () => {}, onStatus: (status: HostStatus) => void = () => {}) {
  let state: Snapshot = {
    open: false, tab: 'ssh', drafts: { ssh: emptyDraft(), wsl: emptyDraft() },
    status: null, distros: [], distrosLoaded: false, directory: null, info: null,
    pending: [], errors: { status: null, distros: null, form: null, connections: null },
    notice: null, confirmRemove: null, reauth: null,
  }
  let alive = true
  let opener: HTMLElement | null = null
  let dialog: HTMLElement | null = null
  const listeners = new Set<() => void>()
  const requests = new Map<string, AbortController>()
  const update = (patch: Partial<Snapshot>): void => {
    if (!alive) return
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }
  const setError = (area: Area, message: string | null): void => update({ errors: { ...state.errors, [area]: message } })
  const cancel = (key: string): void => {
    const request = requests.get(key)
    requests.delete(key)
    request?.abort()
    update({ pending: [...requests.keys()] })
  }
  const cancelForm = (): void => { cancel('browse'); cancel('test') }
  const patchDraft = (kind: Kind, patch: Partial<Draft>): void => update({ drafts: { ...state.drafts, [kind]: { ...state.drafts[kind], ...patch } } })

  async function request<K extends keyof Endpoints>(
    key: string, endpoint: K, payload: Endpoints[K]['input'], area: Area,
    accept: (value: Endpoints[K]['output']) => void,
    onError?: (message: string) => void,
  ): Promise<void> {
    if (!alive || !state.open) return
    cancel(key)
    const controller = new AbortController()
    requests.set(key, controller)
    setError(area, null)
    update({ pending: [...requests.keys()] })
    try {
      const result = await ctx.connection.rpc.call<Endpoints[K]['output']>(RPC_CHANNEL, `${RPC_PREFIX}/${endpoint}`, payload, controller.signal)
      if (!alive || !state.open || controller.signal.aborted || requests.get(key) !== controller) return
      if (!result.ok) throw new Error(result.error.message || '宿主拒绝了此操作。')
      accept(result.value)
    } catch (error) {
      if (alive && state.open && !controller.signal.aborted && requests.get(key) === controller) { setError(area, errorText(error)); onError?.(errorText(error)) }
    } finally {
      if (requests.get(key) === controller) {
        requests.delete(key)
        update({ pending: [...requests.keys()] })
      }
    }
  }

  const refresh = (): void => {
    void request('status', 'status', {}, 'status', status => { update({ status }); onStatus(status) })
  }
  const loadDistros = (): void => {
    void request('wsl/list', 'wsl/list', {}, 'distros', distros => {
      update({ distros, distrosLoaded: true })
      if (!state.drafts.wsl.distribution && distros[0]) patchDraft('wsl', { distribution: distros[0] })
    })
  }
  const targetOf = (): RemoteTarget | null => {
    const draft = state.drafts[state.tab]
    const remotePath = draft.remotePath.trim()
    if (!remotePath.startsWith('/')) { setError('form', '请输入以 / 开头的远程目录，或先浏览目录。'); return null }
    const user = draft.user.trim()
    if (state.tab === 'wsl') {
      if (!draft.distribution) { setError('form', '请先选择一个 WSL 发行版。'); return null }
      return { kind: 'wsl', distribution: draft.distribution, remotePath, ...(user ? { user } : {}) }
    }
    const host = draft.host.trim()
    if (!host || /[\s/@]/.test(host) || host.startsWith('-')) {
      setError('form', '请输入主机名、IP 或 SSH 配置别名；用户名请单独填写。')
      return null
    }
    const port = draft.port.trim() ? Number(draft.port) : undefined
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      setError('form', '端口应为 1–65535 之间的整数。'); return null
    }
    const identityFile = draft.identityFile.trim()
    const keyed = draft.sshAuth === 'key' || draft.sshAuth === 'certificate'
    if (keyed && !identityFile) { setError('form', '请选择或填写本机 SSH 私钥文件路径。'); return null }
    if (draft.sshAuth === 'certificate' && !draft.certificateFile.trim()) { setError('form', '请选择 OpenSSH 用户证书文件。'); return null }
    if (draft.sshAuth === 'password' && !draft.password) { setError('form', '请输入 SSH 登录密码。'); return null }
    return { kind: 'ssh', host, remotePath, ...(user ? { user } : {}), ...(port === undefined ? {} : { port }), ...(draft.sshAuth !== 'auto' ? { auth: draft.sshAuth } : {}), ...(keyed ? { identityFile } : {}), ...(draft.sshAuth === 'certificate' ? { certificateFile: draft.certificateFile.trim() } : {}) }
  }
  const credentialsOf = (): { credentials?: SshCredentials } => {
    if (state.tab !== 'ssh') return {}
    const draft = state.drafts.ssh
    const credentials = {
      ...((draft.sshAuth === 'auto' || draft.sshAuth === 'password') && draft.password ? { password: draft.password } : {}),
      ...(draft.sshAuth !== 'password' && draft.passphrase ? { passphrase: draft.passphrase } : {}),
    }
    return Object.keys(credentials).length ? { credentials } : {}
  }
  const remember = (saved: SavedWorkspace): void => {
    onChanged()
    if (state.status) update({ status: {
      ...state.status, workspaces: [{ ...saved, registered: true, disconnected: false, connectionState: 'connected', online: true }, ...state.status.workspaces.filter(item => item.id !== saved.id)],
    } })
    if (state.status) onStatus(state.status)
    refresh()
  }
  const editConnection = (id: string | null): void => {
    const record = state.status?.workspaces.find(row => row.id === id)
    update({ reauth: record ? { id: record.id, mode: record.mode ?? 'light', localPath: record.mode === 'full' ? '' : record.localPath, password: '', passphrase: '' } : null })
  }

  return {
    subscribe: (listener: () => void): Disposer => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: (): Snapshot => state,
    acceptStatus: (status: HostStatus): void => { if (alive) update({ status }) },
    acceptWorkspaces: (workspaces: WorkspaceView[]): void => { if (alive && state.status) update({ status: { ...state.status, workspaces } }) },
    bindDialog: (element: HTMLElement | null): void => { dialog = element },
    getDialog: (): HTMLElement | null => dialog,
    exitPanel: (): void => { ctx.get('layout')?.selectPanel(null) },
    open: (): void => {
      if (state.open || !alive) return
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
      update({ open: true, notice: null, confirmRemove: null })
      refresh()
      if (state.tab === 'wsl') loadDistros()
    },
    close: (): void => {
      for (const controller of requests.values()) controller.abort()
      requests.clear()
      patchDraft('ssh', { password: '', passphrase: '' })
      update({ open: false, pending: [], confirmRemove: null, reauth: null })
      const returnTo = opener
      queueMicrotask(() => { if (!state.open && returnTo?.isConnected) returnTo.focus() })
    },
    setTab: (tab: Kind): void => {
      if (tab === state.tab || mutationPending(state)) return
      cancelForm()
      update({ tab, directory: null, info: null, errors: { ...state.errors, form: null } })
      if (tab === 'wsl' && !state.distrosLoaded) loadDistros()
    },
    setMode: (mode: WorkspaceMode): void => {
      if (mutationPending(state) || mode === state.drafts[state.tab].mode) return
      patchDraft(state.tab, { mode })
      setError('form', null)
    },
    change: (field: keyof Draft, value: string): void => {
      if (mutationPending(state)) return
      if (field === 'sshAuth' && !['auto', 'password', 'key', 'certificate'].includes(value)) return
      if (field !== 'title' && field !== 'localPath') {
        cancelForm()
        update({ directory: null, info: null })
      }
      patchDraft(state.tab, { [field]: value })
      setError('form', null)
    },
    keyPickerError: (message: string): void => setError('form', message),
    refresh,
    loadDistros,
    browse: (path?: string): void => {
      if (mutationPending(state)) return
      cancelForm()
      const target = targetOf()
      if (!target) return
      const kind = state.tab
      void request('browse', 'browse', { target, path: path ?? target.remotePath, ...credentialsOf() }, 'form', directory => {
        patchDraft(kind, { remotePath: directory.path })
        update({ directory, info: null })
      })
    },
    test: (): void => {
      if (mutationPending(state)) return
      cancelForm()
      const target = targetOf()
      if (!target) return
      void request('test', 'test', { target, ...credentialsOf() }, 'form', info => update({ info }))
    },
    add: (): void => {
      if (mutationPending(state)) return
      const target = targetOf()
      if (!target) return
      const draft = state.drafts[state.tab]
      const localPath = draft.localPath.trim()
      cancelForm()
      const title = draft.title.trim()
      update({ notice: null })
      void request('add', 'add', { target, mode: draft.mode, ...credentialsOf(), ...(title ? { title } : {}), ...(draft.mode === 'light' && target.kind === 'ssh' && localPath ? { localPath } : {}) }, 'form', saved => {
        remember(saved)
        patchDraft('ssh', { password: '', passphrase: '' })
        update({ notice: `已添加「${saved.title}」。可从工作区列表或下方“打开”进入。` })
      })
    },
    reconnect: (id: string): void => {
      if (mutationPending(state)) return
      cancelForm()
      update({ notice: null, confirmRemove: null })
      void request(`reconnect:${id}`, 'reconnect', { id }, 'connections', saved => {
        remember(saved)
        update({ notice: `「${saved.title}」已重新连接。` })
      }, message => { refresh(); if (/SSH 密码|口令|认证失败|Permission denied/i.test(message)) editConnection(id) })
    },
    editCredentials: editConnection,
    editConnection,
    changeCredential: (field: 'password' | 'passphrase', value: string): void => { if (state.reauth && !mutationPending(state)) update({ reauth: { ...state.reauth, [field]: value } }) },
    changeConnection: (field: 'mode' | 'localPath', value: string): void => {
      if (!state.reauth || mutationPending(state) || (field === 'mode' && value !== 'light' && value !== 'full')) return
      update({ reauth: { ...state.reauth, [field]: value } })
    },
    reconnectWithCredentials: (): void => {
      const form = state.reauth
      if (!form || mutationPending(state)) return
      const original = state.status?.workspaces.find(row => row.id === form.id)
      if (!original) return
      const switching = form.mode !== (original.mode ?? 'light')
      const credentials = { ...(form.password ? { password: form.password } : {}), ...(form.passphrase ? { passphrase: form.passphrase } : {}) }
      void request(`reconnect:${form.id}`, 'reconnect', { id: form.id, ...(Object.keys(credentials).length ? { credentials } : {}), ...(switching ? { mode: form.mode, ...(form.mode === 'light' && form.localPath.trim() ? { localPath: form.localPath.trim() } : {}) } : {}) }, 'connections', saved => {
        remember(saved); update({ reauth: null, notice: switching ? `已连接${form.mode === 'full' ? '全量' : '轻量'}模式。原模式入口与会话历史保留，可分别继续使用。` : `「${saved.title}」已重新连接。` })
      }, () => refresh())
    },
    disconnect: (id: string): void => {
      if (state.pending.some(key => key !== `reconnect:${id}` && (key === 'add' || /^(reconnect|disconnect|remove):/.test(key)))) return
      cancel(`reconnect:${id}`)
      cancel('status')
      const record = state.status?.workspaces.find(row => row.id === id)
      void request(`disconnect:${id}`, 'disconnect', { id }, 'connections', () => {
        if (state.status) {
          const backendId = (record as (WorkspaceView & { backendId?: string }) | undefined)?.backendId
          update({ status: { ...state.status, workspaces: state.status.workspaces.map(row => row.id === id || (backendId && (row as WorkspaceView & { backendId?: string }).backendId === backendId) ? { ...row, disconnected: true, connectionState: 'disconnected', online: false, connectionError: undefined } : row) }, reauth: null,
            notice: record?.mode === 'full' ? '已断开本机隧道，远端 DSH 和任务继续运行；文件与会话历史保留。' : '已断开插件命令通道，文件与会话历史保留；外部 SSHFS / WSL 挂载不卸载。' })
          onStatus(state.status!)
        }
        onChanged(); refresh()
      })
    },
    confirmRemove: (id: string | null): void => update({ confirmRemove: id }),
    remove: (id: string): void => {
      if (mutationPending(state)) return
      cancelForm()
      update({ notice: null })
      void request(`remove:${id}`, 'remove', { id }, 'connections', () => {
        onChanged()
        if (state.status) update({ status: { ...state.status, workspaces: state.status.workspaces.filter(item => item.id !== id) } })
        update({ confirmRemove: null, notice: '已移除工作区登记，远程文件保持原样。' })
        refresh()
      })
    },
    canOpen: (): boolean => typeof ctx.get('uiWorkspace')?.startSession === 'function',
    openWorkspace: (workspaceId: string): void => {
      try {
        const navigation = ctx.get('uiWorkspace')
        if (!navigation) throw new Error('当前宿主暂不能打开会话，请从原生工作区列表进入。')
        navigation.startSession(workspaceId)
      } catch (error) { setError('connections', errorText(error)); return }
      // Native navigation unmounts this panel only after the Session is ready.
      // If the connection fails, the form and its reconnect action stay visible.
      opener = null
    },
    destroy: (): void => {
      alive = false
      for (const controller of requests.values()) controller.abort()
      requests.clear()
      listeners.clear()
      dialog = null
      if (state.open && opener?.isConnected) opener.focus()
    },
  }
}

type Manager = ReturnType<typeof createManager>
interface Injected { manager: Manager }

function ConnectionIcon({ small = false }: { small?: boolean }) {
  return <svg className="dsh-ssh__icon" width={small ? 16 : 20} height={small ? 16 : 20} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" strokeWidth="1.6" />
    <path d="m7 9 3 3-3 3m6 0h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function ErrorNotice({ message }: { message: string | null }) {
  return message ? <p className="dsh-ssh__error" role="alert">{message}</p> : null
}

function SavedConnections({ manager, state }: Injected & { state: Snapshot }) {
  const busy = mutationPending(state)
  const workspaces = state.status?.workspaces ?? []
  return <section className="dsh-ssh__saved" aria-labelledby="dsh-ssh-saved-heading">
    <div className="dsh-ssh__section-head">
      <h3 id="dsh-ssh-saved-heading">已保存的工作区 <span className="dsh-ssh__count">{workspaces.length}</span></h3>
      <button type="button" className="dsh-ssh__text-button" onClick={manager.refresh} disabled={state.pending.includes('status')}>
        {state.pending.includes('status') ? '刷新中…' : '刷新'}
      </button>
    </div>
    <ErrorNotice message={state.errors.status} />
    <ErrorNotice message={state.errors.connections} />
    {!workspaces.length && <div className="dsh-ssh__empty">
      <ConnectionIcon /><p>{state.pending.includes('status') ? '正在读取工作区…' : state.errors.status ? '暂时无法读取工作区' : '还没有远程工作区'}</p>
      <span>{state.errors.status ? '点击刷新重试。' : '添加后，也会显示在原生工作区列表中。'}</span>
    </div>}
    <ul className="dsh-ssh__saved-list">
      {workspaces.map(item => {
        const connecting = state.pending.includes(`reconnect:${item.id}`)
        const disconnecting = state.pending.includes(`disconnect:${item.id}`)
        const status = connecting ? 'connecting' : disconnecting ? 'disconnected' : connectionState(item)
        const form = state.reauth?.id === item.id ? state.reauth : null
        const switching = form && form.mode !== (item.mode ?? 'light')
        return <li key={item.id} className="dsh-ssh__connection" data-connection-state={status} aria-busy={connecting || disconnecting || state.pending.includes(`remove:${item.id}`)}>
        <div className="dsh-ssh__connection-heading"><span className="dsh-ssh__kind">{item.target.kind.toUpperCase()}</span><strong title={item.title}>{item.title}</strong><span className="dsh-ssh__kind">{item.mode === 'full' ? '全量' : '轻量'}</span></div>
        <p className="dsh-ssh__destination" title={describeTarget(item.target)}>{describeTarget(item.target)}</p>
        {item.target.kind === 'ssh' && <>
          <p className="dsh-ssh__path" title={item.target.identityFile}>{item.target.auth === 'password' ? '认证：仅密码（凭据仅本次运行保留）' : item.target.identityFile ? `密钥：${item.target.identityFile}` : '认证：自动选择 / SSH 配置 / ssh-agent'}</p>
          {item.target.certificateFile && <p className="dsh-ssh__path" title={item.target.certificateFile}>证书：{item.target.certificateFile}</p>}
        </>}
        <p className="dsh-ssh__path" title={item.target.remotePath}>{item.target.remotePath}</p>
        <span className="dsh-ssh__registration" data-connection-state={status} role="status">{disconnecting ? '正在断开' : CONNECTION_LABELS[status]} · {item.mode === 'full' ? '远程 DSH 后端' : '本机 Agent / 远程命令'}</span>
        {!item.registered && <p className="dsh-ssh__hint">尚未登记，连接后恢复侧栏入口。</p>}
        {status === 'error' && <p className="dsh-ssh__connection-error">{item.connectionError || '连接不可用，请重新连接。'}</p>}
        {state.confirmRemove === item.id ? <div className="dsh-ssh__remove-confirm">
          <p>移除此模式的工作区登记？文件和会话历史保留。需要暂停连接时请使用“断开”。</p>
          <div className="dsh-ssh__actions">
            <button type="button" className="dsh-ssh__button dsh-ssh__button--danger" onClick={() => manager.remove(item.id)} disabled={busy}>{state.pending.includes(`remove:${item.id}`) ? '移除中…' : '确认移除'}</button>
            <button type="button" className="dsh-ssh__button" onClick={() => manager.confirmRemove(null)} disabled={busy}>取消</button>
          </div>
        </div> : <div className="dsh-ssh__connection-actions">
          {manager.canOpen() && <button type="button" className="dsh-ssh__button" disabled={busy || !item.registered || status !== 'connected'} title={status === 'connected' ? '在此模式中新建会话' : '请先连接此项目'} onClick={() => manager.openWorkspace(item.workspaceId)} aria-label={`在当前窗口打开 ${item.title}`}>打开</button>}
          <button type="button" className="dsh-ssh__text-button" disabled={busy} onClick={() => manager.reconnect(item.id)} aria-label={`${status === 'connected' ? '重新连接' : '连接'} ${item.title}`}>{connecting ? '连接中…' : status === 'connected' ? '重新连接' : '连接'}</button>
          {(status === 'connected' || status === 'connecting') && <button type="button" className="dsh-ssh__text-button" disabled={disconnecting || (busy && !connecting)} onClick={() => manager.disconnect(item.id)} aria-label={`断开 ${item.title}`}>断开</button>}
          <button type="button" className="dsh-ssh__text-button" disabled={busy} onClick={() => manager.editConnection(item.id)} aria-label={`设置 ${item.title} 的连接模式`}>连接设置</button>
          <button type="button" className="dsh-ssh__text-button dsh-ssh__remove" disabled={busy} onClick={() => manager.confirmRemove(item.id)} aria-label={`移除 ${item.title} 的登记`}>移除登记</button>
        </div>}
        {item.mode === 'full' && (item.sharedConnectionCount ?? 0) > 1 && <p className="dsh-ssh__hint">同一后端的 {item.sharedConnectionCount} 个全量项目共用连接，断开时一起离线；远端任务继续运行。</p>}
        {form && <form className="dsh-ssh__credentials" aria-label={`${item.title} 的连接设置`} onSubmit={event => { event.preventDefault(); manager.reconnectWithCredentials() }}>
          <label className="dsh-ssh__field" htmlFor={`saved-${item.id}-mode`}>连接模式<select id={`saved-${item.id}-mode`} value={form.mode} onChange={event => manager.changeConnection('mode', event.target.value)} disabled={busy}><option value="light">轻量模式</option><option value="full">全量模式</option></select></label>
          <p className="dsh-ssh__hint">随时选择连接模式。两种模式使用同一远程目录，分别保留会话历史；切换不会迁移旧会话或停止原模式，可从各自入口继续。</p>
          {switching && form.mode === 'full' && <p className="dsh-ssh__hint">首次使用全量模式将安装匹配的远端 DSH，模型配置使用远端环境。</p>}
          {switching && form.mode === 'light' && item.target.kind === 'ssh' && <label className="dsh-ssh__field" htmlFor={`saved-${item.id}-mount`}>本机 SSHFS 挂载路径<input id={`saved-${item.id}-mount`} value={form.localPath} onChange={event => manager.changeConnection('localPath', event.target.value)} disabled={busy} placeholder="已有轻量项目可留空复用，否则填写已建立的挂载路径" /></label>}
          {item.target.kind === 'ssh' && <>
            <p className="dsh-ssh__hint">密码和私钥口令仅本次运行保留；留空沿用已提供的凭据。</p>
            {(!item.target.auth || item.target.auth === 'auto' || item.target.auth === 'password') && <label className="dsh-ssh__field">SSH 密码<input type="password" autoComplete="off" value={form.password} onChange={event => manager.changeCredential('password', event.target.value)} disabled={busy} /></label>}
            {item.target.auth !== 'password' && <label className="dsh-ssh__field">私钥口令<input type="password" autoComplete="off" value={form.passphrase} onChange={event => manager.changeCredential('passphrase', event.target.value)} disabled={busy} placeholder="未加密私钥可留空" /></label>}
          </>}
          <div className="dsh-ssh__actions"><button className="dsh-ssh__button" type="submit" disabled={busy}>{connecting ? '连接中…' : switching ? `以${form.mode === 'full' ? '全量' : '轻量'}模式连接` : '连接此模式'}</button><button className="dsh-ssh__text-button" type="button" onClick={() => manager.editCredentials(null)} disabled={busy}>取消</button></div>
        </form>}
      </li>})}
    </ul>
  </section>
}

function describeTarget(target: RemoteTarget): string {
  return target.kind === 'wsl'
    ? `${target.distribution}${target.user ? ` · ${target.user}` : ''}`
    : `${target.user ? `${target.user}@` : ''}${target.host}${target.port ? `:${target.port}` : ''}`
}

function WorkspaceForm({ manager, state }: Injected & { state: Snapshot }) {
  const id = useId()
  const keyPicker = useRef<HTMLInputElement>(null)
  const certificatePicker = useRef<HTMLInputElement>(null)
  const hostPaths = (globalThis as typeof globalThis & { __DSH_HOST_PATHS__?: { pathFor(file: File): string } }).__DSH_HOST_PATHS__
  const draft = state.drafts[state.tab]
  const ssh = state.tab === 'ssh'
  const full = draft.mode === 'full'
  const windows = state.status?.platform === 'win32'
  const busy = mutationPending(state)
  const inspecting = state.pending.includes('test') || state.pending.includes('browse')
  const change = (field: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => manager.change(field, event.currentTarget.value)
  return <section className="dsh-ssh__new" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>添加工作区</h3>
    <div className="dsh-ssh__tabs" role="tablist" aria-label="连接方式" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return
      const next: Kind = event.key === 'Home' ? 'ssh' : event.key === 'End' ? 'wsl' : state.tab === 'ssh' ? 'wsl' : 'ssh'
      if (next === 'wsl' && state.status && state.status.platform !== 'win32') return
      event.preventDefault()
      manager.setTab(next)
      document.getElementById(`${id}-${next}`)?.focus()
    }}>
      {(['ssh', 'wsl'] as const).map(kind => <button type="button" role="tab" key={kind} id={`${id}-${kind}`} aria-selected={state.tab === kind} aria-controls={`${id}-panel`} tabIndex={state.tab === kind ? 0 : -1} disabled={busy || (kind === 'wsl' && state.status !== null && state.status.platform !== 'win32')} onClick={() => manager.setTab(kind)}>{kind.toUpperCase()}</button>)}
    </div>
    <form id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${state.tab}`} onSubmit={event => { event.preventDefault(); manager.add() }}>
      <fieldset className="dsh-ssh__modes" disabled={busy}>
        <legend>运行模式</legend>
        {(['light', 'full'] as const).map(mode => <label key={mode} className={`dsh-ssh__mode${draft.mode === mode ? ' dsh-ssh__mode--selected' : ''}`}>
          <input type="radio" name={`${id}-mode`} value={mode} checked={draft.mode === mode} onChange={() => manager.setMode(mode)} />
          <span><strong>{mode === 'light' ? '轻量模式' : '全量模式'}</strong><small>{mode === 'light' ? '不安装远端 DSH · 本机运行 Agent' : '安装远端 DSH · 完整远程后端'}</small></span>
        </label>)}
      </fieldset>
      <p className="dsh-ssh__intro">{full
        ? `${ssh ? '使用本机 SSH 配置与密钥连接，自动部署版本匹配的远程 DSH 后端。' : '在 WSL 内部署完整 DSH 后端，通过本机隧道连接，无需 SSH 服务。'} 文件、Agent、终端与任务均在远端运行，无需 SSHFS 挂载。`
        : `${ssh ? '通过 SSHFS 挂载访问文件、通过 SSH 执行命令。' : '通过 Windows 的 WSL 目录共享访问文件、通过 WSL 执行命令。'} Agent 在本机运行，远端不安装 DSH。`}</p>
      <fieldset className="dsh-ssh__fields" disabled={busy}>
        <legend className="dsh-ssh__sr-only">{ssh ? 'SSH 连接信息' : 'WSL 连接信息'}</legend>
        {ssh ? <div className="dsh-ssh__host-row">
          <label className="dsh-ssh__field" htmlFor={`${id}-host`}>主机或 SSH 别名 <span aria-hidden="true">*</span><input id={`${id}-host`} value={draft.host} onChange={change('host')} placeholder="dev-server / 192.168.1.10" required autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
          <label className="dsh-ssh__field" htmlFor={`${id}-port`}>端口<input id={`${id}-port`} value={draft.port} onChange={change('port')} type="number" min={1} max={65535} inputMode="numeric" placeholder="SSH 配置" /></label>
        </div> : <div className="dsh-ssh__distro-row">
          <label className="dsh-ssh__field" htmlFor={`${id}-distro`}>WSL 发行版 <span aria-hidden="true">*</span><select id={`${id}-distro`} value={draft.distribution} onChange={change('distribution')} required disabled={state.pending.includes('wsl/list')}>
            <option value="">{state.pending.includes('wsl/list') ? '正在读取发行版…' : '请选择发行版'}</option>
            {draft.distribution && !state.distros.includes(draft.distribution) && <option value={draft.distribution}>{draft.distribution}（未发现）</option>}
            {state.distros.map(distro => <option key={distro} value={distro}>{distro}</option>)}
          </select></label>
          <button type="button" className="dsh-ssh__button" onClick={manager.loadDistros} disabled={state.pending.includes('wsl/list')}>刷新列表</button>
        </div>}
        {!ssh && <>
          <ErrorNotice message={state.errors.distros} />
          {state.distrosLoaded && !state.distros.length && <p className="dsh-ssh__hint">未发现 WSL 发行版。安装并启动发行版后刷新列表。</p>}
        </>}
        <label className="dsh-ssh__field" htmlFor={`${id}-user`}>用户名 <span className="dsh-ssh__optional">可选</span><input id={`${id}-user`} value={draft.user} onChange={change('user')} placeholder={ssh ? '留空使用 SSH 配置' : '留空使用发行版默认用户'} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
        {ssh && <>
          <label className="dsh-ssh__field" htmlFor={`${id}-sshAuth`}>登录方式<select id={`${id}-sshAuth`} value={draft.sshAuth} onChange={change('sshAuth')}>
            <option value="auto">自动选择</option>
            <option value="password">仅密码</option>
            <option value="key">密钥</option>
            <option value="certificate">证书</option>
          </select></label>
          {(draft.sshAuth === 'key' || draft.sshAuth === 'certificate') ? <>
            <div className="dsh-ssh__key-row">
              <label className="dsh-ssh__field" htmlFor={`${id}-identityFile`}>本机私钥文件<input id={`${id}-identityFile`} value={draft.identityFile} onChange={change('identityFile')} placeholder="~/.ssh/id_ed25519 或本机绝对路径" required spellCheck={false} autoCapitalize="none" autoCorrect="off" aria-describedby={`${id}-key-help`} /></label>
              <button type="button" className="dsh-ssh__button" onClick={() => keyPicker.current?.click()} disabled={!hostPaths} title={hostPaths ? '选择 OpenSSH 私钥，只读取路径' : '文件选择仅桌面版可用，请手动填写 DSH 所在机器上的私钥路径'}>选择密钥文件</button>
              <input ref={keyPicker} type="file" hidden aria-label="选择本机 SSH 私钥" onChange={event => {
                const file = event.currentTarget.files?.[0]
                event.currentTarget.value = ''
                if (!file) return
                try {
                  const path = hostPaths?.pathFor(file)
                  if (!path) throw new Error('无法获取私钥的本机路径，请手动填写。')
                  manager.change('identityFile', path)
                } catch { manager.keyPickerError('无法获取私钥的本机路径，请手动填写。') }
              }} />
            </div>
            <p className="dsh-ssh__hint" id={`${id}-key-help`}>选择 OpenSSH 私钥，不是 .pub 公钥或 PuTTY .ppk。插件只保存路径，不上传私钥内容；加密私钥可填写下方口令或使用 ssh-agent。</p>
          </> : draft.sshAuth === 'auto' ? <p className="dsh-ssh__hint">优先使用本机 SSH 配置、默认密钥或 ssh-agent，也可填写密码供服务器选择。主机可填写 ~/.ssh/config 中的 Host 别名。</p> : <p className="dsh-ssh__hint">只尝试密码认证，不尝试密钥或键盘交互认证。</p>}
          {draft.sshAuth === 'certificate' && <>
            <div className="dsh-ssh__key-row">
              <label className="dsh-ssh__field" htmlFor={`${id}-certificateFile`}>OpenSSH 用户证书<input id={`${id}-certificateFile`} value={draft.certificateFile} onChange={change('certificateFile')} placeholder="~/.ssh/id_ed25519-cert.pub" required spellCheck={false} /></label>
              <button type="button" className="dsh-ssh__button" disabled={!hostPaths} onClick={() => certificatePicker.current?.click()}>选择证书文件</button>
              <input ref={certificatePicker} type="file" hidden aria-label="选择本机 OpenSSH 用户证书" onChange={event => {
                const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (!file) return
                try { const path = hostPaths?.pathFor(file); if (!path) throw new Error(); manager.change('certificateFile', path) }
                catch { manager.keyPickerError('无法获取证书路径，请手动填写。') }
              }} />
            </div>
            <p className="dsh-ssh__hint">使用 SSH CA 签发的用户证书及配套私钥；不是 HTTPS/X.509 证书。</p>
          </>}
          {(draft.sshAuth === 'auto' || draft.sshAuth === 'password') && <label className="dsh-ssh__field" htmlFor={`${id}-password`}>SSH 登录密码 <span className="dsh-ssh__optional">{draft.sshAuth === 'auto' ? '可选' : '必填'}</span><input id={`${id}-password`} type="password" value={draft.password} onChange={change('password')} autoComplete="off" required={draft.sshAuth === 'password'} placeholder="仅保留在当前进程内" /></label>}
          {draft.sshAuth !== 'password' && <label className="dsh-ssh__field" htmlFor={`${id}-passphrase`}>私钥口令 <span className="dsh-ssh__optional">可选</span><input id={`${id}-passphrase`} type="password" value={draft.passphrase} onChange={change('passphrase')} autoComplete="off" placeholder="未加密私钥或已使用 ssh-agent 可留空" /></label>}
          <p className="dsh-ssh__hint">密码和私钥口令不保存到连接记录，重启后需重新填写。首次连接新主机，请先在终端运行 ssh 并核对主机指纹。</p>
        </>}
        <label className="dsh-ssh__field" htmlFor={`${id}-path`}>远程项目目录 <span aria-hidden="true">*</span><input id={`${id}-path`} value={draft.remotePath} onChange={change('remotePath')} placeholder="/home/user/project" required autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-describedby={`${id}-path-help`} /></label>
        <p className="dsh-ssh__hint" id={`${id}-path-help`}>输入绝对路径，或浏览后选择目录。当前显示的目录即将添加的项目。</p>
        <div className="dsh-ssh__actions">
          <button type="button" className="dsh-ssh__button" disabled={inspecting} onClick={() => manager.browse()}>{state.pending.includes('browse') ? '浏览中…' : '浏览目录'}</button>
          <button type="button" className="dsh-ssh__button" disabled={inspecting} onClick={manager.test}>{state.pending.includes('test') ? '测试中…' : '测试连接'}</button>
        </div>
        {ssh && !full && <>
          <label className="dsh-ssh__field" htmlFor={`${id}-localPath`}>本机 SSHFS 挂载路径 <span className="dsh-ssh__optional">{windows && draft.sshAuth === 'auto' ? '可选' : '必填'}</span><input id={`${id}-localPath`} value={draft.localPath} onChange={change('localPath')} placeholder={windows ? 'Z:\\project' : '/mnt/remote-project'} required={!windows || draft.sshAuth !== 'auto'} spellCheck={false} /></label>
          <p className="dsh-ssh__hint">{draft.sshAuth !== 'auto' ? '请先使用同一凭据建立 SSHFS 挂载，再填写挂载路径。自动 SSHFS 共享不能接收这里的密码、密钥或证书。' : windows ? '轻量 SSH 需要 WinFsp 与 SSHFS-Win，或已建立的 SSHFS 挂载。挂载路径必须对应上方整个远程目录。' : '先通过 SSHFS 挂载项目，再填写本机挂载目录。'} 切换到全量模式可直接使用远程文件系统。</p>
        </>}
        {state.directory && <div className="dsh-ssh__browser" aria-label="远程目录浏览器" aria-busy={state.pending.includes('browse')}>
          <div className="dsh-ssh__browser-head"><code title={state.directory.path}>{state.directory.path}</code><button type="button" className="dsh-ssh__text-button" disabled={inspecting || state.directory.path === '/'} onClick={() => manager.browse(parentRemote(state.directory?.path ?? '/'))}>上一级</button></div>
          <ul className="dsh-ssh__directories">{state.directory.directories.map(directory => <li key={directory}><button type="button" disabled={inspecting} onClick={() => manager.browse(joinRemote(state.directory?.path ?? '/', directory))} title={directory}><span aria-hidden="true">▱</span><span>{directory}</span><span aria-hidden="true">›</span></button></li>)}</ul>
          {!state.directory.directories.length && <p className="dsh-ssh__hint dsh-ssh__browser-empty">此目录没有子目录，可以直接添加。</p>}
        </div>}
        {state.info && <p className="dsh-ssh__success" role="status">已连接：{state.info.user} · {state.info.platform} · Python {state.info.python}<span className="dsh-ssh__tested-path">{state.info.path}</span></p>}
        <label className="dsh-ssh__field" htmlFor={`${id}-title`}>工作区名称 <span className="dsh-ssh__optional">可选</span><input id={`${id}-title`} value={draft.title} onChange={change('title')} placeholder="留空使用项目目录名" /></label>
      </fieldset>
      <ErrorNotice message={state.errors.form} />
      <div className="dsh-ssh__form-footer"><p>{full ? '远端需 Linux/WSL、Python 3、Bash 和网络访问。首次添加会安装 Node/DSH，可能需要数分钟。模型配置使用远端 DSH 的设置，不自动复制本机密钥。' : '远端需 Python 3 和 Bash，不安装 DSH。模型沿用本机配置；使用 Native 工具模式。后台任务、原生终端、PTC 和子代理请使用全量模式。'}</p><button type="submit" className="dsh-ssh__button dsh-ssh__button--primary" disabled={busy || inspecting}>{state.pending.includes('add') ? full ? '部署并连接中…' : '连接中…' : '添加到工作区'}</button></div>
    </form>
  </section>
}

function ManagerOverlay({ manager }: Injected) {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot)
  const id = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (state.open) closeButton.current?.focus() }, [state.open])
  useEffect(() => { manager.open(); return () => manager.close() }, [manager])
  if (!state.open) return null
  return <div className="dsh-ssh dsh-ssh--panel">
    <div className="dsh-ssh__dialog" ref={manager.bindDialog} role="region" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1}>
      <header className="dsh-ssh__header"><div className="dsh-ssh__title-icon"><ConnectionIcon /></div><div><h2 id={`${id}-title`}>SSH / WSL 远程工作区</h2><p id={`${id}-description`}>选择轻量连接或全量远程后端，在当前窗口管理项目。</p></div><button ref={closeButton} type="button" className="dsh-ssh__close" onClick={() => { manager.close(); manager.exitPanel() }} aria-label="关闭远程工作区管理" title="返回会话">×</button></header>
      <div className="dsh-ssh__notice" role="status" aria-live="polite">{state.notice}</div>
      <div className="dsh-ssh__body"><WorkspaceForm manager={manager} state={state} /><SavedConnections manager={manager} state={state} /></div>
    </div>
  </div>
}

/** Public client services only; uiWorkspace is resolved on use for optional navigation. */
export const inject = ['connection', 'slots', 'uiWorkspace', 'layout', 'fileUpload']

export function apply(context: unknown): void {
  const ctx = context as ClientContext
  const badges = installWorkspaceBadges(document)
  let manager: Manager | undefined
  ctx.effect(() => () => badges.dispose(), 'dsh-ssh-workspaces: project icons')
  const router = installBackendRouter(ctx as any, records => { badges.update(records); manager?.acceptWorkspaces(records) })
  if (router) ctx.effect(() => () => router.dispose(), 'dsh-ssh-workspaces: backend router')
  else ctx.effect(() => {
    const lifetime = new AbortController()
    let polling = false
    const refresh = () => {
      if (polling || lifetime.signal.aborted) return
      polling = true
      void ctx.connection.rpc.call<HostStatus>(RPC_CHANNEL, `${RPC_PREFIX}/status`, {}, lifetime.signal)
        .then(result => { if (!lifetime.signal.aborted && result.ok) { badges.update(result.value.workspaces); manager?.acceptStatus(result.value) } })
        .catch(() => {})
        .finally(() => { polling = false })
    }
    refresh()
    const timer = setInterval(refresh, 5_000)
    return () => { lifetime.abort(); clearInterval(timer) }
  }, 'dsh-ssh-workspaces: project icon catalog')
  manager = createManager(ctx, () => { void router?.refresh().catch(error => console.error('Remote workspace refresh failed:', error instanceof Error ? error.message : 'unavailable')) }, status => badges.update(status.workspaces))
  const injected = (): Injected => ({ manager: manager! })
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.dshSshWorkspaces = ''
    style.textContent = stylesheet
    document.head.append(style)
    return () => { style.remove() }
  }, 'dsh-ssh-workspaces: stylesheet')
  ctx.effect(() => () => manager!.destroy(), 'dsh-ssh-workspaces: manager lifetime')
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: 'dsh-ssh-workspaces', label: '远程工作区', order: 25, inject: () => ({}),
  }, ConnectionIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', id: 'dsh-ssh-workspaces', key: 'dsh-ssh-workspaces', order: 60, inject: injected,
  }, ManagerOverlay))
}
