/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  // 终态集合：落在这些状态上才算办结（pending=false），缺省取最后一个状态。
  terminalStatuses?: string[]
  // 异常态集合：统计口径里的 abnormal 一律由落库状态派生，不再读历史脏标记。
  abnormalStatuses?: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 试验检测页与概览共用的统计口径：数字全部由落库状态派生。
export type TestingStats = {
  waiting: number
  testing: number
  issued: number
  failed: number
}
