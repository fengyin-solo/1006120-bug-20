<template>
  <section class="page" data-module="segmentprod">
    <header class="page-head">
      <div>
        <h2>管片生产管理</h2>
        <p class="page-desc">试验合格报告自动进入「待出厂」待办；本表与试验检测共用同一算法，批次数两边对得上。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记管片</button>
        <button class="btn" type="button" @click="exportRows">导出管片生产清单</button>
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
              v-for="action in actions"
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
          <td :colspan="columns.length + 2" class="empty-state">暂无管片生产数据，可先登记管片</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条管片生产记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
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
  SEGMENT_STATUS_PENDING_SHIP,
  SEGMENT_STATUS_SHIPPED,
  TESTING_KEY,
  linkedPendingShipCount,
} from '@/data/domain'
import { listRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('segmentprod')
// 委托编号、报告编号两列由试验报告联动写入，出厂时可与试验侧逐批核对。
const columns = ["管片编号", "管片型号", "钢筋笼批号", "委托编号", "报告编号", "养护天数", "出厂强度", "检验人员", "生产状态"]
const actions = ["开始浇筑", "确认养护", "办理出厂"]
const statuses = ["待浇筑", "养护中", "待出厂", "已出厂"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["管片编号", "管片型号", "钢筋笼批号"]
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 与试验检测页同源：联动待出厂批次数两边只认这一份算法。
const stats = computed(() => {
  const counts = moduleStatusCounts(meta.key)
  return [
    { label: '养护中管片', value: counts['养护中'] ?? 0 },
    { label: '待出厂管片', value: counts[SEGMENT_STATUS_PENDING_SHIP] ?? 0 },
    {
      label: '试验联动待出厂',
      value: linkedPendingShipCount(listRows(TESTING_KEY), listRows(meta.key)),
    },
    { label: '已出厂管片', value: counts[SEGMENT_STATUS_SHIPPED] ?? 0 },
  ]
})

function displayCell(row: EntryRow, column: string): string {
  const value = row[column]
  if (value === undefined || value === null || String(value) === '') {
    return '—'
  }
  return String(value)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '管片登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '管片生产列表读取失败'
  }
}

onMounted(reload)
</script>
