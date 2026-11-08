import { createHash, randomUUID } from 'node:crypto'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { parse } from 'yaml'
import { SKILLS_HELPER } from './skills-helper.js'
import type { RemoteTarget } from './types.js'
import type { RemoteTransport } from './transport.js'
import type { SkillSyncItem, SkillSyncPreview, SkillSyncResult } from './skills-types.js'

interface Definition { name: string; description: string; source: string; path?: string; resourceBase?: { kind: string; path?: string } }
export interface SkillRegistry { list(options?: { signal?: AbortSignal; scope?: object }): Promise<Definition[]> }
export interface PresetScopes { acquireScope(): Promise<{ key: object } & AsyncDisposable> }

/** DSH's default preset owns its filesystem provider; no Agent/session is created. */
export function localSkillRegistry(registry: SkillRegistry, presets?: PresetScopes): SkillRegistry {
  return { async list(options) {
    options?.signal?.throwIfAborted()
    const lease = await presets?.acquireScope()
    try {
      options?.signal?.throwIfAborted()
      return await registry.list({ ...options, ...(lease ? { scope: lease.key } : {}) })
    } finally { await lease?.[Symbol.asyncDispose]() }
  } }
}
interface File { path: string; data: string; executable: boolean }
interface Bundle { files: File[]; bytes: number; hash: string }
interface RemoteRow { key: string; bucket: string; entry: string; text?: string; hash?: string; blocked?: string; protected?: boolean; bundle?: boolean }
interface Catalog { destination: string; hash: string; rows: RemoteRow[] }
interface Plan { workspaceId: string; target: RemoteTarget; signal: AbortSignal; createdAt: number; catalog: Catalog; items: Map<string, { view: SkillSyncItem; definition: Definition; hash?: string; entry?: string }> }

const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex')
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const excluded = (name: string) => ['.git', 'node_modules', '__pycache__'].includes(name) || name === '.env' || name.startsWith('.env.')

/** Export only an already discovered DSH skill, including its contained resources. */
export async function readSkillBundle(definition: Definition, signal?: AbortSignal): Promise<Bundle> {
  if (!definition.path || !isAbsolute(definition.path)) throw new Error('此技能没有可同步的本机文件路径。')
  const instruction = await realpath(definition.path)
  const bundled = basename(instruction) === 'SKILL.md'
  const root = bundled ? dirname(instruction) : undefined
  const files: File[] = []
  let bytes = 0
  async function file(path: string, relative: string): Promise<void> {
    signal?.throwIfAborted()
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('包含符号链接或特殊文件，请将资源放入技能目录后再同步。')
    if (files.length >= 1024 || bytes + info.size > 10 * 1024 * 1024) throw new Error('超过单个技能 10 MiB / 1024 文件上限。')
    const data = await readFile(path, { signal })
    if (data.length !== info.size) throw new Error('技能读取期间发生变化，请刷新。')
    bytes += data.length
    files.push({ path: relative, data: data.toString('base64'), executable: !!(info.mode & 0o111) || data.subarray(0, 2).toString() === '#!' })
  }
  async function walk(directory: string, prefix = '', depth = 0): Promise<void> {
    if (depth > 32) throw new Error('技能目录嵌套超过 32 层。')
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      signal?.throwIfAborted()
      if (excluded(entry.name)) continue
      if (/[\\\u0000-\u001f]/u.test(entry.name)) throw new Error('技能包含无法跨平台同步的文件名。')
      if (entry.isSymbolicLink()) throw new Error('技能资源包含符号链接，请先将资源放入技能目录。')
      if (entry.isDirectory()) await walk(join(directory, entry.name), prefix + entry.name + '/', depth + 1)
      else await file(join(directory, entry.name), prefix + entry.name)
    }
  }
  if (root) await walk(root); else await file(instruction, 'SKILL.md')
  const content = Buffer.from(files.find(file => file.path === 'SKILL.md')?.data ?? '', 'base64').toString('utf8')
  if (Buffer.byteLength(content) > 128 * 1024) throw new Error('技能指令文件超过 128 KiB。')
  if (skillName(content) !== definition.name) throw new Error('技能名称已变化或指令格式无效，请刷新。')
  // UTF-8 order agrees with Python's Unicode scalar ordering, including emoji.
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
  return { files, bytes, hash: digest(files.map(file => `${file.path}\0${digest(Buffer.from(file.data, 'base64'))}\0${file.executable ? 'x' : ''}\n`).join('')) }
}

function skillName(text: string | undefined): string | undefined {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text ?? '')
  if (!match) return undefined
  try { const value = parse(match[1]!); return typeof value?.name === 'string' && namePattern.test(value.name) ? value.name : undefined } catch { return undefined }
}

/** Plans bind source hashes and remote catalog state to one live connection. */
export class SkillSync {
  private plans = new Map<string, Plan>()
  constructor(private registry: () => SkillRegistry | undefined, private transport: Pick<RemoteTransport, 'pythonInput'>) {}

  async preview(workspaceId: string, target: RemoteTarget, connectionSignal: AbortSignal, signal: AbortSignal): Promise<SkillSyncPreview> {
    const registry = this.registry()
    if (!registry) throw new Error('当前 DSH 未启用 Skill 服务，请先启用本机技能提供方。')
    const combined = AbortSignal.any([connectionSignal, signal])
    const definitions = (await registry.list({ signal: combined })).filter(row => ['user-dsh', 'user-agents', 'custom'].includes(row.source))
    if (definitions.length > 1024) throw new Error('本机技能超过 1024 个，请先整理技能目录。')
    const catalog = await this.transport.pythonInput<Catalog>(target, SKILLS_HELPER, { op: 'preview' }, combined)
    if (!catalog || typeof catalog.destination !== 'string' || !/^[a-f0-9]{64}$/.test(catalog.hash) || !Array.isArray(catalog.rows)) throw new Error('远端技能列表响应无效。')
    const items: Plan['items'] = new Map()
    for (const definition of definitions) {
      combined.throwIfAborted()
      const id = randomUUID()
      const view: SkillSyncItem = { id, name: definition.name, description: definition.description, source: definition.source, path: definition.path, bytes: 0, files: 0, state: 'blocked' }
      const row: Plan['items'] extends Map<string, infer V> ? V : never = { view, definition }
      try {
        if (!namePattern.test(definition.name)) throw new Error('技能名称不符合 DSH 格式。')
        const bundle = await readSkillBundle(definition, combined)
        Object.assign(view, { bytes: bundle.bytes, files: bundle.files.length })
        row.hash = bundle.hash
        const matches = catalog.rows.filter(remote => skillName(remote.text) === definition.name)
        const direct = catalog.rows.find(remote => remote.key === `dsh/${definition.name}`)
        if (matches.length > 1) throw new Error('远端存在多个同名技能，请先整理后同步。')
        const existing = matches[0]
        if (existing) {
          if (existing.blocked) throw new Error(existing.blocked)
          if (existing.bucket !== 'dsh' || !existing.bundle) throw new Error('同名技能位于远端兼容目录或单文件中，请在远端整理后更新，避免重复覆盖。')
          row.entry = existing.entry
          if (existing.protected && existing.hash !== bundle.hash) throw new Error('远端技能包含 .env、Git 或依赖目录，请先在远端整理，避免覆盖其数据。')
          view.state = existing.hash === bundle.hash ? 'equal' : 'different'
        } else {
          if (direct) throw new Error('目标目录已被其他技能或不可读条目占用。')
          row.entry = definition.name
          view.state = 'missing'
        }
      } catch (error) { combined.throwIfAborted(); view.reason = error instanceof Error ? error.message : '无法同步此技能。' }
      items.set(id, row)
    }
    combined.throwIfAborted()
    const planId = randomUUID()
    for (const [id, plan] of this.plans) if (plan.signal.aborted || Date.now() - plan.createdAt > 600_000) this.plans.delete(id)
    while (this.plans.size >= 16) this.plans.delete(this.plans.keys().next().value!)
    this.plans.set(planId, { workspaceId, target, signal: connectionSignal, createdAt: Date.now(), catalog, items })
    const order = { missing: 0, different: 1, equal: 2, blocked: 3 }
    return { planId, destination: catalog.destination, items: [...items.values()].map(row => row.view).sort((a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name)) }
  }

  async apply(workspaceId: string, planId: unknown, selected: unknown, overwrite: unknown, signal: AbortSignal): Promise<SkillSyncResult> {
    const plan = typeof planId === 'string' ? this.plans.get(planId) : undefined
    if (!plan || plan.workspaceId !== workspaceId || Date.now() - plan.createdAt > 600_000 || plan.signal.aborted) throw new Error('同步列表已过期或连接已变化，请重新读取。')
    if (!Array.isArray(selected) || !selected.length || selected.length > 128 || new Set(selected).size !== selected.length || selected.some(id => typeof id !== 'string' || !plan.items.has(id))) throw new Error('请选择 1 至 128 个列表中的技能。')
    const combined = AbortSignal.any([plan.signal, signal])
    let total = 0
    const items = []
    for (const id of selected as string[]) {
      const item = plan.items.get(id)!
      if (item.view.state === 'blocked' || item.view.state === 'equal') throw new Error('所选技能不可同步，请刷新列表。')
      if (item.view.state === 'different' && overwrite !== true) throw new Error('更新远端已有技能需要勾选“允许覆盖所选差异项”。')
      const bundle = await readSkillBundle(item.definition, combined)
      if (bundle.hash !== item.hash) throw new Error(`本机技能 ${item.view.name} 已变化，请刷新后重新选择。`)
      total += bundle.bytes
      if (total > 20 * 1024 * 1024) throw new Error('单次选择超过 20 MiB，请分批同步。')
      items.push({ id, name: item.view.name, entry: item.entry, ...bundle, overwrite: item.view.state === 'different' && overwrite === true })
    }
    combined.throwIfAborted()
    // Consume once before writing: a duplicate click cannot replay an import.
    this.plans.delete(planId as string)
    return this.transport.pythonInput<SkillSyncResult>(plan.target, SKILLS_HELPER, { op: 'apply', expected: plan.catalog.hash, items }, combined)
  }
}
