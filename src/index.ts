import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-workspace'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { RemoteTransport } from './transport.js'
import { WorkspaceStore } from './storage.js'
import { validateTarget } from './model.js'
import { WorkspaceManager } from './manager.js'
import { bindRemoteAgent } from './tools.js'
import { registerManagementRoutes } from './rpc.js'
import type { SandboxPolicyApi, WorkingDirectoryApi } from './tools.js'
import { PLUGIN_VERSION, VERIFIED_DSH_VERSION } from './types.js'
import type { PluginConfig, ReconnectRequest } from './types.js'
import { RemoteBackends } from './backends.js'
import { WorkspaceConnections } from './connections.js'

export type { PluginConfig as Config } from './types.js'
export const name = 'dsh-ssh-workspaces'
export const inject = ['connection', 'workspaceRegistry', 'agents', 'tools', 'systemPrompt', 'workingDirectory', 'sandboxPolicy']

function object(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求必须是对象。')
  return input as Record<string, unknown>
}

function idOf(input: unknown): string {
  const id = object(input).id
  if (typeof id !== 'string' || !id || id.length > 128) throw new Error('无效的远程项目 ID。')
  return id
}

/** Broker for complete remote DSH backends; legacy mounts retain their old routing. */
export async function apply(ctx: Context, config: PluginConfig = {}): Promise<void> {
  if (typeof ctx.connection.fetch.register !== 'function' || typeof ctx.tools.guard !== 'function') {
    throw new Error(`dsh-ssh-workspaces 需要 DSH ${VERIFIED_DSH_VERSION} 的 Connection/Tools 接口。`)
  }
  const stateFile = config.stateFile ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'ssh-workspaces.json')
  if (!isAbsolute(stateFile)) throw new Error('stateFile 必须是绝对路径。')
  const transport = new RemoteTransport(config)
  ctx.effect(() => () => transport.dispose(), 'dsh-ssh: transport lifecycle')
  const store = new WorkspaceStore(stateFile)
  const registry = ctx.workspaceRegistry
  const manager = new WorkspaceManager({
    get: id => registry.get(id as WorkspaceId),
    resolveByPath: path => registry.resolveByPath(path),
    create: (path, title) => registry.create(path, title),
    delete: id => registry.delete(id as WorkspaceId),
  }, transport, store)
  await manager.load()
  ctx.effect(() => () => manager.dispose(), 'dsh-ssh: mount lifecycle')
  const backends = new RemoteBackends(join(dirname(stateFile), 'ssh-backends.json'), transport, config)
  await backends.load()
  const connections = new WorkspaceConnections(manager, backends)
  ctx.effect(() => {
    const lifetime = new AbortController()
    let checking = false
    const check = async () => {
      if (checking || lifetime.signal.aborted) return
      checking = true
      try { await connections.checkHealth(lifetime.signal) } finally { checking = false }
    }
    const timer = setInterval(() => { void check() }, 15_000)
    timer.unref()
    void check()
    return () => { lifetime.abort(); clearInterval(timer) }
  }, 'dsh-ssh: connection health')
  ctx.effect(() => () => backends.dispose(), 'dsh-ssh: remote backends')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/dsh-ssh-workspaces/backend/upload', methods: ['POST'], requestBody: 'streaming',
    fetch: async request => {
      try {
        if (request.headers.get('content-type')?.split(';', 1)[0] !== 'application/octet-stream') return new Response('Expected application/octet-stream', { status: 415 })
        const query = new URL(request.url).searchParams
        const backendId = query.get('backendId')
        if (!backendId || query.getAll('backendId').length !== 1) return new Response('Invalid backend', { status: 400 })
        query.delete('backendId')
        return await (await backends.wire(backendId, request.signal)).upload(query, request)
      } catch (error) { return Response.json({ ok: false, error: { code: 'remote-upload/error', message: error instanceof Error ? error.message : 'Remote upload failed', details: {} } }, { status: 502 }) }
    },
  }), 'dsh-ssh: remote uploads')

  const bound = new WeakSet<object>()
  const workingDirectory = ctx.get('workingDirectory') as WorkingDirectoryApi
  const policy = ctx.get('sandboxPolicy') as SandboxPolicyApi
  const attach = (agent: Parameters<typeof bindRemoteAgent>[1]): void => {
    if (bound.has(agent)) return
    const record = manager.forPath(agent.session.header.cwd)
    if (record === undefined) return
    bindRemoteAgent(ctx, agent, record, { run: (_target, command, options) => manager.run(record.id, command, options) }, workingDirectory, policy, { assertAvailable: () => manager.assertAvailable(record.id) })
    bound.add(agent)
  }
  ctx.on('agent/created', ({ agent }) => { attach(agent); return undefined })
  for (const agent of ctx.agents.list()) attach(agent)

  registerManagementRoutes(ctx, async (endpoint, payload, signal) => {
    try {
      signal.throwIfAborted()
      let value: unknown
      switch (endpoint) {
        case 'status':
          value = { pluginVersion: PLUGIN_VERSION, verifiedDshVersion: VERIFIED_DSH_VERSION, platform: process.platform, workspaces: connections.list(), sources: backends.sources(), modes: ['light', 'full'] }
          break
        case 'wsl/list': value = await transport.listWsl(signal); break
        case 'test': {
          const request = object(payload)
          const target = validateTarget(request.target)
          transport.setCredentials(target, request.credentials)
          value = await transport.inspect(target, signal); break
        }
        case 'browse': {
          const request = object(payload)
          if (typeof request.path !== 'string') throw new Error('缺少远程浏览路径。')
          const target = validateTarget(request.target)
          transport.setCredentials(target, request.credentials)
          value = await transport.browse(target, request.path, signal)
          break
        }
        case 'add': {
          const request = object(payload)
          transport.setCredentials(validateTarget(request.target), request.credentials)
          value = await connections.add(payload, signal); break
        }
        case 'reconnect': {
          const id = idOf(payload)
          const record = connections.list().find(row => row.id === id)
          if (!record) throw new Error('远程项目不存在，请刷新列表。')
          transport.setCredentials(record.target, object(payload).credentials)
          value = await connections.reconnect(id, signal, object(payload) as unknown as ReconnectRequest); break
        }
        case 'disconnect': await connections.disconnect(idOf(payload)); value = null; break
        case 'remove': await connections.remove(idOf(payload)); value = null; break
        case 'backend/rpc': {
          const request = object(payload)
          value = await (await backends.wire(String(request.backendId), signal)).rpc(String(request.endpoint), request.payload, signal); break
        }
        case 'backend/open': {
          const request = object(payload)
          value = await (await backends.wire(String(request.backendId), signal)).open(String(request.endpoint), request.payload, signal); break
        }
        case 'backend/poll': {
          const request = object(payload)
          value = await (await backends.wire(String(request.backendId), signal)).poll(String(request.streamId), signal); break
        }
        case 'backend/send': {
          const request = object(payload)
          ;(await backends.wire(String(request.backendId), signal)).send(String(request.streamId), request.value, request.end === true)
          value = null; break
        }
        case 'backend/cancel': {
          const request = object(payload)
          ;(await backends.wire(String(request.backendId), signal)).cancel(String(request.streamId))
          value = null; break
        }
        default: return { ok: false, error: { code: 'not-found', message: '未知的远程工作区操作。', details: {} } }
      }
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: { code: 'remote-workspace/error', message: error instanceof Error ? error.message : String(error), details: {} } }
    }
  })
}
