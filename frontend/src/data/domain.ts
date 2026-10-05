import { MODULES } from './modules'
import type { EntryRow } from './types'

// 试验检测与管片生产共用的领域规则。
// 冲突裁决原则（两处页面、缓存与 localStorage 冲突时一律照此办理）：
// 1. 以「已落库那份」为准：内存缓存只是落库数据的只读副本，写入成功后才许整体替换；
// 2. 同一份委托重复提交只认头一次生成的报告编号，第二回起原样返回，不重复出报告、不重复推待办。

export const TESTING_KEY = 'testing'
export const SEGMENTPROD_KEY = 'segmentprod'

export const STATUS_PENDING_SAMPLE = '待送样'
export const STATUS_TESTING = '检测中'
export const STATUS_REPORTED = '已出报告'
export const STATUS_UNQUALIFIED = '不合格'

export const SEGMENT_STATUS_PENDING_SHIP = '待出厂'
export const SEGMENT_STATUS_SHIPPED = '已出厂'

const TESTING_STATUSES = [
  STATUS_PENDING_SAMPLE,
  STATUS_TESTING,
  STATUS_REPORTED,
  STATUS_UNQUALIFIED,
]

export const ACTION_SEND = '送样委托'
export const ACTION_ISSUE = '出具报告'
export const ACTION_REJECT = '登记不合格'
export const ACTION_RECHECK = '安排复检'

// 各模块「XX状态」尾列与权威 status 的对应：尾列只许镜像，不许各写各的。
const STATUS_FIELD_BY_KEY: Record<string, string> = Object.fromEntries(
  MODULES.map((meta) => [meta.key, meta.fields[meta.fields.length - 1]]),
)

// 正式报告编号形如 BG-20260903-001；其他任何写法都不算落过报告。
const FORMAL_REPORT_NO = /^BG-(\d{8})-(\d{3})$/

export function isFormalReportNo(value: unknown): boolean {
  return typeof value === 'string' && FORMAL_REPORT_NO.test(value.trim())
}

// 示例数据里「试验检测样例1」这类占位值，以及与委托编号雷同的假报告号，都视为没写过。
export function isPlaceholderValue(value: unknown): boolean {
  if (typeof value !== 'string') {
    return true
  }
  const text = value.trim()
  return text === '' || text.includes('样例')
}

export function isSegmentSample(row: EntryRow): boolean {
  return String(row['试样类型'] ?? '').includes('管片')
}

export function reportDateOf(row: EntryRow): string {
  const value = String(row['送样日期'] ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : new Date().toISOString().slice(0, 10)
}

// 同一天内按已正式落库的编号顺延；入参 rows 已按送样日期排好，编号因此确定且不重号。
export function nextReportNo(rows: EntryRow[], date: string): string {
  const stamp = date.replace(/-/g, '')
  let seq = 0
  for (const row of rows) {
    const match = FORMAL_REPORT_NO.exec(String(row['报告编号'] ?? '').trim())
    if (match && match[1] === stamp) {
      seq = Math.max(seq, Number(match[2]))
    }
  }
  return `BG-${stamp}-${String(seq + 1).padStart(3, '0')}`
}

// 委托是否已落过报告：状态与报告编号冲突时，以「正式编号已落库」为准。
export function isIssuedRow(row: EntryRow): boolean {
  return String(row.status) === STATUS_REPORTED || isFormalReportNo(row['报告编号'])
}

// 试验委托的标志位统一算法：除「已出报告」外都算待处理；只有「不合格」算异常。
export function testingPending(status: string): boolean {
  return status !== STATUS_REPORTED
}
export function testingAbnormal(status: string): boolean {
  return status === STATUS_UNQUALIFIED
}

// 由委托编号确定唯一的管片编号：TEST-0003 -> SEGM-T0003，重复报告只会命中同一条。
function segmentCodeOf(testingRow: EntryRow): string {
  const commission = String(testingRow['委托编号'] ?? '')
  const digits = /(\d+)\s*$/.exec(commission)
  const tail = (digits?.[1] ?? String(testingRow.id)).padStart(4, '0')
  return `SEGM-T${tail}`
}

// 合格报告落到管片生产的「待出厂」待办；同委托重复报告幂等命中，待出厂批次数不重复加。
// 已出厂的管片不许被重复报告打回待出厂（以先落库的出厂状态为准）。
export function upsertSegmentSample(
  segments: EntryRow[],
  testingRow: EntryRow,
): { rows: EntryRow[]; code: string } {
  const code = segmentCodeOf(testingRow)
  const commission = String(testingRow['委托编号'] ?? '')
  const reportNo = String(testingRow['报告编号'] ?? '')
  const index = segments.findIndex((row) => String(row['管片编号'] ?? '') === code)
  const base = index >= 0 ? segments[index] : undefined
  const shipped = base?.status === SEGMENT_STATUS_SHIPPED
  const status = shipped ? SEGMENT_STATUS_SHIPPED : SEGMENT_STATUS_PENDING_SHIP
  const nextId =
    base?.id ?? Math.max(0, ...segments.map((row) => Number(row.id) || 0)) + 1
  const nextRow: EntryRow = {
    ...(base ?? {}),
    id: nextId,
    status,
    pending: !shipped,
    abnormal: false,
    管片编号: code,
    管片型号: base && !isPlaceholderValue(base['管片型号']) ? base['管片型号'] : '标准环（C50）',
    生产模具: base && !isPlaceholderValue(base['生产模具']) ? base['生产模具'] : '待分配',
    钢筋笼批号:
      base && !isPlaceholderValue(base['钢筋笼批号']) ? base['钢筋笼批号'] : commission,
    养护天数: base && !isPlaceholderValue(base['养护天数']) ? base['养护天数'] : '28',
    出厂强度: base && !isPlaceholderValue(base['出厂强度']) ? base['出厂强度'] : 'C50',
    检验人员:
      base && !isPlaceholderValue(base['检验人员'])
        ? base['检验人员']
        : String(testingRow['检测机构'] ?? ''),
    委托编号: commission,
    报告编号: reportNo,
    生产状态: status,
  }
  const rows = [...segments]
  if (index >= 0) {
    rows[index] = nextRow
  } else {
    rows.push(nextRow)
  }
  return { rows, code }
}

// 统计试验报告推送到管片侧、且仍待出厂的批次数（两边共用这一份算法）。
export function linkedPendingShipCount(testingRows: EntryRow[], segmentRows: EntryRow[]): number {
  const reported = new Set(
    testingRows
      .filter((row) => String(row.status) === STATUS_REPORTED && isSegmentSample(row))
      .map((row) => String(row['委托编号'] ?? '')),
  )
  return segmentRows.filter(
    (row) =>
      String(row.status) === SEGMENT_STATUS_PENDING_SHIP &&
      reported.has(String(row['委托编号'] ?? '')),
  ).length
}

function migrateTestingRow(row: EntryRow, earlierRows: EntryRow[]): EntryRow {
  const id = Number(row.id)
  const commission = isPlaceholderValue(row['委托编号'])
    ? `TEST-${String(id).padStart(4, '0')}`
    : String(row['委托编号']).trim()
  const rawStatus = String(row.status ?? '')
  const rawReportNo = String(row['报告编号'] ?? '').trim()
  const hasFormalReport = isFormalReportNo(rawReportNo)
  const issued = rawStatus === STATUS_REPORTED || hasFormalReport
  const status = issued
    ? STATUS_REPORTED
    : TESTING_STATUSES.includes(rawStatus)
      ? rawStatus
      : STATUS_TESTING
  const date = reportDateOf(row)
  const reportNo = issued
    ? hasFormalReport
      ? rawReportNo
      : nextReportNo(earlierRows, date)
    : ''
  const result = isPlaceholderValue(row['检测结果'])
    ? issued
      ? '合格'
      : status === STATUS_UNQUALIFIED
        ? '不合格'
        : ''
    : String(row['检测结果'])
  return {
    ...row,
    status,
    pending: testingPending(status),
    abnormal: testingAbnormal(status),
    委托编号: commission,
    试样类型: isPlaceholderValue(row['试样类型']) ? '管片（C50混凝土）' : String(row['试样类型']),
    检测项目: isPlaceholderValue(row['检测项目']) ? '混凝土抗压强度' : String(row['检测项目']),
    检测机构: isPlaceholderValue(row['检测机构']) ? '中心试验室' : String(row['检测机构']),
    送样日期: date,
    检测结果: result,
    报告编号: reportNo,
    委托状态: status,
  }
}

// 存量数据一次性补登：
// - 各模块「XX状态」尾列统一镜像权威 status，旧缓存里分叉的结论不再各说各话；
// - 试验委托按送样日期排序后逐条补登，落了一半的按已落库的那份补齐编号/结论；
// - 合格的管片报告补推管片「待出厂」待办；管片标志位也与状态同源。
export function migrateDb(input: Record<string, EntryRow[]>): Record<string, EntryRow[]> {
  const db: Record<string, EntryRow[]> = {}
  for (const meta of MODULES) {
    const rows = input[meta.key]
    db[meta.key] = Array.isArray(rows) ? rows.map((row) => ({ ...row })) : []
  }

  for (const meta of MODULES) {
    const statusField = STATUS_FIELD_BY_KEY[meta.key]
    db[meta.key] = db[meta.key].map((row) => ({
      ...row,
      [statusField]: String(row.status ?? ''),
    }))
  }

  const bySampleDate = (a: EntryRow, b: EntryRow): number => {
    const da = String(a['送样日期'] ?? '')
    const dbDate = String(b['送样日期'] ?? '')
    if (da !== dbDate) {
      return da < dbDate ? -1 : 1
    }
    return Number(a.id) - Number(b.id)
  }

  // 存量委托按送样日期补登一遍。
  const legacyTesting = [...db[TESTING_KEY]].sort(bySampleDate)
  const migratedTesting: EntryRow[] = []
  for (const row of legacyTesting) {
    migratedTesting.push(migrateTestingRow(row, migratedTesting))
  }

  // 报告结论落到管片生产的出厂待办，批次数与合格报告逐条对得上。
  let segments = [...db[SEGMENTPROD_KEY]]
  for (const row of migratedTesting) {
    if (String(row.status) === STATUS_REPORTED && isSegmentSample(row)) {
      segments = upsertSegmentSample(segments, row).rows
    }
  }
  db[SEGMENTPROD_KEY] = segments.map((row) => ({
    ...row,
    pending: String(row.status) !== SEGMENT_STATUS_SHIPPED,
    abnormal: false,
    生产状态: String(row.status ?? ''),
  }))

  db[TESTING_KEY] = migratedTesting.sort(bySampleDate)
  return db
}
