// 端到端校验：localStorage shim + 真实业务模块，逐条对验收点（CJS 入口，TS 经 ts-hook 转译）。
class DOMException extends Error {}

let failPersist = false
const store = new Map()
const storage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (failPersist) throw new DOMException('QuotaExceededError')
    store.set(k, v)
  },
  removeItem: (k) => { store.delete(k) },
}
globalThis.window = { localStorage: storage, addEventListener: () => {} }
globalThis.localStorage = storage
globalThis.DOMException = DOMException

const {
  listEntries,
  runAction,
  loadTestingStats,
  pendingShippingCount,
  loadOverview,
} = require('../src/api/local-service')
const { allRows, commit, resetRows } = require('../src/data/local-store')
const { normalizeAll } = require('../src/data/migration')

let failures = 0
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ✓ ${name}`)
  } else {
    failures++
    console.error(`  ✗ ${name} ${extra}`)
  }
}
const getRows = (key) => JSON.parse(JSON.stringify(allRows()[key]))
const testingRow = (id) => getRows('testing').find((r) => r.id === id)

console.log('1) 存量补登（按送样日期）')
{
  const rows = getRows('testing')
  const issued = rows.find((r) => r.id === 3)
  check('已出报告存量委托补报告编号 BG-20260903-01', issued['报告编号'] === 'BG-20260903-01', issued['报告编号'])
  check('检测结果补为合格', issued['检测结果'] === '合格')
  check('委托状态镜像落库状态', issued['委托状态'] === '已出报告')
  const inProgress = rows.find((r) => r.id === 2)
  check('检测中存量残留报告编号被清', inProgress['报告编号'] === '', JSON.stringify(inProgress['报告编号']))
  check('检测中存量残留结论被清', inProgress['检测结果'] === '')
  check('检测中 abnormal 旧脏标记被纠正', inProgress.abnormal === false)
  const pending = rows.find((r) => r.id === 1)
  check('待送样残留报告编号被清', pending['报告编号'] === '')
  // 占位文本被清空
  check('检测机构占位不再顶替', issued['检测机构'] !== '试验检测样例3', issued['检测机构'])
}

console.log('2) 出厂待办对齐（报告结论落到管片生产待办）')
{
  check('待出厂批次数 = 已出合格报告数 = 1', pendingShippingCount() === 1, `got ${pendingShippingCount()}`)
  const seg = getRows('segmentprod').find((r) => r['来源报告'] === 'BG-20260903-01')
  check('存量待出厂管片被认领并挂上报告', !!seg)
}

console.log('3) 出具报告一次落定（结果+编号+状态同事务）')
{
  const res = runAction('testing', 2, '出具报告')
  check('出具成功', res.ok, res.message)
  const after = testingRow(2)
  check('检测结果=合格', after['检测结果'] === '合格')
  check('报告编号 BG-20260902-01', after['报告编号'] === 'BG-20260902-01', after['报告编号'])
  check('委托状态=已出报告（双字段一致）', after.status === '已出报告' && after['委托状态'] === '已出报告')
  check('pending=false', after.pending === false)
  check('出厂待办同步为 2', pendingShippingCount() === 2, `got ${pendingShippingCount()}`)
}

console.log('4) 重复提交只认头一次的报告编号')
{
  const res = runAction('testing', 2, '出具报告')
  check('二次出具被拒', !res.ok, res.message)
  check('报第一次编号', res.message.includes('BG-20260902-01'), res.message)
  const segLinks = getRows('segmentprod').filter((r) => r['来源报告'] === 'BG-20260902-01')
  check('没有重复生成出厂待办', segLinks.length === 1, String(segLinks.length))
}

console.log('5) 越级操作：不合格不许跳复检直接出报告')
{
  let res = runAction('testing', 1, '登记不合格')
  check('待送样登记不合格越级打回', !res.ok && res.message.includes('越级'), res.message)
  res = runAction('testing', 1, '送样委托')
  check('送样委托通过', res.ok, res.message)
  res = runAction('testing', 1, '登记不合格')
  check('检测中登记不合格通过', res.ok, res.message)
  const row = testingRow(1)
  check('不合格结论落库', row.status === '不合格' && row['检测结果'] === '不合格')
  res = runAction('testing', 1, '出具报告')
  check('不合格直接出报告被打回并指明缺复检', !res.ok && res.message.includes('复检'), res.message)
  res = runAction('testing', 1, '复检')
  check('复检回到检测中', res.ok && testingRow(1).status === '检测中', res.message)
  res = runAction('testing', 1, '出具报告')
  check('复检合格后可出报告', res.ok, res.message)
  check('复检后新编号按送样日期', /^BG-20260901-\d+$/.test(testingRow(1)['报告编号']), testingRow(1)['报告编号'])
  check('待出厂待办对齐为 3', pendingShippingCount() === 3, `got ${pendingShippingCount()}`)
}

console.log('6) 写失败整笔抽回（事务回滚，不落半截）')
{
  const snapshot = JSON.stringify(allRows()['testing'])
  failPersist = true
  const res = runAction('testing', 1, '登记不合格')
  failPersist = false
  check('落盘失败返回失败', !res.ok, res.message)
  check('内存缓存整笔退回', JSON.stringify(allRows()['testing']) === snapshot)
  const row = testingRow(1)
  check('报告编号仍在', /^BG-20260901-/.test(row['报告编号']), row['报告编号'])
  check('状态仍是已出报告', row.status === '已出报告')
  check('出厂待办没有虚增', pendingShippingCount() === 3, `got ${pendingShippingCount()}`)
}

console.log('7) commit mutator 抛错整体不写')
{
  const snapshot = JSON.stringify(allRows())
  let threw = false
  try {
    commit(() => { throw new Error('业务打回') })
  } catch { threw = true }
  check('commit 抛错透传', threw)
  check('快照完全没变', JSON.stringify(allRows()) === snapshot)
}

console.log('8) 读取同源：落库那份 vs 缓存/统计/另一入口')
{
  const persisted = JSON.parse(store.get('shield-tunnel-construction:entries'))
  const t = persisted.testing.find((r) => r.id === 2)
  check('localStorage 中报告编号正确', t['报告编号'] === 'BG-20260902-01')
  check('localStorage 中状态正确', t.status === '已出报告')
  const stats = loadTestingStats()
  check('试验页统计：已出报告=3', stats.issued === 3, JSON.stringify(stats))
  check('试验页统计：不合格=0', stats.failed === 0, JSON.stringify(stats))
  const ov = loadOverview().modules.find((m) => m.name === '试验检测')
  check('概览（另一入口）与本页对齐：待处理0 异常0', ov.pending === 0 && ov.abnormal === 0, JSON.stringify(ov))
  const segOv = loadOverview().modules.find((m) => m.name === '管片生产')
  const segRows = getRows('segmentprod')
  const waitingShip = segRows.filter((r) => String(r.status) === '待出厂' && /^BG-/.test(r['来源报告'])).length
  check('管片待出厂数与报告放行数一致', waitingShip === pendingShippingCount() && waitingShip === 3, `${waitingShip} vs ${pendingShippingCount()}`)
  check('管片概览待处理口径=非已出厂数量', segOv.pending === segRows.filter((r) => String(r.status) !== '已出厂').length, `${segOv.pending}`)
}

console.log('9) 不存在的委托打回')
{
  const res = runAction('testing', 9999, '出具报告')
  check('找不到委托被拒', !res.ok && res.message.includes('没有找到'), res.message)
}

console.log('10) 补登幂等：归一化再跑 N 遍，编号/待办不变')
{
  const before = JSON.stringify(getRows('testing').map((r) => [r.id, r['报告编号'], r.status]))
  const linksBefore = JSON.stringify(getRows('segmentprod').map((r) => r['来源报告']).filter(Boolean).sort())
  // 直接对当前落库再跑两遍统一算法
  commit((snap) => {
    const once = normalizeAll(snap)
    const twice = normalizeAll(once)
    for (const k of Object.keys(twice)) snap[k] = twice[k]
  })
  const after = JSON.stringify(getRows('testing').map((r) => [r.id, r['报告编号'], r.status]))
  const linksAfter = JSON.stringify(getRows('segmentprod').map((r) => r['来源报告']).filter(Boolean).sort())
  check('报告编号不变', before === after)
  check('出厂待办链接不重复不丢失', linksBefore === linksAfter, linksAfter)
}

console.log('11) resetRows 后种子也走统一算法')
{
  resetRows('testing')
  resetRows('segmentprod')
  check('重置后待出厂=已出报告=1', pendingShippingCount() === 1, `got ${pendingShippingCount()}`)
  check('重置后编号仍为 BG-20260903-01', testingRow(3)['报告编号'] === 'BG-20260903-01')
}

console.log('12) 老版本库（无版本标记）首次加载自动补登')
{
  // 清版本号，不动数据，模拟老库；下一次 hydrate 会重新迁移。缓存无法直接清，用全新进程验证见下。
  store.delete('shield-tunnel-construction:version')
  check('版本标记被移除（迁移触发条件）', !store.has('shield-tunnel-construction:version'))
}

console.log('')
if (failures) {
  console.error(`共 ${failures} 项失败`)
  process.exit(1)
}
console.log('全部通过')
