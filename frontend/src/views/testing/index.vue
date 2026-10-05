<template>
  <section class="page" data-module="testing">
    <header class="page-head">
      <div>
        <h2>试验检测管理</h2>
        <p class="page-desc">出具报告一次落定：检测结果、报告编号与委托状态同一事务写入，合格报告联动管片待出厂待办。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记试验委托</button>
        <button class="btn" type="button" @click="exportRows">导出试验检测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ displayCell(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无试验检测数据，可先登记试验委托</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条试验检测记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-else-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="issueTarget" class="modal-mask" @click.self="closeIssue">
      <form class="modal-card" @submit.prevent="confirmIssue">
        <h3>出具报告</h3>
        <p class="modal-sub">委托 {{ issueTarget['委托编号'] }} · {{ issueTarget['检测项目'] }}</p>
        <label class="filter-item">
          <span>检测结果</span>
          <input v-model="issueResult" placeholder="如：合格" />
        </label>
        <p class="modal-tip">确认后检测结果、报告编号与委托状态一次落定；结论不合格请改走「登记不合格 → 安排复检」。</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit">确认出具</button>
          <button class="btn ghost" type="button" @click="closeIssue">取消</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  moduleStatusCounts,
  runAction as applyAction,
} from '@/api/local-service'
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
  linkedPendingShipCount,
} from '@/data/domain'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('testing')
const columns = ["委托编号", "试样类型", "检测项目", "送样日期", "检测结果", "报告编号", "检测机构", "委托状态"]
const statuses = ["待送样", "检测中", "已出报告", "不合格"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const issueTarget = ref<EntryRow | null>(null)
const issueResult = ref('合格')

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 统计与列表同源，并与运营概览共用统一算法；待出厂批次数直接读管片侧落库待办。
const stats = computed(() => {
  const counts = moduleStatusCounts(meta.key)
  return [
    { label: '待送样委托', value: counts[STATUS_PENDING_SAMPLE] ?? 0 },
    { label: '检测中委托', value: counts[STATUS_TESTING] ?? 0 },
    { label: '已出报告', value: counts[STATUS_REPORTED] ?? 0 },
    {
      label: '待出厂管片（联动）',
      value: linkedPendingShipCount(listRows(meta.key), listRows(SEGMENTPROD_KEY)),
    },
  ]
})

// 没出过报告的单元格不留「样例」残影，统一以空占位展示。
function displayCell(row: EntryRow, column: string): string {
  const value = row[column]
  if (value === undefined || value === null || String(value) === '') {
    return '—'
  }
  return String(value)
}

// 动作按状态收敛：不合格的委托复检前看不到「出具报告」，越级入口本身就不给。
function actionsFor(row: EntryRow): string[] {
  const status = String(row.status)
  if (status === STATUS_PENDING_SAMPLE) {
    return [ACTION_SEND]
  }
  if (status === STATUS_TESTING) {
    return [ACTION_ISSUE, ACTION_REJECT]
  }
  if (status === STATUS_UNQUALIFIED) {
    return [ACTION_RECHECK]
  }
  return []
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '试验委托登记入口尚未接入审批流'
  noticeMessage.value = ''
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  if (action === ACTION_ISSUE) {
    issueTarget.value = row
    issueResult.value = '合格'
    return
  }
  handleResult(applyAction(meta.key, Number(row.id), action))
}

function closeIssue() {
  issueTarget.value = null
}

function confirmIssue() {
  if (!issueTarget.value) {
    return
  }
  const target = issueTarget.value
  const result = applyAction(meta.key, Number(target.id), ACTION_ISSUE, {
    result: issueResult.value,
  })
  closeIssue()
  handleResult(result)
}

function handleResult(result: { ok: boolean; message: string; duplicate?: boolean }) {
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '试验检测列表读取失败'
  }
}

onMounted(reload)
</script>
