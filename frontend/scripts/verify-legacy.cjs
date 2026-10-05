// 模拟老用户浏览器：预置一版旧结构的 localStorage（半写入脏数据、无版本号），
// 用全新进程加载数据层，验证首次读取自动补登、读的就是落库那份。
class DOMException extends Error {}
const raw = {
  testing: [
    // 半写入：状态检测中却写着报告编号和结论（刷新回退那类脏数据）
    { id: 1, status: '检测中', pending: true, abnormal: true, 委托编号: 'TEST-0001', 试样类型: '混凝土', 检测项目: '抗压', 送样日期: '2026-09-10', 检测结果: '合格', 报告编号: 'BG-20260910-01', 检测机构: '某机构', 委托状态: '已出报告' },
    // 已出报告但没编号没结论（落了一半）
    { id: 2, status: '已出报告', pending: true, abnormal: false, 委托编号: 'TEST-0002', 试样类型: '混凝土', 检测项目: '抗渗', 送样日期: '2026-09-10', 检测结果: '', 报告编号: '', 检测机构: '', 委托状态: '检测中' },
    // 更早的已出报告，同日期不同天
    { id: 3, status: '已出报告', pending: false, abnormal: false, 委托编号: 'TEST-0003', 试样类型: '砂浆', 检测项目: '凝结时间', 送样日期: '2026-09-08', 检测结果: '合格', 报告编号: 'BG-20260908-07', 检测机构: '老机构', 委托状态: '已出报告' },
    // 不合格
    { id: 4, status: '不合格', pending: false, abnormal: false, 委托编号: 'TEST-0004', 试样类型: '混凝土', 检测项目: '抗压', 送样日期: '2026-09-11', 检测结果: '', 报告编号: 'BG-20260911-01', 检测机构: '', 委托状态: '检测中' },
  ],
  segmentprod: [
    { id: 1, status: '待出厂', pending: false, abnormal: false, 管片编号: 'SEGM-0003', 管片型号: 'x', 生产模具: 'x', 钢筋笼批号: 'x', 养护天数: 'x', 出厂强度: 'x', 检验人员: 'x', 生产状态: '待出厂' },
  ],
}
const store = new Map([['shield-tunnel-construction:entries', JSON.stringify(raw)]])
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { if (k.includes('version') || k.includes('entries')) store.set(k, v) },
    removeItem: (k) => store.delete(k),
  },
  addEventListener: () => {},
}
globalThis.DOMException = DOMException

require('./ts-hook.cjs')
const { allRows } = require('../src/data/local-store')
const { pendingShippingCount } = require('../src/api/local-service')

let fails = 0
const check = (n, c, e = '') => { console.log(`${c ? '  ✓' : '  ✗'} ${n}${c ? '' : ' ' + e}`); if (!c) fails++ }

const t = allRows().testing
check('半写入检测中被退回：报告编号清空', t[0]['报告编号'] === '', t[0]['报告编号'])
check('半写入检测中：结论清空', t[0]['检测结果'] === '', t[0]['检测结果'])
check('状态归位检测中、委托状态镜像一致', t[0].status === '检测中' && t[0]['委托状态'] === '检测中')
check('abnormal 脏标记纠正为 false', t[0].abnormal === false)
check('已出报告缺编号：按日期补 BG-20260910-01', t[1]['报告编号'] === 'BG-20260910-01', t[1]['报告编号'])
check('已出报告缺结论：补合格', t[1]['检测结果'] === '合格')
check('已出报告委托状态纠正', t[1]['委托状态'] === '已出报告' && t[1].pending === false)
check('老报告既编号 BG-20260908-07 原样保留（只认头一次）', t[2]['报告编号'] === 'BG-20260908-07', t[2]['报告编号'])
check('不合格：报告编号作废清空', t[3]['报告编号'] === '')
check('不合格：结论写明', t[3]['检测结果'] === '不合格' && t[3].abnormal === true)
check('待出厂待办=合格报告数=2（检测中那条不产生待办）', pendingShippingCount() === 2, String(pendingShippingCount()))
const seg = allRows().segmentprod
const linked = seg.filter((r) => String(r['来源报告'] || '').startsWith('BG-'))
check('出厂待办两份且编号互异', new Set(linked.map((r) => r['来源报告'])).size === 2, JSON.stringify(linked.map((r) => r['来源报告'])))
check('版本号已写库（后续不再重补）', store.get('shield-tunnel-construction:version') === '2')

process.exit(fails ? 1 : 0)
