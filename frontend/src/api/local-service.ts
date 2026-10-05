import { MODULE_BY_KEY } from '@/data/modules'
import {
  TESTING_KEY,
  SEGMENT_KEY,
  SHIPPING_LINK_FIELD,
  dateKeyOf,
  formatDateKey,
  isBlankValue,
  isValidReportNumber,
  nextReportNumber,
  reconcileShipping,
} from '@/data/migration'
import { allRows, commit, listRows, resetRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  TestingStats,
} from '@/data/types'

// 业务校验打回：走事务的 catch 通道，保证一条都不会落库。
class GuardError extends Error {}

const DEFAULT_LAB = '中心试验室'
const TESTING_RESULT_PASS = '合格'
const TESTING_RESULT_FAIL = '不合格'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

// 统一派生口径：办结/异常一律看落库状态，不读历史脏标记，两个入口只认这一份。
export function isTerminal(meta: ModuleMeta, status: string): boolean {
  const terminal = meta.terminalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
  return terminal.includes(status)
}

export function isAbnormal(meta: ModuleMeta, status: string): boolean {
  return (meta.abnormalStatuses ?? []).includes(status)
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 同一委托连点两回的在途锁：后到的请求直接挡，写失败也会随事务抽回。
const issuing = new Set<number>()

function ensureMutator(snapshot: Record<string, EntryRow[]>, key: string): EntryRow[] {
  if (!Array.isArray(snapshot[key])) {
    snapshot[key] = []
  }
  return snapshot[key]
}

function findEntry(rows: EntryRow[], id: number, entity: string): EntryRow {
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    throw new GuardError(`没有找到编号为 ${id} 的${entity}`)
  }
  return row
}

// 试验检测的动作走专属守卫：越级（缺复检等）当场打回并说明缺哪一步。
function runTestingAction(id: number, action: string): ActionResult {
  return commit((snapshot) => {
    const rows = ensureMutator(snapshot, TESTING_KEY)
    const row = findEntry(rows, id, '试验委托')
    const current = String(row.status)

    if (action === '送样委托') {
      if (current !== '待送样') {
        throw new GuardError(
          `越级操作：委托当前是「${current}」，只有「待送样」的委托能送样（${current === '不合格' ? '请先走复检流程' : '缺少前置状态'}）`,
        )
      }
      row.status = '检测中'
      row['委托状态'] = '检测中'
      finalizeFlags(TESTING_KEY, rows)
      return { ok: true, message: `委托 ${row['委托编号']} 已送样，当前状态「检测中」` }
    }

    if (action === '登记不合格') {
      if (current === '不合格') {
        throw new GuardError('委托已登记为不合格，请先执行「复检」')
      }
      if (current !== '检测中') {
        throw new GuardError(`越级操作：委托当前是「${current}」，只有「检测中」的委托才能登记不合格`)
      }
      row.status = '不合格'
      row['委托状态'] = '不合格'
      row['检测结果'] = TESTING_RESULT_FAIL
      // 不合格退回：此前半写入的报告编号一律不作数。
      row['报告编号'] = ''
      finalizeFlags(TESTING_KEY, rows)
      return { ok: true, message: `委托 ${row['委托编号']} 已登记不合格，须复检合格后才能出具报告` }
    }

    if (action === '复检') {
      if (current === '检测中') {
        throw new GuardError('委托已在检测中（复检中），等复检结果出具即可')
      }
      if (current !== '不合格') {
        throw new GuardError(
          `越级操作：委托当前是「${current}」，复检只针对「不合格」委托，缺少「登记不合格」这一步`,
        )
      }
      row.status = '检测中'
      row['委托状态'] = '检测中'
      row['检测结果'] = ''
      finalizeFlags(TESTING_KEY, rows)
      return { ok: true, message: `委托 ${row['委托编号']} 已安排复检，复检合格后再出具报告` }
    }

    if (action === '出具报告') {
      return issueReportInTx(snapshot, id)
    }

    throw new GuardError(`试验委托没有登记「${action}」这个动作`)
  })
}

// 出具报告一次落定：检测结果、报告编号、委托状态、管片出厂待办在同一事务里写，
// 任何一项没写成（含待办对齐失败）整笔退回；同一份委托重复提交只认头一次的编号。
function issueReportInTx(snapshot: Record<string, EntryRow[]>, id: number): ActionResult {
  const testingRows = ensureMutator(snapshot, TESTING_KEY)
  const row = findEntry(testingRows, id, '试验委托')
  const current = String(row.status)

  if (current === '已出报告') {
    // 连点两回、退出重进再点：只认头一次生成的报告编号，绝不另出一份。
    throw new GuardError(
      `重复提交：委托 ${row['委托编号']} 的报告已于首次提交时落定，报告编号「${row['报告编号']}」，以该份为准`,
    )
  }
  if (current === '不合格') {
    throw new GuardError(
      '越级操作：该委托为「不合格」，必须先完成「复检」且复检合格，才能出具报告（缺「复检」这一步）',
    )
  }
  if (current === '待送样') {
    throw new GuardError('越级操作：委托还在「待送样」，必须先「送样委托」进入检测（缺「送样委托」这一步）')
  }

  let dateKey = dateKeyOf(row['送样日期'])
  if (!dateKey) {
    // 存量缺日期的委托补登时也按同一算法兜底，不让编号生成把整笔事务拖垮。
    dateKey = '20260901'
  }
  row['送样日期'] = formatDateKey(dateKey)
  const reportNo = nextReportNumber(testingRows, dateKey)

  // 三项结论同批写入，任意一行写一半都不可能：落库在事务外只发生一次。
  row['检测结果'] = TESTING_RESULT_PASS
  row['报告编号'] = reportNo
  row.status = '已出报告'
  row['委托状态'] = '已出报告'
  if (isBlankValue(row['检测机构'])) {
    row['检测机构'] = DEFAULT_LAB
  }
  finalizeFlags(TESTING_KEY, testingRows)

  // 报告结论落到管片生产的出厂待办：按统一算法对齐，管片那边读到的数量一定对得上。
  snapshot[SEGMENT_KEY] = reconcileShipping(snapshot[SEGMENT_KEY] ?? [], testingRows)
  finalizeFlags(SEGMENT_KEY, snapshot[SEGMENT_KEY])

  return {
    ok: true,
    message: `委托 ${row['委托编号']} 报告已一次落定：报告编号「${reportNo}」、结论合格、状态「已出报告」，已登记一条管片出厂待办`,
  }
}

// 按统一口径刷新模块内 pending/abnormal 与落库状态镜像。
function finalizeFlags(key: string, rows: EntryRow[]): void {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    return
  }
  for (const row of rows) {
    const status = String(row.status)
    row.pending = !isTerminal(meta, status)
    row.abnormal = isAbnormal(meta, status)
    if (key === TESTING_KEY) {
      row['委托状态'] = status
    }
    if (key === SEGMENT_KEY) {
      row['生产状态'] = status
    }
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  if (key === TESTING_KEY) {
    if (issuing.has(id)) {
      return { ok: false, message: '该委托正在出具报告，请勿重复点击；以首次提交落定的报告为准' }
    }
    issuing.add(id)
    try {
      return runTestingAction(id, action)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '操作失败，整笔已退回' }
    } finally {
      issuing.delete(id)
    }
  }

  try {
    return commit((snapshot) => {
      const rows = ensureMutator(snapshot, key)
      const row = findEntry(rows, id, meta.entity)
      const current = String(row.status)
      if (current === target) {
        throw new GuardError(`${meta.entity}已经是「${target}」，不用重复操作`)
      }
      row.status = target
      finalizeFlags(key, rows)
      return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : `${meta.entity}操作失败，整笔已退回` }
  }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

// 试验检测统计：直接读落库数据按状态派生，与列表、概览同源同算法。
export function loadTestingStats(): TestingStats {
  const rows = listRows(TESTING_KEY)
  const count = (status: string) => rows.filter((row) => String(row.status) === status).length
  return {
    waiting: count('待送样'),
    testing: count('检测中'),
    issued: count('已出报告'),
    failed: count('不合格'),
  }
}

// 管片读到的「待出厂」待办：只统计挂着合格报告的批次，与已出报告一一对应。
export function pendingShippingCount(): number {
  const rows = listRows(SEGMENT_KEY)
  return rows.filter(
    (row) =>
      String(row.status) === '待出厂' &&
      isValidReportNumber(row[SHIPPING_LINK_FIELD]),
  ).length
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => !isTerminal(meta, String(row.status))).length,
      abnormal: entries.filter((row) => isAbnormal(meta, String(row.status))).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
