import {
  ACTION_ISSUE,
  ACTION_RECHECK,
  ACTION_REJECT,
  ACTION_SEND,
  SEGMENTPROD_KEY,
  STATUS_PENDING_SAMPLE,
  STATUS_REPORTED,
  STATUS_TESTING,
  STATUS_UNQUALIFIED,
  TESTING_KEY,
  isSegmentSample,
  nextReportNo,
  reportDateOf,
  testingAbnormal,
  testingPending,
  upsertSegmentSample,
} from '@/data/domain'
import { MODULE_BY_KEY, MODULES } from '@/data/modules'
import { allRows, commit, listRows, resetRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
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
  // 刷新、返回、重新进入都走这一条读取路径，拿到的是已落库那份。
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

type IssueOptions = { result?: string }

// 出具报告做成一次落定：检测结果、报告编号、委托状态（含尾列镜像、标志位）
// 与管片「待出厂」待办在同一笔事务里，任一项没写成就整笔退回。
function issueReport(meta: ModuleMeta, id: number, options: IssueOptions = {}): ActionResult {
  const rows = listRows(TESTING_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const status = String(row.status)

  // 同一份委托重复提交只认头一次生成的报告编号：连点两回也按头一回。
  if (status === STATUS_REPORTED) {
    return {
      ok: true,
      duplicate: true,
      message: `该委托已出具报告 ${row['报告编号']}，重复提交按头一份为准，不重复出报告`,
    }
  }
  // 越级操作当场打回，并说明缺哪一步。
  if (status === STATUS_PENDING_SAMPLE) {
    return { ok: false, message: '委托尚未送样，缺少「送样委托」一步，不能越级出具报告' }
  }
  if (status === STATUS_UNQUALIFIED) {
    return { ok: false, message: '委托上轮结论为不合格，必须先「安排复检」并复检合格，才能出具报告' }
  }
  if (status !== STATUS_TESTING) {
    return { ok: false, message: `当前状态「${status}」不能直接出具报告，请先完成前置流程` }
  }

  const result = String(options.result ?? '合格').trim()
  if (!result) {
    return { ok: false, message: '检测结果没写全，本次操作已整笔退回，报告编号与委托状态均未改动' }
  }
  if (result.includes('不合格')) {
    return { ok: false, message: '检测结论为不合格，不能出具报告，请走「登记不合格」并安排复检' }
  }

  // 编号在事务内基于落库副本一次性生成，重复请求不会各拿一个号。
  const reportNo = nextReportNo(rows, reportDateOf(row))
  let segmentCode = ''
  let shouldPushTodo = false
  try {
    commit((draft) => {
      const testingDraft = draft[TESTING_KEY]
      const at = testingDraft.findIndex((item) => Number(item.id) === id)
      if (at < 0) {
        throw new Error('委托在写入时已不存在')
      }
      // 事务内最后一道幂等防线：头一份已落库就不许再落第二份。
      if (String(testingDraft[at].status) === STATUS_REPORTED) {
        throw new Error('该委托已由头一次提交出具报告，本次重复提交作废')
      }
      const updated: EntryRow = {
        ...testingDraft[at],
        status: STATUS_REPORTED,
        pending: testingPending(STATUS_REPORTED),
        abnormal: testingAbnormal(STATUS_REPORTED),
        检测结果: result,
        报告编号: reportNo,
        委托状态: STATUS_REPORTED,
      }
      testingDraft[at] = updated
      if (isSegmentSample(updated)) {
        const pushed = upsertSegmentSample(draft[SEGMENTPROD_KEY] ?? [], updated)
        draft[SEGMENTPROD_KEY] = pushed.rows
        segmentCode = pushed.code
        shouldPushTodo = true
      }
    })
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? `落库失败，已整条抽回：${error.message}`
          : '落库失败，已整条抽回，报告编号与委托状态均未改动',
    }
  }

  const todoHint = shouldPushTodo ? `，管片 ${segmentCode} 已进入待出厂待办` : ''
  return {
    ok: true,
    message: `报告已一次落定：编号 ${reportNo}、结论「${result}」、委托状态「${STATUS_REPORTED}」${todoHint}`,
  }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  options: IssueOptions = {},
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  if (key === TESTING_KEY) {
    if (action === ACTION_ISSUE) {
      return issueReport(meta, id, options)
    }
    return runTestingFlowAction(meta, id, action, target)
  }

  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const statusField = meta.fields[meta.fields.length - 1]
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  try {
    commit((draft) => {
      const next = [...draft[key]]
      next[index] = {
        ...next[index],
        status: target,
        pending: target !== lastStatus,
        abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
        [statusField]: target,
      }
      draft[key] = next
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? `落库失败，已整条抽回：${error.message}` : '落库失败，已整条抽回',
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 试验委托除出具报告外的流程动作：同样在一笔事务里改状态、标志位与尾列镜像。
function runTestingFlowAction(
  meta: ModuleMeta,
  id: number,
  action: string,
  target: string,
): ActionResult {
  const rows = listRows(TESTING_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (action === ACTION_SEND && current !== STATUS_PENDING_SAMPLE) {
    return { ok: false, message: `当前状态「${current}」无需重复送样` }
  }
  if (action === ACTION_REJECT && current !== STATUS_TESTING) {
    return { ok: false, message: '只有「检测中」的委托才能登记不合格，跳过检测直接判不合格属于越级操作' }
  }
  if (action === ACTION_RECHECK && current !== STATUS_UNQUALIFIED) {
    return { ok: false, message: '只有不合格的委托才需要安排复检' }
  }
  try {
    commit((draft) => {
      const next = [...draft[TESTING_KEY]]
      next[index] = {
        ...next[index],
        status: target,
        pending: testingPending(target),
        abnormal: testingAbnormal(target),
        委托状态: target,
      }
      draft[TESTING_KEY] = next
    })
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? `落库失败，已整条抽回：${error.message}` : '落库失败，已整条抽回',
    }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 模块各状态数量：列表页与运营概览共用这一份算法，两边只认一份。
export function moduleStatusCounts(key: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of listRows(key)) {
    const status = String(row.status)
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
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

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULES].map((meta) => {
    const entries = rows[meta.key] ?? []
    // 与各列表页同源：标志位在迁移与每次写入时都已按权威 status 统一维护，
    // 这里直接数落库标志位，不再另算一套。
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
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
