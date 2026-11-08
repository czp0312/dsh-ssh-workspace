import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionRpcHandlerResult } from '@deepseek-ai/dsh-client-connection'
import { RPC_CHANNEL, RPC_PREFIX } from './types.js'

export type ManagementHandler = (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<ConnectionRpcHandlerResult>

/** Exact Connection routes share the host's authentication, owner admission and body cap. */
export function managementFetch(endpoint: string, dispatch: ManagementHandler): (request: Request) => Promise<Response> {
  return async request => {
    if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('Expected application/json', { status: 415 })
    let raw: unknown
    try { raw = await request.json() } catch { return new Response('Invalid JSON', { status: 400 }) }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return new Response('Invalid request', { status: 400 })
    const envelope = raw as Record<string, unknown>
    if (envelope.type !== 'client-request' || typeof envelope.rpcId !== 'string' || !envelope.rpcId || envelope.rpcId.length > 128
      || envelope.method !== `${RPC_PREFIX}/${endpoint}`) return new Response('Invalid RPC envelope', { status: 400 })
    const result = await dispatch(endpoint, envelope.payload, request.signal)
    return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result })
  }
}

export function registerManagementRoutes(ctx: Context, dispatch: ManagementHandler): void {
  for (const endpoint of ['status', 'wsl/list', 'docker/list', 'skills/preview', 'skills/apply', 'test', 'browse', 'add', 'reconnect', 'disconnect', 'remove', 'backend/rpc', 'backend/open', 'backend/poll', 'backend/send', 'backend/cancel']) {
    const unregister = ctx.connection.fetch.register({
      path: `${RPC_CHANNEL}/${RPC_PREFIX}/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      fetch: managementFetch(endpoint, dispatch),
    })
    ctx.effect(() => unregister, `dsh-ssh: ${endpoint} route`)
  }
}
