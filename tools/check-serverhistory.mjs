/**
 * 服务器地址历史（`src/serverhistory.mjs`）—— 2026-10-26 全量审计补的回归测试。
 *
 * 这个模块此前**一个自检都没有**（audit 里"0 覆盖模块"之一），而它管的是「连接到MC」弹窗
 * 里那串地址：坏了用户下次连服就得手打。审计当场查出两个"修了但没生效"的地方：
 *
 *   ① `record()` 里写 `this.logger?.warn?.(...)` —— 这个类从来没有 logger 字段
 *      ⇒ "存不下"永远静默。现在走构造参数 `log`。
 *   ② `loadFailed` / `loadError` 是 2026-10-15 为"读失败要说一声"加的访问器，
 *      但全仓无人读 ⇒ 读坏了照样静默按空跑。现在 index.js 启动时报一次（本套件钉住访问器本身）。
 *
 * 不连服务器、不碰真状态目录（全程临时目录）。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerHistory, SERVERS_FILE, MAX_SERVERS } from '../src/serverhistory.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const dirs = []
const mkdir = () => { const d = mkdtempSync(join(tmpdir(), 'mchist-')); dirs.push(d); return d }

try {
  /* ── ① 记一条、去重、最近优先 ───────────────────────────────────────────── */
  {
    const dir = mkdir()
    const h = new ServerHistory({ dir })
    ok(h.list().length === 0, '① 新目录起步是空列表')

    h.record('mc.example.com')
    h.record('localhost:25565')
    ok(h.list()[0] === 'localhost:25565', '① 最近记的排最前', JSON.stringify(h.list()))

    h.record('mc.example.com')
    ok(h.list()[0] === 'mc.example.com' && h.list().length === 2,
      '① 重复记一条 ⇒ 提到最前、不重复', JSON.stringify(h.list()))

    ok(h.record('   ') .length === 2, '① 空串/空白不记（原样返回列表）')
    ok(h.record('  mc.example.com  ')[0] === 'mc.example.com', '① 首尾空白被 trim 掉')
  }

  /* ── ② 封顶 MAX_SERVERS ────────────────────────────────────────────────── */
  {
    const dir = mkdir()
    const h = new ServerHistory({ dir })
    for (let i = 0; i < MAX_SERVERS + 7; i++) h.record(`srv-${i}.example.com`)
    ok(h.list().length === MAX_SERVERS, `② 封顶 ${MAX_SERVERS} 条`, `实际 ${h.list().length}`)
    ok(h.list()[0] === `srv-${MAX_SERVERS + 6}.example.com`, '② 封顶时留下的是最新的')
    ok(!h.list().includes('srv-0.example.com'), '② 最老的被挤掉')
  }

  /* ── ③ 落盘 + 重读一致（原子写，不留 .tmp）──────────────────────────────── */
  {
    const dir = mkdir()
    const h = new ServerHistory({ dir })
    h.record('a.example.com')
    h.record('b.example.com')
    const file = join(dir, SERVERS_FILE)
    ok(existsSync(file), '③ 记了就落盘')
    ok(!existsSync(`${file}.tmp`), '③ 临时文件没留下（先写 .tmp 再 rename）')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    ok(raw?.version === 1 && Array.isArray(raw?.recent), '③ 落盘结构是 {version:1, recent:[]}', JSON.stringify(raw))

    const again = new ServerHistory({ dir })
    ok(JSON.stringify(again.list()) === JSON.stringify(h.list()), '③ 重读结果与内存一致', JSON.stringify(again.list()))
    ok(again.loadFailed === false && again.loadError === null, '③ 正常文件不算"读失败"')
  }

  /* ── ④ remove ─────────────────────────────────────────────────────────── */
  {
    const dir = mkdir()
    const h = new ServerHistory({ dir })
    h.record('x.example.com'); h.record('y.example.com')
    const left = h.remove('x.example.com')
    ok(left.length === 1 && left[0] === 'y.example.com', '④ 删一条只剩另一条', JSON.stringify(left))
    ok(new ServerHistory({ dir }).list()[0] === 'y.example.com', '④ 删完也落盘了')
    ok(h.remove('不存在').length === 1, '④ 删不存在的原样返回')
  }

  /* ── ⑤ 坏文件：读宽容 + loadFailed/loadError 给得出来 ───────────────────── */
  {
    const dir = mkdir()
    writeFileSync(join(dir, SERVERS_FILE), '{ 这不是 JSON', 'utf8')
    const h = new ServerHistory({ dir })
    ok(h.list().length === 0, '⑤ 坏文件按空跑（不抛）')
    ok(h.loadFailed === true, '⑤ loadFailed = true（UI/启动日志靠它提示"历史可能丢了"）')
    ok(typeof h.loadError === 'string' && h.loadError.length > 0, '⑤ loadError 有原因', JSON.stringify(h.loadError))

    // 坏文件被"按空跑"之后，再记一条应当覆盖写回成合法 JSON
    h.record('after.example.com')
    const reread = new ServerHistory({ dir })
    ok(reread.list()[0] === 'after.example.com' && reread.loadFailed === false,
      '⑤ 坏文件之后记一条 ⇒ 文件被覆盖成合法的，重读不再报读失败')
  }

  /* ── ⑥ 存不下时能叫一声（本轮修的核心）──────────────────────────────────── */
  {
    // dir 指向一个"已经是文件"的路径 ⇒ mkdirSync / writeFileSync 必失败
    const base = mkdir()
    const asFile = join(base, 'not-a-dir')
    writeFileSync(asFile, 'x', 'utf8')
    const said = []
    const h = new ServerHistory({ dir: asFile, log: (m) => said.push(String(m)) })
    const out = h.record('will-not-save.example.com')
    ok(out[0] === 'will-not-save.example.com', '⑥ 存不下时内存里照样记着（本次会话能用）')
    ok(said.length >= 1, '⑥ 存不下时通过 log 叫了一声（原来 this.logger 恒 undefined ⇒ 永远静默）', JSON.stringify(said))
    ok(/写入失败/.test(said[0] ?? ''), '⑥ 叫的内容说清了是写入失败', JSON.stringify(said[0]))
    ok(typeof h.lastError === 'string' && /写入失败/.test(h.lastError), '⑥ lastError 也留着原因')

    // 没传 log 时不能抛（老调用方/自检里只传 dir）
    const quiet = new ServerHistory({ dir: asFile })
    let threw = null
    try { quiet.record('quiet.example.com') } catch (e) { threw = e }
    ok(threw === null, '⑥ 没传 log 时也不能抛', threw ? String(threw.message) : '')
  }

  /* ── ⑦ 目录不存在会自动建（recursive）──────────────────────────────────── */
  {
    const base = mkdir()
    const nested = join(base, 'a', 'b', 'c')
    const h = new ServerHistory({ dir: nested })
    h.record('nested.example.com')
    ok(existsSync(join(nested, SERVERS_FILE)), '⑦ 目录不存在 ⇒ save() 自己 mkdir -p')
    ok(readdirSync(nested).filter((f) => f.endsWith('.tmp')).length === 0, '⑦ 没有残留 .tmp')
  }
} finally {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ } }
}

console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
