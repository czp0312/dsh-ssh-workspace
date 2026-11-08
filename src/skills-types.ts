export interface SkillSyncItem {
  id: string
  name: string
  description: string
  source: string
  path?: string
  bytes: number
  files: number
  state: 'missing' | 'equal' | 'different' | 'blocked'
  reason?: string
}

export interface SkillSyncPreview {
  planId: string
  destination: string
  items: SkillSyncItem[]
}

export interface SkillSyncResult {
  items: Array<{ id: string; name: string; status: 'created' | 'updated' | 'failed'; message?: string }>
}
