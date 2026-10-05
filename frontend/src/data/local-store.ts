import { MODULES } from './modules'
import { normalizeAll } from './migration'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：localStorage 是唯一权威（「落库那份」），内存缓存只是它的只读镜像。
const STORAGE_KEY = 'shield-tunnel-construction:entries'
// 归一化版本：存量数据补登算法调整后抬一版，已落过库的记录会按新版重新对齐一遍。
const VERSION_KEY = 'shield-tunnel-construction:version'
const SCHEMA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function fullSeed(): Record<string, EntryRow[]> {
  const seed: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    seed[meta.key] = clone(SEED_ROWS[meta.key] ?? [])
  }
  return seed
}

// 新种子（含重置后）也要过同一套统一算法，保证示例数据与运行时数据同口径。
function withSeedFallback(parsed: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  return { ...fullSeed(), ...parsed }
}

function persist(snapshot: Record<string, EntryRow[]>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // 先整体落库，异常向上抛：调用方据此整笔退回，缓存不会留下半份。
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  window.localStorage.setItem(VERSION_KEY, String(SCHEMA_VERSION))
}

function hydrate(): Record<string, EntryRow[]> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return normalizeAll(fullSeed())
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = normalizeAll(fullSeed())
    persist(seeded)
    return seeded
  }
  let parsed: Record<string, EntryRow[]>
  try {
    parsed = JSON.parse(raw) as Record<string, EntryRow[]>
  } catch {
    const seeded = normalizeAll(fullSeed())
    persist(seeded)
    return seeded
  }
  const merged = withSeedFallback(parsed)
  const storedVersion = Number(window.localStorage.getItem(VERSION_KEY) ?? '0')
  if (storedVersion >= SCHEMA_VERSION) {
    // 版本一致仍过一遍归一化：用户手工改过库、旧半写入记录都不会顶上来。
    return normalizeAll(merged)
  }
  // 存量委托按送样日期补登、出厂待办对齐，只在这里整库做一遍。
  const migrated = normalizeAll(merged)
  persist(migrated)
  return migrated
}

let cache: Record<string, EntryRow[]> | null = null

// 读取永远从「落库那份」派生：缓存失效后直接重读 localStorage，不允许旧结论顶替。
export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = hydrate()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 事务提交：mutator 基于整库快照改，先落库成功才替换缓存；
// mutator 抛错或落库失败都整笔退回，缓存保持原状。
export function commit<T>(mutator: (snapshot: Record<string, EntryRow[]>) => T): T {
  const snapshot = clone(allRows())
  let result: T
  try {
    result = mutator(snapshot)
  } catch (error) {
    // 业务打回（越级、重复）：什么都不写。
    throw error
  }
  persist(snapshot)
  cache = snapshot
  return result
}

// 另一个标签页落了库：本页缓存立即作废，下次读取直接拿新库，两边只认一份。
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === VERSION_KEY) {
      cache = null
    }
  })
}

export function resetRows(key: string): EntryRow[] {
  let rows: EntryRow[] = []
  // 重置整库重算：种子也要过统一算法，顺带重建出厂待办。
  commit((snapshot) => {
    snapshot[key] = clone(SEED_ROWS[key] ?? [])
    const normalized = normalizeAll(snapshot)
    for (const moduleKey of Object.keys(snapshot)) {
      snapshot[moduleKey] = normalized[moduleKey] ?? []
    }
    rows = snapshot[key] ?? []
  })
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
