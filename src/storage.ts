import fs from 'node:fs/promises'
import { dirname, normalize, parse, isAbsolute, resolve } from 'node:path'
import { validateTarget } from './model.js'
import type { SavedWorkspace } from './types.js'

const controls = /[\u0000-\u001f\u007f-\u009f]/u
let temporaryId = 0

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || controls.test(value)) {
    throw new TypeError(`${label} must be nonempty and contain no control characters`)
  }
  return value
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative finite timestamp`)
  }
  return value
}

function localPath(value: unknown): string {
  const path = text(value, 'localPath')
  if (!isAbsolute(path) || (process.platform === 'win32' && (
    /^[/\\]{2}[?.][/\\]/u.test(path) ||
    (!/^[a-z]:[/\\]/iu.test(path) && !/^[/\\]{2}[^/\\]+[/\\]+[^/\\]+(?:[/\\]|$)/u.test(path))
  ))) throw new TypeError('localPath must be an absolute native path')
  const normalized = normalize(path)
  const root = parse(normalized).root
  return normalized.length > root.length && normalized.endsWith(process.platform === 'win32' ? '\\' : '/')
    ? normalized.slice(0, -1)
    : normalized
}

function validateRecords(input: unknown): SavedWorkspace[] {
  if (!Array.isArray(input)) throw new TypeError('Workspace store workspaces must be an array')
  const ids = new Set<string>()
  return input.map((item, index) => {
    const value = object(item, `Workspace ${index}`)
    const id = text(value.id, 'id')
    if (ids.has(id)) throw new TypeError(`Duplicate workspace id: ${id}`)
    ids.add(id)
    if (value.disconnected !== undefined && typeof value.disconnected !== 'boolean') throw new TypeError('disconnected must be a boolean')
    return {
      id,
      workspaceId: text(value.workspaceId, 'workspaceId'),
      title: text(value.title, 'title'),
      localPath: localPath(value.localPath),
      target: validateTarget(value.target),
      createdAt: timestamp(value.createdAt, 'createdAt'),
      ...(value.removedAt === undefined ? {} : { removedAt: timestamp(value.removedAt, 'removedAt') }),
      ...(value.disconnected === undefined ? {} : { disconnected: value.disconnected }),
    }
  })
}

/** Versioned ledger; remote mounts are deliberately never stat'ed during validation. */
export class WorkspaceStore {
  private readonly path: string
  private records: readonly SavedWorkspace[] = []
  private tail: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.path = resolve(text(path, 'Workspace store path'))
  }

  list(): readonly SavedWorkspace[] {
    return this.records.map(record => ({ ...record, target: { ...record.target } }))
  }

  load(): Promise<readonly SavedWorkspace[]> {
    return this.enqueue(async () => {
      let source: string
      try {
        source = await fs.readFile(this.path, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        this.records = []
        return this.list()
      }
      let document: unknown
      try {
        document = JSON.parse(source)
      } catch (error) {
        throw new Error('Invalid workspace store JSON', { cause: error })
      }
      const value = object(document, 'Workspace store')
      if (value.schemaVersion !== 1) throw new TypeError('Unsupported workspace store schemaVersion; expected 1')
      const records = validateRecords(value.workspaces)
      this.records = records
      return this.list()
    })
  }

  async save(records: readonly SavedWorkspace[]): Promise<void> {
    // Validate and detach at invocation time: callers may reuse their array while
    // an earlier write is waiting for rename. Failed saves never change list().
    const snapshot = validateRecords(records)
    const source = `${JSON.stringify({ schemaVersion: 1, workspaces: snapshot }, null, 2)}\n`
    return this.enqueue(async () => {
      await fs.mkdir(dirname(this.path), { recursive: true })
      const temporary = `${this.path}.${process.pid}.${++temporaryId}.${Math.random().toString(16).slice(2)}.tmp`
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined
      let created = false
      try {
        handle = await fs.open(temporary, 'wx', 0o600)
        created = true
        await handle.writeFile(source, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await fs.rename(temporary, this.path)
        this.records = snapshot
      } finally {
        await handle?.close().catch(() => undefined)
        if (created) await fs.unlink(temporary).catch(() => undefined)
      }
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation)
    this.tail = task.then(() => undefined, () => undefined)
    return task
  }
}
