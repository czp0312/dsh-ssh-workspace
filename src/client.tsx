import { useEffect, useId, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import stylesheet from './client.css'
import { installBackendRouter } from './client-router.js'
import { installWorkspaceBadges } from './workspace-badges.js'
import { connectionState, CONNECTION_LABELS } from './connection-status.js'
import { PLUGIN_VERSION, RPC_CHANNEL, RPC_PREFIX, sshTarget, targetLabel, type DockerHost, type DockerContainer, type AddWorkspaceRequest, type RemoteDirectory, type RemoteInfo, type RemoteTarget, type ReconnectRequest, type SavedWorkspace, type WorkspaceView, type WorkspaceMode, type SshCredentials } from './types.js'
import { aggregateState, backendState, connectionLabel, environmentLabel, environmentDetail, groupWorkspaces, type ConnectionGroup, type EnvironmentGroup } from './workspace-groups.js'
import type { SkillSyncPreview, SkillSyncResult } from './skills-types.js'

type Disposer = () => void
type Kind = RemoteTarget['kind']
type Area = 'status' | 'distros' | 'form' | 'connections' | 'docker' | 'skills'
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
  'docker/list': { input: DockerHost & { credentials?: SshCredentials }; output: DockerContainer[] }
  'skills/preview': { input: { id: string }; output: SkillSyncPreview }
  'skills/apply': { input: { id: string; planId: string; selected: string[]; overwrite: boolean }; output: SkillSyncResult }
  browse: { input: { target: RemoteTarget; path: string; credentials?: SshCredentials }; output: RemoteDirectory }
  test: { input: { target: RemoteTarget; credentials?: SshCredentials }; output: RemoteInfo }
  add: { input: AddWorkspaceRequest; output: SavedWorkspace }
  reconnect: { input: ReconnectRequest; output: SavedWorkspace }
  'connection/reconnect': { input: { id: string; force?: boolean; credentials?: SshCredentials }; output: void }
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
  inject?(services: string[], setup: (ctx: ClientContext) => void): unknown
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
  dockerLocation: 'local' | 'ssh'
  context: string
  container: string
  dockerUser: string
  remotePath: string
  localPath: string
}

interface Snapshot {
  open: boolean
  view: 'projects' | 'add'
  tab: Kind
  drafts: Record<Kind, Draft>
  status: HostStatus | null
  distros: string[]
  distrosLoaded: boolean
  containers: DockerContainer[]
  skills: { id: string; preview: SkillSyncPreview | null; selected: string[]; overwrite: boolean; result: SkillSyncResult | null } | null
  directory: RemoteDirectory | null
  info: RemoteInfo | null
  pending: readonly string[]
  errors: Record<Area, string | null>
  notice: string | null
  confirmRemove: string | null
  reauth: { id: string; mode: WorkspaceMode; localPath: string; password: string; passphrase: string; connection?: boolean; force?: boolean } | null
}

const emptyDraft = (): Draft => ({ mode: 'full', title: '', host: '', port: '', user: '', sshAuth: 'auto', identityFile: '', certificateFile: '', password: '', passphrase: '', distribution: '', dockerLocation: 'local', context: '', container: '', dockerUser: '', remotePath: '/', localPath: '' })
const mutationPending = (state: Snapshot): boolean => state.pending.some(key => key === 'add' || key === 'skills/apply' || /^(open|switch|reconnect|disconnect|remove):/.test(key))
const errorText = (error: unknown): string => error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '操作未完成，请重试。'
const joinRemote = (path: string, name: string): string => name.startsWith('/') ? name : `${path.replace(/\/+$/, '')}/${name}`
const parentRemote = (path: string): string => path.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/'

/** One immutable snapshot store is shared by the two independently mounted slots. */
function createManager(ctx: ClientContext, onChanged: () => void = () => {}, onStatus: (status: HostStatus) => void = () => {}) {
  let state: Snapshot = {
    open: false, view: 'add', tab: 'ssh', drafts: { ssh: emptyDraft(), wsl: emptyDraft(), docker: emptyDraft() },
    status: null, distros: [], distrosLoaded: false, containers: [], skills: null, directory: null, info: null,
    pending: [], errors: { status: null, distros: null, form: null, connections: null, docker: null, skills: null },
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
  const cancelForm = (): void => { cancel('browse'); cancel('test'); cancel('docker/list') }
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
    void request('status', 'status', {}, 'status', status => { update({ ...(state.status === null ? { view: status.workspaces.length ? 'projects' as const : 'add' as const } : {}), status }); onStatus(status) })
  }
  const loadDistros = (): void => {
    void request('wsl/list', 'wsl/list', {}, 'distros', distros => {
      update({ distros, distrosLoaded: true })
      if (!state.drafts.wsl.distribution && distros[0]) patchDraft('wsl', { distribution: distros[0] })
    })
  }
  const targetOf = (containerOverride?: string): RemoteTarget | null => {
    const draft = state.drafts[state.tab]
    const remotePath = draft.remotePath.trim()
    if (!remotePath.startsWith('/')) { setError('form', '请输入以 / 开头的远程目录，或先浏览目录。'); return null }
    const user = draft.user.trim()
    if (state.tab === 'wsl') {
      if (!draft.distribution) { setError('form', '请先选择一个 WSL 发行版。'); return null }
      return { kind: 'wsl', distribution: draft.distribution, remotePath, ...(user ? { user } : {}) }
    }
    const dockerBase = state.tab === 'docker' ? { kind: 'docker' as const, container: containerOverride ?? draft.container.trim(), remotePath, ...(draft.dockerUser.trim() ? { user: draft.dockerUser.trim() } : {}) } : null
    if (dockerBase && !dockerBase.container) { setError('form', '请选择或填写一个运行中的 Docker 容器。'); return null }
    if (dockerBase && draft.dockerLocation === 'local') return { ...dockerBase, ...(draft.context.trim() ? { context: draft.context.trim() } : {}) }
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
    const via = { kind: 'ssh' as const, host, remotePath: dockerBase ? '/' : remotePath, ...(user ? { user } : {}), ...(port === undefined ? {} : { port }), ...(draft.sshAuth !== 'auto' ? { auth: draft.sshAuth } : {}), ...(keyed ? { identityFile } : {}), ...(draft.sshAuth === 'certificate' ? { certificateFile: draft.certificateFile.trim() } : {}) }
    return dockerBase ? { ...dockerBase, via } : via
  }
  const credentialsOf = (): { credentials?: SshCredentials } => {
    const draft = state.drafts[state.tab]
    if (state.tab === 'wsl' || (state.tab === 'docker' && draft.dockerLocation !== 'ssh')) return {}
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
  const editConnection = (id: string | null, connection = false, force = false): void => {
    const record = state.status?.workspaces.find(row => row.id === id)
    update({ reauth: record ? { id: record.id, mode: record.mode ?? 'light', localPath: record.mode === 'full' ? '' : record.localPath, password: '', passphrase: '', connection, force } : null })
  }
  const loadSkills = (id: string, result: SkillSyncResult | null = null): void => {
    if (mutationPending(state) && !state.pending.includes('skills/apply')) return
    update({ skills: { id, preview: null, selected: [], overwrite: false, result } })
    void request('skills/preview', 'skills/preview', { id }, 'skills', preview => {
      if (state.skills?.id !== id) return
      update({ skills: { ...state.skills, preview, selected: result ? [] : preview.items.filter(row => row.state === 'missing').map(row => row.id) } })
    })
  }

  return {
    subscribe: (listener: () => void): Disposer => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: (): Snapshot => state,
    acceptStatus: (status: HostStatus): void => { if (alive) update({ ...(state.status === null ? { view: status.workspaces.length ? 'projects' as const : 'add' as const } : {}), status }) },
    acceptWorkspaces: (workspaces: WorkspaceView[]): void => { if (alive && state.status) update({ status: { ...state.status, workspaces } }) },
    bindDialog: (element: HTMLElement | null): void => { dialog = element },
    getDialog: (): HTMLElement | null => dialog,
    exitPanel: (): void => { ctx.get('layout')?.selectPanel(null) },
    showProjects: (): void => {
      if (mutationPending(state)) return
      cancelForm()
      patchDraft('ssh', { password: '', passphrase: '' })
      patchDraft('docker', { password: '', passphrase: '' })
      update({ view: 'projects', skills: null })
    },
    newProject: (id?: string, restore = false): void => {
      if (mutationPending(state)) return
      cancelForm()
      const record = state.status?.workspaces.find(row => row.id === id)
      if (record) {
        const target = record.target
        const ssh = sshTarget(target)
        patchDraft(target.kind, { ...emptyDraft(), mode: record.mode ?? 'light', remotePath: restore ? target.remotePath : parentRemote(target.remotePath), title: restore ? record.title : '',
          ...(target.kind === 'wsl' ? { distribution: target.distribution, user: target.user ?? '' } : {}),
          ...(target.kind === 'docker' ? { dockerLocation: target.via ? 'ssh' : 'local', context: target.context ?? '', container: target.container, dockerUser: target.user ?? '' } : {}),
          ...(ssh ? { host: ssh.host, port: ssh.port ? String(ssh.port) : '', user: ssh.user ?? '', sshAuth: ssh.auth ?? 'auto', identityFile: ssh.identityFile ?? '', certificateFile: ssh.certificateFile ?? '' } : {}),
        })
        update({ tab: target.kind })
      }
      update({ view: 'add', notice: null, reauth: null, directory: null, info: null, confirmRemove: null, errors: { ...state.errors, form: null } })
      if (state.tab === 'wsl' && !state.distrosLoaded) loadDistros()
    },
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
      patchDraft('docker', { password: '', passphrase: '' })
      update({ open: false, pending: [], confirmRemove: null, reauth: null, skills: null })
      const returnTo = opener
      queueMicrotask(() => { if (!state.open && returnTo?.isConnected) returnTo.focus() })
    },
    setTab: (tab: Kind): void => {
      if (tab === state.tab || mutationPending(state)) return
      cancelForm()
      update({ tab, directory: null, info: null, errors: { ...state.errors, form: null, docker: null } })
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
      if (state.tab === 'docker' && ['dockerLocation', 'context', 'host', 'port', 'user', 'sshAuth', 'identityFile', 'certificateFile'].includes(field)) update({ containers: [] })
      patchDraft(state.tab, { [field]: value })
      setError('form', null)
    },
    keyPickerError: (message: string): void => setError('form', message),
    refresh,
    loadDistros,
    loadContainers: (): void => {
      if (mutationPending(state)) return
      const target = targetOf('listing')
      if (!target || target.kind !== 'docker') return
      void request('docker/list', 'docker/list', { ...(target.context ? { context: target.context } : {}), ...(target.via ? { via: target.via } : {}), ...credentialsOf() }, 'docker', containers => update({ containers }))
    },
    loadSkills,
    closeSkills: (): void => { if (state.pending.includes('skills/apply')) return; cancel('skills/preview'); update({ skills: null }); setError('skills', null) },
    escape: (): boolean => {
      if (state.confirmRemove) { update({ confirmRemove: null }); return true }
      if (state.reauth) { if (!mutationPending(state)) update({ reauth: null }); return true }
      if (state.skills) {
        if (state.pending.includes('skills/apply')) return true
        cancel('skills/preview')
        update({ skills: null })
        setError('skills', null)
        return true
      }
      if (state.directory) { update({ directory: null }); return true }
      if (state.view === 'add' && (state.status?.workspaces.length ?? 0) > 0) {
        if (mutationPending(state)) return true
        cancelForm()
        patchDraft('ssh', { password: '', passphrase: '' })
        patchDraft('docker', { password: '', passphrase: '' })
        update({ view: 'projects', skills: null })
        return true
      }
      return false
    },
    selectSkill: (id: string): void => {
      const form = state.skills
      if (!form?.preview || state.pending.includes('skills/apply')) return
      const item = form.preview.items.find(row => row.id === id)
      if (!item || item.state === 'equal' || item.state === 'blocked' || (item.state === 'different' && !form.overwrite)) return
      update({ skills: { ...form, selected: form.selected.includes(id) ? form.selected.filter(value => value !== id) : [...form.selected, id] } })
    },
    selectMissingSkills: (clear = false): void => { if (state.skills && !state.pending.includes('skills/apply')) update({ skills: { ...state.skills, selected: clear ? [] : state.skills.preview?.items.filter(row => row.state === 'missing').map(row => row.id) ?? [] } }) },
    overwriteSkills: (overwrite: boolean): void => {
      const form = state.skills
      if (form && !state.pending.includes('skills/apply')) update({ skills: { ...form, overwrite, selected: overwrite ? form.selected : form.selected.filter(id => form.preview?.items.find(row => row.id === id)?.state === 'missing') } })
    },
    applySkills: (): void => {
      const form = state.skills
      if (!form?.preview || !form.selected.length || mutationPending(state)) return
      void request('skills/apply', 'skills/apply', { id: form.id, planId: form.preview.planId, selected: form.selected, overwrite: form.overwrite }, 'skills', result => loadSkills(form.id, result))
    },
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
      void request('add', 'add', { target, mode: draft.mode, ...credentialsOf(), ...(title ? { title } : {}), ...(draft.mode === 'light' && target.kind !== 'wsl' && localPath ? { localPath } : {}) }, 'form', saved => {
        remember(saved)
        patchDraft('ssh', { password: '', passphrase: '' })
        patchDraft('docker', { password: '', passphrase: '' })
        update({ view: 'projects', notice: `已添加「${saved.title}」。项目已登记到侧栏，点击“打开项目”开始工作。` })
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
    reconnectBackend: (id: string, force = false): void => {
      if (mutationPending(state)) return
      cancel('status'); cancelForm()
      update({ notice: null, reauth: null, confirmRemove: null })
      void request(`reconnect:${id}`, 'connection/reconnect', { id, ...(force ? { force } : {}) }, 'connections', () => {
        onChanged(); refresh()
        update({ notice: '全量后端已连接，共享此连接的项目已刷新；未登记目录需单独恢复。' })
      }, message => { refresh(); if (/SSH 密码|口令|认证失败|Permission denied/i.test(message)) editConnection(id, true, force) })
    },
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
      if (!form.connection && original.mode === 'full' && !switching) return
      const credentials = { ...(form.password ? { password: form.password } : {}), ...(form.passphrase ? { passphrase: form.passphrase } : {}) }
      if (form.connection) {
        void request(`reconnect:${form.id}`, 'connection/reconnect', { id: form.id, ...(form.force ? { force: true } : {}), ...(Object.keys(credentials).length ? { credentials } : {}) }, 'connections', () => {
          onChanged(); refresh(); update({ reauth: null, notice: '全量后端已连接，共享此连接的项目已刷新。' })
        }, () => refresh())
        return
      }
      void request(`${switching ? 'switch' : 'reconnect'}:${form.id}`, 'reconnect', { id: form.id, ...(Object.keys(credentials).length ? { credentials } : {}), ...(switching ? { mode: form.mode, ...(form.mode === 'light' && form.localPath.trim() ? { localPath: form.localPath.trim() } : {}) } : {}) }, 'connections', saved => {
        remember(saved); update({ reauth: null, notice: switching ? `已连接${form.mode === 'full' ? '全量' : '轻量'}模式。原模式入口与会话历史保留，可分别继续使用。` : `「${saved.title}」已重新连接。` })
      }, () => refresh())
    },
    disconnect: (id: string): void => {
      const record = state.status?.workspaces.find(row => row.id === id)
      const affected = state.status?.workspaces.filter(row => row.id === id || (record?.backendId && row.backendId === record.backendId && row.mode === 'full')) ?? []
      const reconnects = affected.map(row => `reconnect:${row.id}`)
      if (state.pending.some(key => !reconnects.includes(key) && (key === 'add' || key === 'skills/apply' || /^(open|switch|reconnect|disconnect|remove):/.test(key)))) return
      reconnects.forEach(cancel)
      cancel('status')
      void request(`disconnect:${id}`, 'disconnect', { id }, 'connections', () => {
        if (state.status) {
          update({ status: { ...state.status, workspaces: state.status.workspaces.map(row => affected.some(item => item.id === row.id) ? { ...row, disconnected: true, connectionState: 'disconnected', online: false, connectionError: undefined, ...(row.backendId ? { backendHealth: { connectionState: 'disconnected' as const } } : {}) } : row) }, reauth: null,
            notice: record?.mode === 'full' ? `已断开共享全量连接，${affected.length} 个项目离线。远端 DSH 和任务继续运行；轻量项目不受影响。` : '已断开插件命令通道，文件与会话历史保留；外部 SSHFS / WSL 挂载不卸载。' })
          onStatus(state.status!)
        }
        onChanged(); refresh()
      }, () => refresh())
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
    canOpen: (): boolean => typeof ctx.get('uiWorkspace')?.openWorkspace === 'function' || typeof ctx.get('uiWorkspace')?.startSession === 'function',
    openWorkspace: async (workspaceId: string): Promise<void> => {
      if (mutationPending(state)) return
      const record = state.status?.workspaces.find(row => row.workspaceId === workspaceId)
      if (!record || !record.registered || connectionState(record) !== 'connected') { setError('connections', '请先连接此项目，再打开。'); return }
      const key = `open:${record.id}`
      const controller = new AbortController()
      requests.set(key, controller)
      update({ pending: [...requests.keys()] })
      setError('connections', null)
      try {
        const navigation = ctx.get('uiWorkspace')
        if (!navigation) throw new Error('当前宿主暂不能打开会话，请从原生工作区列表进入。')
        if (typeof navigation.openWorkspace === 'function') await navigation.openWorkspace(workspaceId)
        else navigation.startSession(workspaceId)
        opener = null
      } catch (error) { if (alive && state.open) setError('connections', `无法打开项目：${errorText(error)}`) }
      finally { if (requests.get(key) === controller) { requests.delete(key); update({ pending: [...requests.keys()] }) } }
      // Native navigation unmounts this panel only after the Session is ready.
      // If the connection fails, the form and its reconnect action stay visible.
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

function ProjectRow({ manager, state, item, connection, connectionIndex }: Injected & { state: Snapshot; item: WorkspaceView; connection?: ConnectionGroup; connectionIndex?: number }) {
  const busy = mutationPending(state)
  const rows = connection?.rows ?? [item]
  const connecting = rows.some(row => state.pending.includes(`reconnect:${row.id}`))
  const disconnecting = rows.some(row => state.pending.includes(`disconnect:${row.id}`))
  const opening = state.pending.includes(`open:${item.id}`)
  const managedByGroup = !!connection
  const status = connecting ? 'connecting' : disconnecting ? 'disconnected' : connectionState(item)
  return <li className="dsh-ssh__connection" data-connection-state={status} data-project-id={item.id} aria-busy={connecting || disconnecting || state.pending.includes(`switch:${item.id}`) || state.pending.includes(`remove:${item.id}`)}>
    <div className="dsh-ssh__connection-heading">
      <span className="dsh-ssh__connection-symbol" data-connection-state={status}><ConnectionIcon /></span>
      <span className="dsh-ssh__connection-title"><strong title={item.title}>{item.title}</strong><span className="dsh-ssh__kind" data-mode={item.mode ?? 'light'}>{item.mode === 'full' ? '全量' : '轻量'}</span></span>
      <span className="dsh-ssh__registration" data-connection-state={status} role="status">{disconnecting ? '正在断开' : CONNECTION_LABELS[status]}{item.mode === 'full' ? ' · 远程 DSH 后端' : ' · 本机 Agent'}</span>
    </div>
    <div className="dsh-ssh__connection-details">
      <p className="dsh-ssh__path" title={item.target.remotePath}>{item.target.remotePath}</p>
      {item.target.kind === 'docker' && item.target.user && <p className="dsh-ssh__project-user">容器用户 · {item.target.user}</p>}
      {item.target.kind !== 'docker' && item.target.user && <p className="dsh-ssh__project-user">用户 · {item.target.user}</p>}
      {connectionIndex !== undefined && <p className="dsh-ssh__hint">共享连接 {connectionIndex + 1} · {connectionLabel(item)}</p>}
      {!item.registered && <p className="dsh-ssh__hint">{item.mode === 'full' ? '远端登记已变化。重新添加会恢复目录入口，旧会话保留在远端，不自动关联到新入口。' : '尚未登记，连接后恢复侧栏入口。'}</p>}
      {status === 'error' && <p className="dsh-ssh__connection-error">{item.connectionError || '连接不可用，请重新连接。'}</p>}
    </div>
    {state.confirmRemove === item.id ? <div className="dsh-ssh__remove-confirm" role="group" aria-label={`移除 ${item.title}`}>
      <p>移除此模式的工作区登记？文件和会话历史保留。需要暂停连接时请使用“断开”。</p>
      <div className="dsh-ssh__actions">
        <button type="button" className="dsh-ssh__button dsh-ssh__button--danger" onClick={() => manager.remove(item.id)} disabled={busy}>{state.pending.includes(`remove:${item.id}`) ? '移除中…' : '确认移除'}</button>
        <button type="button" className="dsh-ssh__button" onClick={() => manager.confirmRemove(null)} disabled={busy}>取消</button>
      </div>
    </div> : <div className="dsh-ssh__connection-actions">
      {status === 'connected' && manager.canOpen() && <button type="button" className="dsh-ssh__button dsh-ssh__button--primary" disabled={busy || !item.registered} title="打开此模式的会话输入页；继续旧对话请从侧栏选择" onClick={() => { void manager.openWorkspace(item.workspaceId) }} aria-label={`在当前窗口打开 ${item.title}`}>{opening ? '打开中…' : '打开项目'}</button>}
      {item.mode === 'full' && !item.registered ? <button type="button" className="dsh-ssh__button dsh-ssh__button--primary" disabled={busy} onClick={() => manager.newProject(item.id, true)} aria-label={`重新添加 ${item.title} 的目录`}>重新添加目录</button> : !managedByGroup && status !== 'connected' && <button type="button" className="dsh-ssh__button dsh-ssh__button--primary" disabled={busy} onClick={() => manager.reconnect(item.id)} aria-label={`连接 ${item.title}`}>{connecting ? '连接中…' : '连接'}</button>}
      {!managedByGroup && (status === 'connected' || status === 'connecting') && <button type="button" className="dsh-ssh__text-button" disabled={disconnecting || (busy && !connecting)} onClick={() => manager.disconnect(item.id)} aria-label={`断开 ${item.title}`}>断开</button>}
      <button type="button" className="dsh-ssh__text-button" disabled={busy} onClick={() => manager.editConnection(item.id)} aria-label={`设置 ${item.title} 的连接模式`}>项目模式</button>
      {item.mode === 'full' && <button type="button" className="dsh-ssh__text-button" disabled={busy || status !== 'connected'} onClick={() => manager.loadSkills(item.id)} aria-label={`同步本机 Skill 到 ${item.title}`}>同步 Skill</button>}
      <details className="dsh-ssh__more"><summary aria-label={`${item.title} 的更多操作`} title="更多操作">⋯</summary><div className="dsh-ssh__more-actions">
        {!managedByGroup && status === 'connected' && <button type="button" className="dsh-ssh__text-button" disabled={busy} onClick={() => manager.reconnect(item.id)} aria-label={`重新连接 ${item.title}`}>重新连接</button>}
        <button type="button" className="dsh-ssh__text-button dsh-ssh__remove" disabled={busy} onClick={() => manager.confirmRemove(item.id)} aria-label={`移除 ${item.title} 的登记`}>移除登记</button>
      </div></details>
    </div>}
    <ConnectionSettings manager={manager} state={state} item={item} />
  </li>
}

function ConnectionSettings({ manager, state, item, connection = false }: Injected & { state: Snapshot; item: WorkspaceView; connection?: boolean }) {
  const form = state.reauth?.id === item.id && !!state.reauth.connection === connection ? state.reauth : null
  if (!form) return null
  const busy = mutationPending(state)
  const connecting = state.pending.includes(`reconnect:${item.id}`) || state.pending.includes(`switch:${item.id}`)
  const switching = form.mode !== (item.mode ?? 'light')
  const ssh = sshTarget(item.target)
  return <form className="dsh-ssh__credentials" aria-label={form.connection ? `${item.title} 的连接认证` : `${item.title} 的连接设置`} onSubmit={event => { event.preventDefault(); manager.reconnectWithCredentials() }}>
    <div className="dsh-ssh__settings-head">
      <div><strong>{form.connection ? '连接认证' : '项目设置'}</strong><p className="dsh-ssh__hint">{form.connection ? '认证影响共享此连接的全部项目，不修改项目模式。' : '仅调整当前项目，不影响同一环境中的其他项目。'}</p></div>
      <button type="button" className="dsh-ssh__icon-button" aria-label="关闭连接设置" title="关闭" onClick={() => manager.editCredentials(null)} disabled={busy}>×</button>
    </div>
    {form.connection ? <p className="dsh-ssh__hint">此认证用于共享的全量后端连接，影响该连接下的所有项目，不修改项目模式。</p> : <>
      <label className="dsh-ssh__field" htmlFor={`saved-${item.id}-mode`}>此项目的运行模式<select id={`saved-${item.id}-mode`} value={form.mode} onChange={event => manager.changeConnection('mode', event.target.value)} disabled={busy}><option value="light">轻量模式</option><option value="full">全量模式</option></select></label>
      <div className="dsh-ssh__scope"><strong>{form.mode === 'full' ? '执行与配置：远端 DSH' : 'Agent 与模型：本机 DSH'}</strong><p>{form.mode === 'full' ? '文件、终端、任务和模型请求都由远端处理。Skill 可选择同步，模型与 MCP 使用远端配置。' : '沿用本机模型和 Skill；文件通过共享目录访问，Bash 在远端执行。适合已有环境与低配置主机。'}</p></div>
      <p className="dsh-ssh__hint">仅为「{item.title}」选择模式，同一环境中的其他项目保持原模式。两种模式使用同一远程目录，分别保留会话历史；切换不会迁移旧会话或停止原模式，可从各自入口继续。</p>
      {switching && form.mode === 'full' && <p className="dsh-ssh__hint">首次使用全量模式将安装匹配的远端 DSH，模型配置使用远端环境。</p>}
      {switching && form.mode === 'light' && item.target.kind !== 'wsl' && <label className="dsh-ssh__field" htmlFor={`saved-${item.id}-mount`}>{item.target.kind === 'docker' ? '本机共享/挂载路径' : '本机 SSHFS 挂载路径'}<input id={`saved-${item.id}-mount`} value={form.localPath} onChange={event => manager.changeConnection('localPath', event.target.value)} disabled={busy} placeholder="已有轻量项目可留空复用，否则填写已建立的挂载路径" /></label>}
    </>}
    {ssh && (form.connection || switching || item.mode !== 'full') && <>
      <p className="dsh-ssh__hint">登录方式：{ssh.auth === 'password' ? '仅密码' : ssh.auth === 'certificate' ? '证书' : ssh.auth === 'key' ? '密钥' : '自动选择'}{ssh.identityFile ? ` · ${ssh.identityFile}` : ''}{ssh.certificateFile ? ` · ${ssh.certificateFile}` : ''}。密码和私钥口令仅本次运行保留；留空沿用已提供的凭据。</p>
      {(!ssh.auth || ssh.auth === 'auto' || ssh.auth === 'password') && <label className="dsh-ssh__field">SSH 密码<input type="password" autoComplete="off" value={form.password} onChange={event => manager.changeCredential('password', event.target.value)} disabled={busy} /></label>}
      {ssh.auth !== 'password' && <label className="dsh-ssh__field">私钥口令<input type="password" autoComplete="off" value={form.passphrase} onChange={event => manager.changeCredential('passphrase', event.target.value)} disabled={busy} placeholder="未加密私钥可留空" /></label>}
    </>}
    {!form.connection && item.mode === 'full' && !switching && <p className="dsh-ssh__hint">当前已使用全量模式。连接、断开和认证请在上方的全量连接中操作。</p>}
    <div className="dsh-ssh__settings-actions">
      <button className="dsh-ssh__button dsh-ssh__button--primary" type="submit" disabled={busy || (!form.connection && item.mode === 'full' && !switching)}>{connecting ? '连接中…' : form.connection ? (form.force ? '重新连接全量后端' : '连接全量后端') : switching ? `以${form.mode === 'full' ? '全量' : '轻量'}模式连接` : '连接此模式'}</button>
      <button className="dsh-ssh__text-button" type="button" onClick={() => manager.editCredentials(null)} disabled={busy}>取消</button>
    </div>
  </form>
}

function connectionPending(state: Snapshot, group: ConnectionGroup, action: string): boolean {
  return group.rows.some(row => state.pending.includes(`${action}:${row.id}`))
}

function FullConnection({ manager, state, group, label }: Injected & { state: Snapshot; group: ConnectionGroup; label: string }) {
  const row = group.rows[0]!
  const busy = mutationPending(state)
  const connecting = connectionPending(state, group, 'reconnect')
  const disconnecting = connectionPending(state, group, 'disconnect')
  const status = connecting ? 'connecting' : backendState(group.rows)
  const active = status === 'connected' || status === 'connecting'
  const hidden = group.rows.length - group.visible.length
  const authRow = group.rows.find(item => item.id === state.reauth?.id)
  const error = group.rows.find(item => item.backendHealth?.connectionError)?.backendHealth?.connectionError
  return <section className='dsh-ssh__backend' data-backend-key={group.key} aria-label={`${label} 的全量连接`} aria-busy={connecting || disconnecting}>
    <div className='dsh-ssh__backend-bar'>
      <span className='dsh-ssh__connection-symbol dsh-ssh__connection-symbol--small' data-connection-state={status}><ConnectionIcon small /></span>
      <div className='dsh-ssh__backend-heading'>
        <div><strong>共享全量后端</strong><span className='dsh-ssh__registration' data-connection-state={status} role='status'>{disconnecting ? '正在断开' : CONNECTION_LABELS[status]}</span></div>
        <p className='dsh-ssh__hint'>{label} · {connectionLabel(row)}</p>
      </div>
      <div className='dsh-ssh__environment-actions'>
        {active ? <button type='button' className='dsh-ssh__button' disabled={disconnecting || (busy && !connecting)} onClick={() => manager.disconnect(row.id)} aria-label={`断开 ${label} 的全量连接`}>{disconnecting ? '正在断开…' : connecting ? '取消连接' : '断开连接'}</button> : <button type='button' className='dsh-ssh__button dsh-ssh__button--primary' disabled={busy} onClick={() => manager.reconnectBackend(row.id)} aria-label={`连接 ${label} 的全量连接`}>连接</button>}
        <details className='dsh-ssh__more'><summary aria-label={`${label} 的连接操作`} title="连接操作">⋯</summary><div className='dsh-ssh__more-actions'>
          <button type='button' className='dsh-ssh__text-button' disabled={busy} onClick={() => manager.reconnectBackend(row.id, true)}>重新连接</button>
          {sshTarget(row.target) && <button type='button' className='dsh-ssh__text-button' disabled={busy} onClick={() => manager.editConnection(row.id, true, active)}>连接认证</button>}
          <button type='button' className='dsh-ssh__text-button' disabled={busy} onClick={() => manager.newProject(row.id)}>使用此连接添加项目</button>
        </div></details>
      </div>
    </div>
    <p className='dsh-ssh__environment-note'>影响 {group.rows.length} 个全量项目：{group.rows.map(item => item.title).join('、')}。断开或重连只影响这些项目，轻量项目不受影响，远端任务继续运行。{hidden > 0 && <strong> 当前筛选隐藏了 {hidden} 个受影响项目。</strong>}</p>
    <ErrorNotice message={error ?? null} />
    {authRow && <ConnectionSettings manager={manager} state={state} item={authRow} connection />}
  </section>
}

function Environment({ manager, state, group }: Injected & { state: Snapshot; group: EnvironmentGroup }) {
  const [expanded, setExpanded] = useState(true)
  const id = useId()
  const busy = mutationPending(state)
  const label = environmentLabel(group.target)
  const status = aggregateState(group.rows.map(row => {
    const connection = group.connections.find(item => item.rows.includes(row))
    if (connection && connectionPending(state, connection, 'reconnect')) return 'connecting'
    if (!connection && state.pending.includes(`reconnect:${row.id}`)) return 'connecting'
    return connectionState(row)
  }))
  return <li className='dsh-ssh__environment' data-environment-key={group.key}>
    <header className='dsh-ssh__environment-heading'>
      <button type='button' className='dsh-ssh__environment-toggle' aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded(!expanded)} aria-label={`${expanded ? '收起' : '展开'} ${label} 的项目`}>
        <span className='dsh-ssh__chevron' aria-hidden='true'>{expanded ? '▾' : '›'}</span>
        <span className='dsh-ssh__connection-symbol' data-connection-state={status}><ConnectionIcon /></span>
        <span className='dsh-ssh__environment-name'><strong>{label}</strong><span>{environmentDetail(group.target)} · {status === 'partial' ? '部分连接' : CONNECTION_LABELS[status]} · {group.rows.length} 个项目{group.rows.length !== group.visible.length ? `（显示 ${group.visible.length} 个）` : ''}</span></span>
      </button>
      <button type='button' className='dsh-ssh__button' disabled={busy} onClick={() => manager.newProject(group.visible[0]!.id)} aria-label={`向 ${label} 添加项目`}>＋ 添加项目</button>
    </header>
    <div id={id} hidden={!expanded}>
      {group.connections.map((connection, index) => connection.visible.length > 0 && <FullConnection key={connection.key} manager={manager} state={state} group={connection} label={group.connections.length > 1 ? `${label} · ${connectionLabel(connection.rows[0]!)} · 连接 ${index + 1}` : label} />)}
      <section className='dsh-ssh__projects' aria-label={`${label} 的项目目录`}>
        <ul className='dsh-ssh__environment-projects'>{group.visible.map(item => {
          const index = group.connections.findIndex(connection => connection.rows.includes(item))
          return <ProjectRow key={item.id} manager={manager} state={state} item={item} connection={group.connections[index]} connectionIndex={index >= 0 && group.connections.length > 1 ? index : undefined} />
        })}</ul>
      </section>
    </div>
  </li>
}

function SavedConnections({ manager, state }: Injected & { state: Snapshot }) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const busy = mutationPending(state)
  const workspaces = state.status?.workspaces ?? []
  const online = workspaces.filter(row => connectionState(row) === 'connected').length
  const matches = (row: WorkspaceView) => {
    const matches = `${row.title} ${describeTarget(row.target)} ${row.target.remotePath}`.toLowerCase().includes(search.trim().toLowerCase())
    return matches && (filter === 'all' || filter === row.mode || filter === row.target.kind || (filter === 'offline' && connectionState(row) !== 'connected'))
  }
  const groups = groupWorkspaces(workspaces, matches)
  const visible = groups.flatMap(group => group.visible)
  return <section className="dsh-ssh__saved" aria-labelledby="dsh-ssh-saved-heading">
    <div className="dsh-ssh__section-head">
      <div><h3 id="dsh-ssh-saved-heading">远程项目 <span className="dsh-ssh__count">{workspaces.length}</span></h3><p className="dsh-ssh__hint">{online} 个已连接 · {workspaces.length - online} 个离线 · 旧对话可从左侧项目展开。</p></div>
      <div className="dsh-ssh__actions">
      <button type="button" className="dsh-ssh__text-button" onClick={manager.refresh} disabled={state.pending.includes('status')} aria-label="刷新项目列表">
        {state.pending.includes('status') ? '刷新中…' : '刷新'}
      </button>
      <button type="button" className="dsh-ssh__button dsh-ssh__button--primary" aria-label="添加项目" onClick={() => manager.newProject()} disabled={busy}><span aria-hidden="true">＋</span> 添加项目</button>
      </div>
    </div>
    {!!workspaces.length && <div className="dsh-ssh__filters"><label className="dsh-ssh__field dsh-ssh__field--search"><span className="dsh-ssh__sr-only">搜索远程项目</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索项目、设备或路径" /></label><label className="dsh-ssh__field"><span className="dsh-ssh__sr-only">筛选远程项目</span><select value={filter} onChange={event => setFilter(event.target.value)}><option value="all">全部项目</option><option value="full">全量模式</option><option value="light">轻量模式</option><option value="offline">未连接 / 异常</option><option value="ssh">SSH</option><option value="wsl">WSL</option><option value="docker">Docker</option></select></label><span className="dsh-ssh__filter-count" aria-live="polite">{visible.length === workspaces.length ? `共 ${workspaces.length} 个项目` : `显示 ${visible.length} / ${workspaces.length}`}</span></div>}
    <ErrorNotice message={state.errors.status} />
    <ErrorNotice message={state.errors.connections} />
    {!workspaces.length && <div className="dsh-ssh__empty">
      <ConnectionIcon /><p>{state.pending.includes('status') ? '正在读取工作区…' : state.errors.status ? '暂时无法读取工作区' : '还没有远程工作区'}</p>
      <span>{state.errors.status ? '点击刷新重试。' : '添加后，也会显示在原生工作区列表中。'}</span>
      {!state.pending.includes('status') && !state.errors.status && <button type="button" className="dsh-ssh__button dsh-ssh__button--primary" onClick={() => manager.newProject()} disabled={busy}>添加第一个项目</button>}
    </div>}
    {!!workspaces.length && !visible.length && <p className="dsh-ssh__empty">没有符合条件的项目。请调整搜索或筛选。</p>}
    <ul className="dsh-ssh__saved-list">
      {groups.map(group => <Environment key={group.key} manager={manager} state={state} group={group} />)}
    </ul>
    <ModeGuide compact />
  </section>
}

function ModeGuide({ compact = false }: { compact?: boolean }) {
  return <aside className={`dsh-ssh__guide${compact ? ' dsh-ssh__guide--compact' : ''}`} aria-label="两种模式的能力说明">
    <h3>让项目在合适的位置运行</h3>
    <div><strong>全量模式 <span>完整远程环境</span></strong><p>Agent、文件、终端和后台任务都在远端 DSH 运行。适合长任务、远程依赖与容器开发，无需文件挂载。</p><small>使用远端模型与配置；本机 Skill 可按需同步。</small></div>
    <div><strong>轻量模式 <span>本项目特色</span></strong><p>保留本机 Agent、模型和 Skill，直接操作远程文件与 Bash。远端不安装 DSH，适合 WSL、已有挂载和低配置服务器。</p><small>需要文件共享；使用 Native 工具模式，不提供原生交互终端、PTC 或子代理。</small></div>
    <p className="dsh-ssh__hint">可随时在“项目模式”中选择另一模式。文件共享，会话分别保留；断开连接不会删除项目。</p>
  </aside>
}

function describeTarget(target: RemoteTarget): string {
  return `${targetLabel(target)}${target.kind === 'wsl' && target.user ? ' · ' + target.user : ''}`
}

function SkillSyncPanel({ manager, state }: Injected & { state: Snapshot }) {
  const [search, setSearch] = useState('')
  const form = state.skills!
  const workspace = state.status?.workspaces.find(row => row.id === form.id)
  const busy = state.pending.includes('skills/apply')
  const loading = state.pending.includes('skills/preview')
  const online = !!workspace && connectionState(workspace) === 'connected'
  const selected = form.preview?.items.filter(row => form.selected.includes(row.id)) ?? []
  const bytes = selected.reduce((sum, row) => sum + row.bytes, 0)
  const counts = form.preview ? {
    missing: form.preview.items.filter(row => row.state === 'missing').length,
    different: form.preview.items.filter(row => row.state === 'different').length,
    equal: form.preview.items.filter(row => row.state === 'equal').length,
    blocked: form.preview.items.filter(row => row.state === 'blocked').length,
  } : null
  const labels = { missing: '远端缺少', equal: '已一致', different: '内容不同', blocked: '不可同步' }
  const visible = form.preview?.items.filter(row => `${row.name} ${row.description} ${row.source}`.toLowerCase().includes(search.toLowerCase().trim())) ?? []
  return <section className="dsh-ssh__skills" aria-labelledby="dsh-ssh-skills-title" aria-busy={loading || busy}>
    <div className="dsh-ssh__section-head"><h3 id="dsh-ssh-skills-title">同步本机 Skill</h3><button className="dsh-ssh__text-button" type="button" disabled={busy} onClick={manager.closeSkills}>返回工作区</button></div>
    <p className="dsh-ssh__destination">目标：{workspace?.title ?? '远程工作区'} · {workspace ? describeTarget(workspace.target) : ''}</p>
    {form.preview && <details className="dsh-ssh__hint"><summary>查看远端保存路径</summary><p className="dsh-ssh__path">{form.preview.destination}</p></details>}
    <p className="dsh-ssh__hint">选择本机用户技能或自定义技能，连同目录内的脚本和资源推送到远端。远端自己的技能会保留；脚本依赖和系统路径仍需适配远端。</p>
    {!online && <ErrorNotice message="连接已断开，请返回工作区重新连接，再读取技能列表。" />}
    <ErrorNotice message={state.errors.skills} />
    {form.result && <ul className="dsh-ssh__sync-results" aria-label="同步结果">{form.result.items.map(row => <li key={row.id} data-result={row.status}><strong>{row.name}</strong>：{row.status === 'created' ? '已推送' : row.status === 'updated' ? '已更新' : `失败：${row.message}`}</li>)}</ul>}
    {counts && <div className="dsh-ssh__skill-summary" aria-label="技能差异概览">
      {counts.missing > 0 && <span data-state="missing">{counts.missing} 项远端缺少</span>}
      {counts.different > 0 && <span data-state="different">{counts.different} 项内容不同</span>}
      {counts.equal > 0 && <span data-state="equal">{counts.equal} 项已一致</span>}
      {counts.blocked > 0 && <span data-state="blocked">{counts.blocked} 项不可同步</span>}
      {!counts.missing && !counts.different && !counts.blocked && <span data-state="equal">全部技能已一致</span>}
    </div>}
    <div className="dsh-ssh__skill-toolbar"><div className="dsh-ssh__actions"><button className="dsh-ssh__button" type="button" disabled={busy || loading || !online} onClick={() => manager.loadSkills(form.id, form.result)}>{loading ? '读取中…' : '刷新差异'}</button><button className="dsh-ssh__text-button" type="button" disabled={busy || loading} onClick={() => manager.selectMissingSkills()}>选择缺失项</button><button className="dsh-ssh__text-button" type="button" disabled={busy || loading} onClick={() => manager.selectMissingSkills(true)}>清空选择</button></div><label className="dsh-ssh__field dsh-ssh__field--search">搜索 Skill<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="按名称、描述或来源筛选" /></label></div>
    <label className="dsh-ssh__sync-overwrite"><input type="checkbox" checked={form.overwrite} disabled={busy || loading} onChange={event => manager.overwriteSkills(event.target.checked)} />允许覆盖所选差异项（内容不同的项需要另外勾选）</label>
    {loading && <p className="dsh-ssh__hint" role="status">正在比较本机与远端的技能…</p>}
    {form.preview && !form.preview.items.length && <p className="dsh-ssh__empty">本机 DSH 尚未发现可同步的用户或自定义技能。请先在 DSH 中配置 Skill，再刷新。</p>}
    <ul className="dsh-ssh__skill-list">{visible.map(row => <li key={row.id} data-state={row.state}>
      <label><input type="checkbox" checked={form.selected.includes(row.id)} disabled={busy || loading || !online || row.state === 'blocked' || row.state === 'equal' || (row.state === 'different' && !form.overwrite)} onChange={() => manager.selectSkill(row.id)} /><span><strong>{row.name}</strong><span className="dsh-ssh__skill-state">{labels[row.state]}</span><p>{row.description}</p><small>{row.files} 个文件 · {(row.bytes / 1024).toFixed(1)} KiB · {row.source}</small>{row.path && <code title={row.path}>…/{row.path.split(/[\\/]/).slice(-3).join('/')}</code>}{row.reason && <p className="dsh-ssh__connection-error">{row.reason}</p>}</span></label>
    </li>)}</ul>
    {!!search && <p className="dsh-ssh__hint">{!visible.length ? '没有匹配的技能。' : ''}筛选不会取消已勾选项；同步时会包含所有已选项。</p>}
    <div className="dsh-ssh__sync-footer"><span>已选 {selected.length} 项 · {(bytes / 1024 / 1024).toFixed(2)} MiB<span className="dsh-ssh__hint">每批最多 128 项 / 20 MiB。DSH 会按需加载已同步的技能。</span></span><button type="button" className="dsh-ssh__button dsh-ssh__button--primary" disabled={busy || loading || !online || !selected.length || selected.length > 128 || bytes > 20 * 1024 * 1024} onClick={manager.applySkills}>{busy ? '同步中…' : `同步所选 ${selected.length} 项`}</button></div>
  </section>
}

function RemotePathCrumbs({ path, disabled, onNavigate }: { path: string; disabled: boolean; onNavigate: (path: string) => void }) {
  const parts = path.split('/').filter(Boolean)
  const nodes = [{ label: '/', path: '/' }, ...parts.map((part, index) => ({ label: part, path: `/${parts.slice(0, index + 1).join('/')}` }))]
  return <nav className="dsh-ssh__crumbs" aria-label="远程目录路径">
    {nodes.map((node, index) => <span className="dsh-ssh__crumb" key={node.path}>
      {index > 0 && <span className="dsh-ssh__crumb-sep" aria-hidden="true">›</span>}
      <button type="button" disabled={disabled || index === nodes.length - 1} title={node.path} onClick={() => onNavigate(node.path)}>{node.label}</button>
    </span>)}
  </nav>
}

function WorkspaceForm({ manager, state }: Injected & { state: Snapshot }) {
  const id = useId()
  const [dirFilter, setDirFilter] = useState('')
  const keyPicker = useRef<HTMLInputElement>(null)
  const certificatePicker = useRef<HTMLInputElement>(null)
  const hostPaths = (globalThis as typeof globalThis & { __DSH_HOST_PATHS__?: { pathFor(file: File): string } }).__DSH_HOST_PATHS__
  const draft = state.drafts[state.tab]
  const docker = state.tab === 'docker'
  const ssh = state.tab === 'ssh' || (docker && draft.dockerLocation === 'ssh')
  const full = draft.mode === 'full'
  const windows = state.status?.platform === 'win32'
  const busy = mutationPending(state)
  const inspecting = state.pending.includes('test') || state.pending.includes('browse')
  const change = (field: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => manager.change(field, event.currentTarget.value)
  useEffect(() => setDirFilter(''), [state.tab, state.directory?.path])
  const directories = state.directory ? state.directory.directories.filter(name => name.toLowerCase().includes(dirFilter.trim().toLowerCase())) : []
  return <section className="dsh-ssh__new" aria-labelledby={`${id}-heading`}>
    <div className="dsh-ssh__section-head">
      <div><h3 id={`${id}-heading`}>添加远程项目</h3><p className="dsh-ssh__hint">先选择连接方式与运行位置，再指定远程目录。</p></div>
      <button className="dsh-ssh__text-button" type="button" disabled={busy} onClick={manager.showProjects}>返回项目列表</button>
    </div>
    <div className="dsh-ssh__tabs" role="tablist" aria-label="连接方式" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return
      const kinds: Kind[] = state.status && state.status.platform !== 'win32' ? ['ssh', 'docker'] : ['ssh', 'wsl', 'docker']
      const next: Kind = event.key === 'Home' ? kinds[0]! : event.key === 'End' ? kinds.at(-1)! : kinds[(kinds.indexOf(state.tab) + (event.key === 'ArrowLeft' ? kinds.length - 1 : 1)) % kinds.length]!
      event.preventDefault()
      manager.setTab(next)
      document.getElementById(`${id}-${next}`)?.focus()
    }}>
      {(['ssh', 'wsl', 'docker'] as const).map(kind => <button type="button" role="tab" key={kind} id={`${id}-${kind}`} aria-selected={state.tab === kind} aria-controls={`${id}-panel`} tabIndex={state.tab === kind ? 0 : -1} disabled={busy || (kind === 'wsl' && state.status !== null && state.status.platform !== 'win32')} onClick={() => manager.setTab(kind)}>{kind.toUpperCase()}</button>)}
    </div>
    <form id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${state.tab}`} onSubmit={event => { event.preventDefault(); manager.add() }}>
      <section className="dsh-ssh__card">
        <div className="dsh-ssh__card-head"><h4>运行模式</h4><span className="dsh-ssh__hint">模式属于项目，可随时切换</span></div>
        <fieldset className="dsh-ssh__modes" disabled={busy}>
          <legend className="dsh-ssh__sr-only">运行模式</legend>
          {(['full', 'light'] as const).map(mode => <label key={mode} className={`dsh-ssh__mode${draft.mode === mode ? ' dsh-ssh__mode--selected' : ''}`}>
            <input type="radio" name={`${id}-mode`} value={mode} checked={draft.mode === mode} onChange={() => manager.setMode(mode)} />
            <span><strong>{mode === 'light' ? '轻量模式' : '全量模式'}</strong><small>{mode === 'light' ? '不安装远端 DSH · 本机运行 Agent' : '安装远端 DSH · 完整远程后端'}</small></span>
          </label>)}
        </fieldset>
        <p className="dsh-ssh__intro">{full
          ? `${docker ? '通过 Docker exec 在容器内部署版本匹配的 DSH 后端，无需容器开放 SSH 端口。' : ssh ? '使用本机 SSH 配置与密钥连接，自动部署版本匹配的远程 DSH 后端。' : '在 WSL 内部署完整 DSH 后端，通过本机隧道连接，无需 SSH 服务。'} 文件、Agent、终端与任务均在远端运行，无需 SSHFS 挂载。`
          : `${docker ? '通过已有共享/挂载路径访问文件，通过 Docker exec 执行命令。' : ssh ? '通过 SSHFS 挂载访问文件、通过 SSH 执行命令。' : '通过 Windows 的 WSL 目录共享访问文件、通过 WSL 执行命令。'} Agent 在本机运行，沿用本机 Skill，远端不安装 DSH。`}</p>
      </section>
      <section className="dsh-ssh__card">
        <div className="dsh-ssh__card-head"><h4>{docker ? 'Docker 连接' : ssh ? 'SSH 连接' : 'WSL 连接'}</h4></div>
        <fieldset className="dsh-ssh__fields" disabled={busy}>
          <legend className="dsh-ssh__sr-only">{docker ? 'Docker 连接信息' : ssh ? 'SSH 连接信息' : 'WSL 连接信息'}</legend>
        {docker && <>
          <label className="dsh-ssh__field" htmlFor={`${id}-dockerLocation`}>Docker 所在位置<select id={`${id}-dockerLocation`} value={draft.dockerLocation} onChange={change('dockerLocation')}><option value="local">本机 Docker / Docker Context</option><option value="ssh">SSH 服务器上的 Docker</option></select></label>
          {!ssh && <label className="dsh-ssh__field" htmlFor={`${id}-context`}>Docker Context <span className="dsh-ssh__optional">可选</span><input id={`${id}-context`} value={draft.context} onChange={change('context')} placeholder="留空使用 Docker CLI 当前上下文" /><span className="dsh-ssh__hint">可填写已配置的远程 Context 名称。此环境需要可用的 Docker CLI。</span></label>}
        </>}
        {ssh ? <div className="dsh-ssh__host-row">
          <label className="dsh-ssh__field" htmlFor={`${id}-host`}>主机或 SSH 别名 <span aria-hidden="true">*</span><input id={`${id}-host`} value={draft.host} onChange={change('host')} placeholder="dev-server / 192.168.1.10" required autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
          <label className="dsh-ssh__field" htmlFor={`${id}-port`}>端口<input id={`${id}-port`} value={draft.port} onChange={change('port')} type="number" min={1} max={65535} inputMode="numeric" placeholder="SSH 配置" /></label>
        </div> : !docker && <div className="dsh-ssh__distro-row">
          <label className="dsh-ssh__field" htmlFor={`${id}-distro`}>WSL 发行版 <span aria-hidden="true">*</span><select id={`${id}-distro`} value={draft.distribution} onChange={change('distribution')} required disabled={state.pending.includes('wsl/list')}>
            <option value="">{state.pending.includes('wsl/list') ? '正在读取发行版…' : '请选择发行版'}</option>
            {draft.distribution && !state.distros.includes(draft.distribution) && <option value={draft.distribution}>{draft.distribution}（未发现）</option>}
            {state.distros.map(distro => <option key={distro} value={distro}>{distro}</option>)}
          </select></label>
          <button type="button" className="dsh-ssh__button" onClick={manager.loadDistros} disabled={state.pending.includes('wsl/list')}>刷新列表</button>
        </div>}
        {state.tab === 'wsl' && <>
          <ErrorNotice message={state.errors.distros} />
          {state.distrosLoaded && !state.distros.length && <p className="dsh-ssh__hint">未发现 WSL 发行版。安装并启动发行版后刷新列表。</p>}
        </>}
        {(!docker || ssh) && <label className="dsh-ssh__field" htmlFor={`${id}-user`}>{docker ? 'SSH 用户名' : '用户名'} <span className="dsh-ssh__optional">可选</span><input id={`${id}-user`} value={draft.user} onChange={change('user')} placeholder={ssh ? '留空使用 SSH 配置' : '留空使用发行版默认用户'} autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>}
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
          <div className="dsh-ssh__secret-row">
            {(draft.sshAuth === 'auto' || draft.sshAuth === 'password') && <label className="dsh-ssh__field" htmlFor={`${id}-password`}>SSH 登录密码 <span className="dsh-ssh__optional">{draft.sshAuth === 'auto' ? '可选' : '必填'}</span><input id={`${id}-password`} type="password" value={draft.password} onChange={change('password')} autoComplete="off" required={draft.sshAuth === 'password'} placeholder="仅保留在当前进程内" /></label>}
            {draft.sshAuth !== 'password' && <label className="dsh-ssh__field" htmlFor={`${id}-passphrase`}>私钥口令 <span className="dsh-ssh__optional">可选</span><input id={`${id}-passphrase`} type="password" value={draft.passphrase} onChange={change('passphrase')} autoComplete="off" placeholder="未加密私钥或已使用 ssh-agent 可留空" /></label>}
          </div>
          <p className="dsh-ssh__hint">密码和私钥口令不保存到连接记录，重启后需重新填写。首次连接新主机，请先在终端运行 ssh 并核对主机指纹。</p>
        </>}
        {docker && <>
          <div className="dsh-ssh__distro-row"><label className="dsh-ssh__field" htmlFor={`${id}-container`}>容器名称或 ID<input id={`${id}-container`} value={draft.container} onChange={change('container')} placeholder="先读取列表，或填写已运行容器" required list={`${id}-containers`} autoCapitalize="none" spellCheck={false} /><datalist id={`${id}-containers`}>{state.containers.filter(row => row.state === 'running').map(row => <option key={row.id} value={row.id}>{row.name} · {row.image}</option>)}</datalist></label><button type="button" className="dsh-ssh__button" disabled={state.pending.includes('docker/list')} onClick={manager.loadContainers}>{state.pending.includes('docker/list') ? '读取中…' : '读取容器'}</button></div>
          <ErrorNotice message={state.errors.docker} />
          {!!state.containers.length && <ul className="dsh-ssh__container-list" aria-label="Docker 容器列表">{state.containers.map(row => <li key={row.id}><button type="button" className="dsh-ssh__text-button" disabled={row.state !== 'running'} onClick={() => manager.change('container', row.id)} title={row.id}>{row.name} · {row.image} · {row.state === 'running' ? '运行中' : '已停止'}</button></li>)}</ul>}
          <label className="dsh-ssh__field" htmlFor={`${id}-dockerUser`}>容器内用户 <span className="dsh-ssh__optional">可选</span><input id={`${id}-dockerUser`} value={draft.dockerUser} onChange={change('dockerUser')} placeholder="留空使用容器默认用户；支持 UID:GID" /></label>
          <p className="dsh-ssh__hint">仅连接已有的运行中容器，不自动启动或重建。容器内需 Python 3、Bash；全量模式还需 glibc Linux 和网络。所选用户需有有效的 home 目录。</p>
        </>}
        </fieldset>
      </section>
      <section className="dsh-ssh__card">
        <div className="dsh-ssh__card-head"><h4>项目目录</h4><span className="dsh-ssh__hint">远程绝对路径</span></div>
        <fieldset className="dsh-ssh__fields" disabled={busy}>
          <legend className="dsh-ssh__sr-only">项目目录</legend>
          <div className="dsh-ssh__path-row">
            <label className="dsh-ssh__field" htmlFor={`${id}-path`}>远程项目目录 <span aria-hidden="true">*</span><input id={`${id}-path`} value={draft.remotePath} onChange={change('remotePath')} placeholder="/home/user/project" required autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-describedby={`${id}-path-help`} /></label>
            <div className="dsh-ssh__path-actions">
              <button type="button" className="dsh-ssh__button" disabled={inspecting} onClick={() => manager.browse()}>{state.pending.includes('browse') ? '浏览中…' : '浏览目录'}</button>
              <button type="button" className="dsh-ssh__button" disabled={inspecting} onClick={manager.test}>{state.pending.includes('test') ? '测试中…' : '测试连接'}</button>
            </div>
          </div>
          <p className="dsh-ssh__hint" id={`${id}-path-help`}>输入绝对路径，或浏览后选择目录。当前目录将作为项目目录。</p>
          {!docker && ssh && !full && <>
            <label className="dsh-ssh__field" htmlFor={`${id}-localPath`}>本机 SSHFS 挂载路径 <span className="dsh-ssh__optional">{windows && draft.sshAuth === 'auto' ? '可选' : '必填'}</span><input id={`${id}-localPath`} value={draft.localPath} onChange={change('localPath')} placeholder={windows ? 'Z:\\project' : '/mnt/remote-project'} required={!windows || draft.sshAuth !== 'auto'} spellCheck={false} /></label>
            <p className="dsh-ssh__hint">{draft.sshAuth !== 'auto' ? '请先使用同一凭据建立 SSHFS 挂载，再填写挂载路径。自动 SSHFS 共享不能接收这里的密码、密钥或证书。' : windows ? '轻量 SSH 需要 WinFsp 与 SSHFS-Win，或已建立的 SSHFS 挂载。挂载路径必须对应上方整个远程目录。' : '先通过 SSHFS 挂载项目，再填写本机挂载目录。'} 切换到全量模式可直接使用远程文件系统。</p>
          </>}
          {docker && !full && <><label className="dsh-ssh__field" htmlFor={`${id}-localPath`}>本机共享/挂载路径<input id={`${id}-localPath`} value={draft.localPath} onChange={change('localPath')} placeholder={windows ? 'D:\\projects\\demo' : '/home/user/projects/demo'} required /></label><p className="dsh-ssh__hint">本机目录必须与上方容器目录双向共享，例如已有 bind mount。远端 Docker 可使用已建立的文件挂载。添加时会实际校验，普通本机目录不能冒充远程目录。</p></>}
          {state.directory && <div className="dsh-ssh__browser" aria-label="远程目录浏览器" aria-busy={state.pending.includes('browse')}>
            <div className="dsh-ssh__browser-head">
              <RemotePathCrumbs path={state.directory.path} disabled={inspecting} onNavigate={path => manager.browse(path)} />
              <button type="button" className="dsh-ssh__text-button" disabled={inspecting || state.directory.path === '/'} onClick={() => manager.browse(parentRemote(state.directory?.path ?? '/'))}>上一级</button>
            </div>
            {state.directory.directories.length > 8 && <label className="dsh-ssh__browser-filter"><span className="dsh-ssh__sr-only">筛选子目录</span><input type="search" value={dirFilter} onChange={event => setDirFilter(event.target.value)} placeholder="筛选子目录" /></label>}
            <ul className="dsh-ssh__directories">{directories.map(directory => <li key={directory}><button type="button" disabled={inspecting} onClick={() => manager.browse(joinRemote(state.directory?.path ?? '/', directory))} title={directory}><span aria-hidden="true">▱</span><span>{directory}</span><span aria-hidden="true">›</span></button></li>)}</ul>
            {!directories.length && <p className="dsh-ssh__hint dsh-ssh__browser-empty">{state.directory.directories.length ? '没有匹配的子目录。' : '此目录没有子目录，可以直接添加。'}</p>}
            <div className="dsh-ssh__browser-foot"><span className="dsh-ssh__hint">当前目录将作为项目目录</span><code title={state.directory.path}>{state.directory.path}</code></div>
          </div>}
          {state.info && <p className="dsh-ssh__success" role="status">已连接：{state.info.user} · {state.info.platform} · Python {state.info.python}<span className="dsh-ssh__tested-path">{state.info.path}</span></p>}
          <label className="dsh-ssh__field" htmlFor={`${id}-title`}>工作区名称 <span className="dsh-ssh__optional">可选</span><input id={`${id}-title`} value={draft.title} onChange={change('title')} placeholder="留空使用项目目录名" /></label>
        </fieldset>
      </section>
      <ErrorNotice message={state.errors.form} />
      <div className="dsh-ssh__form-footer"><p>{full ? '远端需 Linux/WSL、Python 3、Bash 和网络访问。首次添加会部署远端 DSH，可能需要数分钟；模型配置使用远端环境，不自动复制本机密钥或插件。' : '远端需 Python 3 和 Bash，不安装 DSH。模型沿用本机配置；使用 Native 工具模式。后台任务、原生终端、PTC 和子代理请使用全量模式。'}</p><button type="submit" className="dsh-ssh__button dsh-ssh__button--primary" disabled={busy || inspecting}>{state.pending.includes('add') ? full ? '部署并连接中…' : '连接中…' : '添加到工作区'}</button></div>
    </form>
  </section>
}

function ManagerOverlay({ manager }: Injected) {
  const state = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot)
  const id = useId()
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (state.open) closeButton.current?.focus() }, [state.open])
  useEffect(() => { manager.open(); return () => manager.close() }, [manager])
  useEffect(() => {
    if (!state.open) return
    const dialog = manager.getDialog()
    if (!dialog) return
    const dismissMenus = (except?: Node): void => {
      for (const details of dialog.querySelectorAll<HTMLDetailsElement>('details[open]')) {
        if (!except || !details.contains(except)) details.open = false
      }
    }
    const onPointerDown = (event: Event): void => dismissMenus(event.target as Node)
    const onClick = (event: Event): void => {
      if ((event.target as Element).closest('.dsh-ssh__more-actions button')) dismissMenus()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const open = [...dialog.querySelectorAll<HTMLDetailsElement>('details[open]')]
      if (open.length) {
        event.preventDefault()
        event.stopPropagation()
        for (const details of open) details.open = false
        return
      }
      if (manager.escape()) {
        event.preventDefault()
        event.stopPropagation()
      }
    }
    dialog.addEventListener('pointerdown', onPointerDown)
    dialog.addEventListener('click', onClick)
    dialog.addEventListener('keydown', onKeyDown)
    return () => {
      dialog.removeEventListener('pointerdown', onPointerDown)
      dialog.removeEventListener('click', onClick)
      dialog.removeEventListener('keydown', onKeyDown)
    }
  }, [state.open, manager])
  if (!state.open) return null
  return <div className="dsh-ssh dsh-ssh--panel">
    <div className="dsh-ssh__dialog" ref={manager.bindDialog} role="region" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1}>
      <header className="dsh-ssh__header"><div className="dsh-ssh__title-icon"><ConnectionIcon /></div><div><h2 id={`${id}-title`}>远程工作区</h2><p id={`${id}-description`}>SSH · WSL · Docker <span aria-hidden="true">/</span> 项目在远端，工作仍在当前窗口。</p></div><button ref={closeButton} type="button" className="dsh-ssh__close" disabled={mutationPending(state)} onClick={() => { manager.close(); manager.exitPanel() }} aria-label="关闭远程工作区管理" title="返回会话">×</button></header>
      <div className="dsh-ssh__notice" role="status" aria-live="polite">{state.notice}</div>
      <div className={`dsh-ssh__body${state.view === 'add' && !state.skills ? ' dsh-ssh__body--add' : ''}`}>{state.skills ? <SkillSyncPanel manager={manager} state={state} /> : state.view === 'add' ? <><WorkspaceForm manager={manager} state={state} /><ModeGuide /></> : <SavedConnections manager={manager} state={state} />}</div>
      <footer className="dsh-ssh__version">Workspaces {PLUGIN_VERSION}{state.status ? ` · 已验证 DSH ${state.status.verifiedDshVersion}` : ' · 正在读取连接状态…'}{state.status && state.status.pluginVersion !== PLUGIN_VERSION ? ' · 更新已安装，请重启 DSH 完成加载' : ''}</footer>
    </div>
  </div>
}

/** Public client services only; uiWorkspace is resolved on use for optional navigation. */
export const inject = ['connection']

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
  const mountSlots = (ui: ClientContext) => {
    ui.slots.inject('sidebar.panellist', () => ui.slots.register({
      name: 'sidebar.panellist', id: 'dsh-ssh-workspaces', label: '远程工作区', order: 25, inject: () => ({}),
    }, ConnectionIcon))
    ui.slots.inject('main', () => ui.slots.register({
      name: 'main', id: 'dsh-ssh-workspaces', key: 'dsh-ssh-workspaces', order: 60, inject: injected,
    }, ManagerOverlay))
  }
  if (ctx.inject) ctx.inject(['slots'], mountSlots)
  else mountSlots(ctx)
}
