/** Source namespacing prevents identical remote UUIDs from crossing backend boundaries. */
const PREFIX = 'dsh-remote:'
const identity = /^(?:workspaceIds?|beforeWorkspaceId|(?:[a-zA-Z]*Session|session)Ids?|parentSession|agentId|workspaceFileScopeId|eventId)$/
export function remoteId(source: string, id: string): string { return `${PREFIX}${source}:${id}` }
export function idSource(id: string): string | undefined {
  if (!id.startsWith(PREFIX)) return
  const match = /^dsh-remote:([a-zA-Z0-9_-]+):(.+)$/.exec(id)
  if (!match) throw new Error('Invalid remote resource identity')
  return match[1]
}
const resource = (value: any): boolean => value?.kind === 'session' || value?.kind === 'workspace'
const member = (value: any): boolean => (value?.role === 'lead' || value?.role === 'teammate') && typeof value?.name === 'string'
export function translateIds(value: unknown, source: string, incoming: boolean, key = ''): any {
  if (typeof value === 'string' && identity.test(key)) {
    if (incoming) return remoteId(source, value)
    const prefix = `${PREFIX}${source}:`
    if (value.startsWith(PREFIX) && !value.startsWith(prefix)) throw new Error('Cannot mix resources from different DSH backends')
    return value.startsWith(prefix) ? value.slice(prefix.length) : value
  }
  if (Array.isArray(value)) return value.map(item => translateIds(item, source, incoming, key))
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    const object = value as Record<string, any>
    return Object.fromEntries(Object.entries(value).map(([name, item]) => {
      let field = name
      if (name === 'id' && (resource(value) || member(value) || key === 'subagentCatalog' || (key === 'header' && typeof object.version === 'number'))) field = 'sessionId'
      if (name === 'owner' && typeof object.startedAt === 'number' && object.output && typeof object.kind === 'string') field = 'sessionId'
      if (name === 'val' && typeof object.key === 'string') field = object.key
      return [name, translateIds(item, source, incoming, field)]
    }))
  }
  return value
}
function identities(value: unknown): Array<{ key: string; value: string }> {
  const result: Array<{ key: string; value: string }> = []
  const walk = (item: unknown, key = '') => {
    if (typeof item === 'string' && identity.test(key)) result.push({ key, value: item })
    else if (Array.isArray(item)) item.forEach(child => walk(child, key))
    else if (item && typeof item === 'object' && !ArrayBuffer.isView(item)) Object.entries(item).forEach(([name, child]) => walk(child, name === 'id' && resource(item) ? 'sessionId' : name))
  }
  walk(value)
  return result
}
export function payloadSource(value: unknown): string | undefined {
  const found = new Set<string>()
  for (const item of identities(value)) { const source = idSource(item.value); if (source) found.add(source) }
  if (found.size > 1) throw new Error('Cross-backend operations are not supported')
  return [...found][0]
}

/** Explicit local resources always win over the current remote settings context. */
export function routeSource(value: unknown, active?: string, endpoint = ''): string | undefined {
  const items = identities(value)
  const source = payloadSource(value)
  if (source && items.some(item => !idSource(item.value) && !(endpoint === 'session/create' && item.key === 'sessionId'))) throw new Error('Cannot mix local and remote DSH resources')
  return source ?? (items.length ? undefined : active)
}
