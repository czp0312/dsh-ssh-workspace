import type { WorkspaceView } from './types.js'
import { connectionState, CONNECTION_LABELS } from './connection-status.js'

// DSH 0.2.2-rc.1 ProjectRow exposes this identity, but no title-decoration slot.
// Keep this adapter separate so a future native slot can replace it cleanly.
const ROW = '[role="treeitem"][data-row-key^="workspace:"]'
const LABEL = 'dsh-ssh-project-label'
const BADGE = 'dsh-ssh-project-badge'
const SVG_NS = 'http://www.w3.org/2000/svg'

function tooltip(workspace: WorkspaceView): string {
  const target = workspace.target
  const location = target.kind === 'wsl'
    ? `WSL · ${target.distribution}${target.user ? ` · ${target.user}` : ''}`
    : `SSH · ${target.user ? `${target.user}@` : ''}${target.host}${target.port ? `:${target.port}` : ''}`
  return `远程项目 · ${CONNECTION_LABELS[connectionState(workspace)]} · ${location} · ${workspace.mode === 'full' ? '全量模式（远端 DSH）' : '轻量模式（本机 Agent）'}${workspace.connectionError ? ` · ${workspace.connectionError}` : ''}`
}

/** Decorate native project titles by workspace ID, never by their display names. */
export function installWorkspaceBadges(document: Document) {
  let alive = true
  let queued = false
  let workspaces = new Map<string, WorkspaceView>()
  const mounted = new Map<Element, { label: Element; badge: HTMLElement }>()
  const remove = (row: Element): void => {
    const entry = mounted.get(row)
    if (!entry) return
    entry.badge.remove()
    entry.label.classList.remove(LABEL)
    mounted.delete(row)
  }
  const render = (): void => {
    if (!alive) return
    for (const row of mounted.keys()) if (!row.isConnected || !row.matches(ROW)) remove(row)
    for (const row of document.querySelectorAll(ROW)) {
      const workspace = workspaces.get(row.getAttribute('data-row-key')!.slice('workspace:'.length))
      // The verified native ProjectRow has folder, chevron, title, actions spans.
      // Fail closed if a future host changes that structure; do not guess by text.
      const label = row.children[2]
      const title = label?.firstElementChild
      if (!workspace || label?.tagName !== 'SPAN' || title?.tagName !== 'SPAN' || label.querySelector('button,input')) {
        remove(row)
        continue
      }
      let entry = mounted.get(row)
      if (entry && (entry.label !== label || entry.badge.parentElement !== label)) {
        remove(row)
        entry = undefined
      }
      if (!entry) {
        const badge = document.createElement('span')
        badge.className = BADGE
        badge.setAttribute('role', 'img')
        const svg = document.createElementNS(SVG_NS, 'svg')
        for (const [key, value] of Object.entries({ width: '14', height: '14', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(key, value)
        const path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute('d', 'M4 4.75h16a1.25 1.25 0 0 1 1.25 1.25v10A1.25 1.25 0 0 1 20 17.25H4A1.25 1.25 0 0 1 2.75 16V6A1.25 1.25 0 0 1 4 4.75ZM8 21h8m-4-3.75V21M7 8l3 3-3 3m6 0h4')
        svg.append(path)
        badge.append(svg)
        label.classList.add(LABEL)
        label.append(badge)
        entry = { label, badge }
        mounted.set(row, entry)
      }
      const description = tooltip(workspace)
      const state = connectionState(workspace)
      if (entry.badge.dataset.connectionState !== state) entry.badge.dataset.connectionState = state
      if (entry.badge.title !== description) {
        entry.badge.title = description
        entry.badge.setAttribute('aria-label', description)
      }
    }
  }
  const schedule = (): void => {
    if (queued || !alive) return
    queued = true
    queueMicrotask(() => { queued = false; render() })
  }
  const observer = new document.defaultView!.MutationObserver(changes => {
    if (changes.some(change => {
      const target = change.target.nodeType === 1 ? change.target as Element : change.target.parentElement
      if (target?.closest(ROW) || (change.type === 'attributes' && mounted.has(target!))) return true
      return [...change.addedNodes, ...change.removedNodes].some(node => node.nodeType === 1 && ((node as Element).matches(ROW) || (node as Element).querySelector(ROW)))
    })) schedule()
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-row-key'] })
  return {
    update(records: readonly WorkspaceView[]): void {
      if (!alive) return
      workspaces = new Map(records.filter(record => record.registered && record.removedAt === undefined).map(record => [record.workspaceId, record]))
      render()
    },
    dispose(): void {
      alive = false
      observer.disconnect()
      for (const row of mounted.keys()) remove(row)
      workspaces.clear()
    },
  }
}
