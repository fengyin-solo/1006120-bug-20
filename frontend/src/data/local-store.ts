import { migrateDb } from './domain'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
const VERSION_KEY = 'shield-tunnel-construction:schema-version'
const SCHEMA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 读取必须与写入同源：内存 cache 只在 localStorage 写成功后才整体替换，
// 因此 cache 永远等于最近一次「已落库」的那份，旧结论不会从缓存顶上来。
let cache: Record<string, EntryRow[]> | null = null
let schemaApplied = false

function persist(db: Record<string, EntryRow[]>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // 先落库：写失败会抛错，由调用方整笔退回，绝不先改缓存。
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db))
  window.localStorage.setItem(VERSION_KEY, String(SCHEMA_VERSION))
}

function bootstrap(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return migrateDb(clone(SEED_ROWS))
  }
  const storedVersion = Number(window.localStorage.getItem(VERSION_KEY) ?? '0')
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const db = migrateDb(clone(SEED_ROWS))
    persist(db)
    return db
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 旧版本缓存（含落了一半的脏数据）统一按现有规则补登一遍后再落库。
    const db = storedVersion >= SCHEMA_VERSION ? parsed : migrateDb(parsed)
    if (storedVersion < SCHEMA_VERSION) {
      persist(db)
    }
    return db
  } catch {
    const db = migrateDb(clone(SEED_ROWS))
    persist(db)
    return db
  }
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null || !schemaApplied) {
    cache = bootstrap()
    schemaApplied = true
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit((draft) => {
    draft[key] = rows
  })
}

// 一次事务：在整库副本上改，校验/构造失败直接抛错、缓存保持不动；
// 落库失败（配额、隐私模式等）同样整笔抽回，不留半成品。
export function commit(
  mutate: (draft: Record<string, EntryRow[]>) => void,
): Record<string, EntryRow[]> {
  const draft = clone(allRows())
  mutate(draft)
  persist(draft)
  cache = draft
  return cache
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
