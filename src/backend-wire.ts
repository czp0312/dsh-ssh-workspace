import { createServer, type Server, type Socket } from 'node:net'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { WebSocket } from 'ws'
import { BACKEND_TUNNEL } from './backend-bootstrap.js'
import { buildPythonInvocation, transportEnvironment, validateIdentityFile, type RemoteTransport } from './transport.js'
import type { PluginConfig, RemoteTarget } from './types.js'

export class BackendTunnel {
  private server?: Server
  private children = new Set<ChildProcessWithoutNullStreams>()
  private sockets = new Set<Socket>()
  origin = ''
  constructor(private target: RemoteTarget, private port: number, private config: PluginConfig, private transport?: RemoteTransport) {}
  async start(): Promise<void> {
    await validateIdentityFile(this.target)
    const invocation = this.transport ? await this.transport.pythonInvocation(this.target, BACKEND_TUNNEL, { port: this.port }) : buildPythonInvocation(this.target, BACKEND_TUNNEL, { port: this.port }, this.config)
    this.server = createServer(socket => {
      this.sockets.add(socket)
      const child = spawn(invocation.executable, invocation.args, { env: invocation.env ?? transportEnvironment(), windowsHide: true, stdio: 'pipe' })
      this.children.add(child)
      socket.pipe(child.stdin); child.stdout.pipe(socket)
      child.stderr.resume()
      child.stdin.on('error', () => socket.destroy())
      child.once('error', () => socket.destroy())
      child.once('close', () => { socket.destroy(); this.children.delete(child) })
      socket.on('error', () => {})
      socket.once('close', () => { this.sockets.delete(socket); child.kill(); child.stdin.destroy() })
    })
    await new Promise<void>((resolve, reject) => { this.server!.once('error', reject); this.server!.listen(0, '127.0.0.1', () => resolve()) })
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('Cannot open backend tunnel')
    this.origin = `http://127.0.0.1:${address.port}`
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    for (const child of this.children) child.kill()
    if (this.server) await new Promise<void>(resolve => this.server!.close(() => resolve()))
  }
}

type Frame = { type: string; streamId: string; value?: unknown; error?: { code: string; message: string; details: object } }
interface Inbox { frames: Frame[]; wake?: () => void; failure?: Error; ended: boolean; touched: number }

/** The native DSH Remote mux is preserved, including terminal uplink and cancellation. */
export class BackendWire {
  private socket?: WebSocket
  private connecting?: Promise<void>
  private streams = new Map<string, Inbox>()
  private reaper: ReturnType<typeof setInterval>
  private lifetime = new AbortController()
  isStale = false
  constructor(readonly origin: string, private cookie: string) {
    this.reaper = setInterval(() => { for (const [id, inbox] of this.streams) if (Date.now() - inbox.touched > 90_000) this.cancel(id) }, 30_000)
    this.reaper.unref()
  }
  private async request(path: string, init: RequestInit): Promise<Response> {
    try {
      const response = await fetch(this.origin + path, { ...init, signal: AbortSignal.any([this.lifetime.signal, ...(init.signal ? [init.signal] : [])]), headers: { ...init.headers, cookie: this.cookie }, redirect: 'error' })
      if (response.status === 401) this.isStale = true
      return response
    } catch (error) { if (!init.signal?.aborted) this.isStale = true; throw error }
  }
  async checkHealth(signal: AbortSignal): Promise<void> {
    try {
      const response = await this.request('/', { method: 'GET', signal })
      await response.body?.cancel()
      if (!response.ok) throw new Error(`远程后端不可用（HTTP ${response.status}）`)
    } catch (error) { this.isStale = true; throw error }
  }
  /** Preserve the native streaming upload, its backpressure and request cancellation. */
  async upload(query: URLSearchParams, request: Request): Promise<Response> {
    const allowed = new Set(['sessionId', 'name', 'mediaType'])
    if (!query.get('sessionId') || [...query.keys()].some(key => !allowed.has(key)) || new Set(query.keys()).size !== [...query.keys()].length) return new Response('Invalid upload query', { status: 400 })
    const response = await this.request('/api/session/uploadFileBinary?' + query.toString(), {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: request.body, signal: request.signal, duplex: 'half',
    } as RequestInit)
    return new Response(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } })
  }
  async rpc(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!/^[\w$.-]+(?:\/[\w$.-]+)*$/.test(endpoint)) throw new Error('Invalid backend endpoint')
    const rpcId = randomUUID()
    const response = await this.request(`/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal,
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload }),
    })
    if (!response.ok) throw new Error(`Remote DSH request failed: HTTP ${response.status}`)
    if (response.headers.get('content-type')?.startsWith('multipart/form-data')) {
      const form = await response.formData()
      const meta = JSON.parse(String(form.get('metadata')))
      if (meta.rpcId !== rpcId) throw new Error('Remote DSH response correlation mismatch')
      const attachments = []
      for (const item of meta.attachments ?? []) {
        const file = form.get(item.part)
        if (!(file instanceof Blob) || item.codec !== 'bytes') throw new Error('Invalid remote attachment')
        attachments.push({ path: item.path, base64: Buffer.from(await file.arrayBuffer()).toString('base64') })
      }
      return { result: meta.result, attachments }
    }
    const envelope = await response.json() as { rpcId: string; result: unknown }
    if (envelope.rpcId !== rpcId) throw new Error('Remote DSH response correlation mismatch')
    return { result: envelope.result, attachments: [] }
  }
  private connect(): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('Backend disconnected'))
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve()
    return this.connecting ??= new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.origin.replace(/^http/, 'ws') + '/api/remote.mux', { headers: { cookie: this.cookie }, maxPayload: 32 * 1024 * 1024 })
      this.socket = socket
      socket.once('open', resolve)
      socket.once('error', reject)
      socket.on('message', raw => {
        try {
          const frame = JSON.parse(raw.toString()) as Frame
          const inbox = this.streams.get(frame.streamId)
          if (!inbox) return
          if (inbox.frames.length >= 2048) throw new Error('Remote stream consumer is too slow')
          inbox.frames.push(frame); if (frame.type !== 'item') inbox.ended = true
          inbox.wake?.()
        } catch (error) { this.fail(error instanceof Error ? error : new Error('Invalid remote stream')) }
      })
      socket.once('close', () => { this.isStale = true; this.connecting = undefined; this.fail(new Error('Remote DSH connection closed')) })
    }).catch(error => { this.connecting = undefined; throw error })
  }
  async open(endpoint: string, payload: unknown, signal?: AbortSignal): Promise<string> {
    if (!/^[\w$.-]+(?:\/[\w$.-]+)*$/.test(endpoint)) throw new Error('Invalid backend endpoint')
    await this.connect(); signal?.throwIfAborted()
    const id = randomUUID()
    this.streams.set(id, { frames: [], ended: false, touched: Date.now() })
    this.socket!.send(JSON.stringify({ type: 'open', streamId: id, endpoint, payload }))
    return id
  }
  async poll(id: string, signal: AbortSignal): Promise<Frame[]> {
    const inbox = this.streams.get(id)
    if (!inbox) throw new Error('Remote stream is no longer available')
    if (inbox.wake) throw new Error('A remote stream already has a pending poll')
    inbox.touched = Date.now()
    if (!inbox.frames.length && !inbox.failure && !inbox.ended) {
      await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); inbox.wake = undefined; resolve() }
        const abort = () => { done(); reject(signal.reason) }
        const timer = setTimeout(done, 20_000)
        inbox.wake = done; signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    }
    if (inbox.failure) throw inbox.failure
    return inbox.frames.splice(0, 128)
  }
  send(id: string, value: unknown, end = false): void {
    if (!this.streams.has(id) || this.socket?.readyState !== WebSocket.OPEN) throw new Error('Remote stream disconnected')
    this.socket.send(JSON.stringify(end ? { type: 'end', streamId: id } : { type: 'item', streamId: id, value }))
  }
  cancel(id: string): void {
    const inbox = this.streams.get(id)
    if (inbox) { inbox.ended = true; inbox.wake?.(); this.streams.delete(id) }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel', streamId: id }))
  }
  private fail(error: Error): void { for (const inbox of this.streams.values()) { inbox.failure = error; inbox.wake?.() } }
  close(): void { this.isStale = true; this.lifetime.abort(); clearInterval(this.reaper); this.fail(new Error('Backend disconnected')); this.socket?.terminate(); this.streams.clear() }
}
