import { MODULE_BY_KEY } from './modules'
import type { EntryRow } from './types'

// 试验检测与管片生产共用的落库口径：存量补登、运行时写入、统计读取都只认这一份算法。

export const TESTING_KEY = 'testing'
export const SEGMENT_KEY = 'segmentprod'
export const SHIPPING_LINK_FIELD = '来源报告'

// 报告编号：BG-送样日期(8位)-当日序号，例如 BG-20260903-01。
export const REPORT_NUMBER_RE = /^BG-(\d{4})(\d{2})(\d{2})-(\d+)$/

const DEFAULT_LAB = '中心试验室'
const FALLBACK_DATE_KEY = '20260901'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function isBlankValue(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

// 仓库生成期留下的占位文本（如「试验检测样例1」），补登时一律当成没写过。
export function isPlaceholderValue(value: unknown): boolean {
  return typeof value === 'string' && value.includes('样例')
}

export function cleanValue(value: unknown): string {
  if (isBlankValue(value) || isPlaceholderValue(value)) {
    return ''
  }
  return String(value).trim()
}

export function dateKeyOf(value: unknown): string | null {
  const digits = String(value ?? '').replace(/\D/g, '')
  return digits.length === 8 ? digits : null
}

export function formatDateKey(key: string): string {
  return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`
}

export function isValidReportNumber(value: unknown): boolean {
  return REPORT_NUMBER_RE.test(String(value ?? ''))
}

// 同一份委托的报告编号只算一次：序号只数「已出报告」行上的有效编号，
// 被清退的半写入编号不占位，确定性生成、可重复补登不变。
export function nextReportNumber(rows: EntryRow[], dateKey: string): string {
  let maxSeq = 0
  for (const row of rows) {
    if (String(row.status) !== '已出报告') {
      continue
    }
    const match = REPORT_NUMBER_RE.exec(String(row['报告编号'] ?? ''))
    if (!match) {
      continue
    }
    const key = `${match[1]}${match[2]}${match[3]}`
    if (key === dateKey) {
      maxSeq = Math.max(maxSeq, Number(match[4]))
    }
  }
  return `BG-${dateKey}-${String(maxSeq + 1).padStart(2, '0')}`
}

function compareByDateThenId(a: EntryRow, b: EntryRow): number {
  const da = dateKeyOf(a['送样日期']) ?? FALLBACK_DATE_KEY
  const db = dateKeyOf(b['送样日期']) ?? FALLBACK_DATE_KEY
  if (da !== db) {
    return da < db ? -1 : 1
  }
  return Number(a.id) - Number(b.id)
}

function nextGpSequence(rows: EntryRow[]): number {
  let maxSeq = 0
  for (const row of rows) {
    const code = String(row['管片编号'] ?? '')
    const match = /^GP-(\d+)$/.exec(code)
    if (match) {
      maxSeq = Math.max(maxSeq, Number(match[1]))
    }
  }
  return maxSeq + 1
}

function maxRowId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
}

function buildShippingRow(id: number, gpSeq: number, reportNo: string, inspector: string): EntryRow {
  return {
    id,
    status: '待出厂',
    pending: true,
    abnormal: false,
    管片编号: `GP-${String(gpSeq).padStart(4, '0')}`,
    管片型号: '出厂检验放行批次',
    生产模具: '—',
    钢筋笼批号: '—',
    养护天数: '—',
    出厂强度: '合格',
    检验人员: inspector,
    [SHIPPING_LINK_FIELD]: reportNo,
    生产状态: '待出厂',
  }
}

// 存量试验委托补登：状态归位、按送样日期补报告编号、清掉半写入的旧结论、镜像委托状态。
export function normalizeTesting(rows: EntryRow[]): EntryRow[] {
  const meta = MODULE_BY_KEY.get(TESTING_KEY)
  const list = clone(rows)
  for (const row of list) {
    const status = String(row.status ?? '')
    row.status = meta && meta.statuses.includes(status) ? status : '待送样'
  }

  // 已出报告的委托按送样日期统一编号（同日期按 id 顺序）。
  // 头一次落定的编号一律保留（补登幂等）；只给缺号、撞号、日期不符的补号。
  for (const row of [...list].sort(compareByDateThenId)) {
    if (String(row.status) !== '已出报告') {
      continue
    }
    let key = dateKeyOf(row['送样日期'])
    if (!key) {
      key = FALLBACK_DATE_KEY
    }
    row['送样日期'] = formatDateKey(key)
    const match = REPORT_NUMBER_RE.exec(String(row['报告编号'] ?? ''))
    const sameNumber = (other: EntryRow) =>
      other !== row && String(other['报告编号'] ?? '') === String(row['报告编号'] ?? '')
    if (match && `${match[1]}${match[2]}${match[3]}` === key && !list.some(sameNumber)) {
      continue
    }
    row['报告编号'] = nextReportNumber(list, key)
  }

  for (const row of list) {
    const status = String(row.status)
    row['委托状态'] = status
    if (status === '已出报告') {
      const result = cleanValue(row['检测结果'])
      if (result.includes('不合格')) {
        // 历史半拉子数据：挂着报告却写着不合格结论，统一退回不合格，必须复检后重走。
        row.status = '不合格'
        row['委托状态'] = '不合格'
        row['检测结果'] = '不合格'
        row['报告编号'] = ''
        continue
      }
      row['检测结果'] = result === '' ? '合格' : result
      if (!isValidReportNumber(row['报告编号'])) {
        row['报告编号'] = ''
      }
      row['检测机构'] = cleanValue(row['检测机构']) === '' ? DEFAULT_LAB : cleanValue(row['检测机构'])
    } else if (status === '不合格') {
      row['检测结果'] = '不合格'
      row['报告编号'] = ''
      if (isPlaceholderValue(row['检测机构'])) {
        row['检测机构'] = ''
      }
    } else {
      // 待送样 / 检测中：报告还没出具，残留的报告编号、结论都是半写入脏数据，无条件清掉。
      row['检测结果'] = ''
      row['报告编号'] = ''
      if (isPlaceholderValue(row['检测机构'])) {
        row['检测机构'] = ''
      }
    }
  }
  return list
}

// 管片出厂待办与试验报告对齐：每份已出报告（合格）对应一条待出厂批次，不多不少。
// 已挂来源报告的批次一律保留；缺挂的先认领存量待出厂批次，认完再按规则补建。
export function reconcileShipping(segRows: EntryRow[], testingRows: EntryRow[]): EntryRow[] {
  const list = clone(segRows)
  const linked = new Set(
    list
      .filter((row) => cleanValue(row[SHIPPING_LINK_FIELD]) !== '')
      .map((row) => String(row[SHIPPING_LINK_FIELD])),
  )
  const qualified = testingRows
    .filter((row) => String(row.status) === '已出报告' && isValidReportNumber(row['报告编号']))
    .sort(compareByDateThenId)

  for (const report of qualified) {
    const reportNo = String(report['报告编号'])
    if (linked.has(reportNo)) {
      continue
    }
    const spare = list
      .filter((row) => String(row.status) === '待出厂' && cleanValue(row[SHIPPING_LINK_FIELD]) === '')
      .sort((a, b) => Number(a.id) - Number(b.id))[0]
    if (spare) {
      spare[SHIPPING_LINK_FIELD] = reportNo
      spare['生产状态'] = '待出厂'
      spare['出厂强度'] = '合格'
      spare['检验人员'] = cleanValue(report['检测机构']) === '' ? DEFAULT_LAB : cleanValue(report['检测机构'])
      for (const field of ['管片型号', '生产模具', '钢筋笼批号', '养护天数']) {
        if (isPlaceholderValue(spare[field])) {
          spare[field] = '—'
        }
      }
    } else {
      const id = maxRowId(list) + 1
      const gpSeq = nextGpSequence(list)
      const inspector = cleanValue(report['检测机构']) === '' ? DEFAULT_LAB : cleanValue(report['检测机构'])
      list.push(buildShippingRow(id, gpSeq, reportNo, inspector))
    }
    linked.add(reportNo)
  }
  return list
}

// 全量归一：状态合法、pending/abnormal 一律由落库状态按统一口径派生。
export function normalizeAll(input: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const output: Record<string, EntryRow[]> = {}
  for (const key of Object.keys(input)) {
    output[key] = clone(input[key])
  }
  if (output[TESTING_KEY]) {
    output[TESTING_KEY] = normalizeTesting(output[TESTING_KEY])
  }
  if (output[SEGMENT_KEY]) {
    output[SEGMENT_KEY] = reconcileShipping(output[SEGMENT_KEY], output[TESTING_KEY] ?? [])
  }
  for (const [key, rows] of Object.entries(output)) {
    const meta = MODULE_BY_KEY.get(key)
    if (!meta) {
      continue
    }
    const terminal = meta.terminalStatuses ?? [meta.statuses[meta.statuses.length - 1]]
    const abnormalSet = meta.abnormalStatuses ?? []
    output[key] = rows.map((row) => {
      const status = meta.statuses.includes(String(row.status)) ? String(row.status) : meta.statuses[0]
      return {
        ...row,
        status,
        pending: !terminal.includes(status),
        abnormal: abnormalSet.includes(status),
      }
    })
  }
  return output
}
