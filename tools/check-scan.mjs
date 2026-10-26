/**
 * mc_scan / scanAround 的竖向窗口（2026-10-19 实机踩的坑）
 *
 * 用户当时在末地全程看着我：**站在 y=72 扫 y=94 的头，连扫三次都是 0**，
 * 于是我判"没建上"重铺了整面墙。真相是 `scanAround` 的竖向窗口
 * **以我脚底为中心 ±height**，站得低就永远扫不到高处的方块。
 *
 * 修法：加一个 `y` 参数**指定竖向中心**，并在返回里带上 `center`（真实窗口中心），
 * 别再让人把"这一层没有"读成"整座山都没有"。
 */
import { readFileSync } from 'node:fs'
import { Vec3 } from 'vec3'
import { scanAround, statNameOf, statMatches } from '../src/world-scan.mjs'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)

/* 假 bot：只认同一个方块名，地图用 Set 存坐标 */
function makeBot (feetY, blocks) {
  const set = new Set(blocks.map((p) => `${p.x},${p.y},${p.z}`))
  return {
    entity: { position: new Vec3(0, feetY, 0), yaw: 0, pitch: 0 },
    blockAt (pos) {
      if (!set.has(`${pos.x},${pos.y},${pos.z}`)) return { name: 'air', getProperties: () => ({}) }
      return { name: 'blue_concrete', getProperties: () => ({}) }
    },
  }
}

section('① 不给 y：窗口以脚底为中心（老行为不变）')
{
  const b = makeBot(72, [{ x: 0, y: 72, z: 0 }])
  const r = scanAround(b, { radius: 2, height: 4, name: 'blue_concrete' })
  ok(r.total === 1, '脚下那一层扫得到', String(r.total))
  ok(r.center?.y === 72, 'center.y = 脚底 72', JSON.stringify(r.center))
}

section('② 给了 y：站低也能扫高处（实机那个头 y=94）')
{
  const b = makeBot(72, [{ x: 1, y: 94, z: 0 }])
  const near = scanAround(b, { radius: 2, height: 4, name: 'blue_concrete' })
  ok(near.total === 0, '不给 y ⇒ 站 y=72 扫不到 y=94（这就是当初误判的根源）', String(near.total))
  const far = scanAround(b, { radius: 2, height: 4, name: 'blue_concrete', y: 94 })
  ok(far.total === 1, '给 y=94 ⇒ 扫得到', String(far.total))
  ok(far.nearest === '1,94,0', '返回的坐标就是那块', String(far.nearest))
  ok(far.center?.y === 94, 'center 报的是真实窗口中心 94（不是脚底）', JSON.stringify(far.center))
  ok(far.height === 4, 'name 模式也带 height', String(far.height))
}

section('③ 计数模式同样认 y')
{
  const b = makeBot(60, [{ x: 0, y: 100, z: 0 }])
  const r = scanAround(b, { radius: 2, height: 4, y: 100 })
  ok(r.center?.y === 100, 'counts 模式 center.y = 100', JSON.stringify(r.center))
  ok((r.counts ?? []).some((c) => c.name === 'blue_concrete' && c.count === 1), '数到那 1 块', JSON.stringify(r.counts))
}

section('④ y 传垃圾值不炸（当没传）')
{
  const b = makeBot(72, [])
  for (const bad of [null, undefined, '', 'abc', NaN]) {
    const r = scanAround(b, { radius: 1, height: 1, y: bad })
    ok(r.center?.y === 72, `y=${JSON.stringify(bad)} ⇒ 回落脚底 72`, JSON.stringify(r.center))
  }
}

section('⑤ radius / height / limit 传垃圾值有兜底（2026-10-26 全量审计）')
{
  /* 现场：`const R = Math.min(Math.max(radius, 1), 48)` 只做隐式转数字，`'abc'` ⇒ NaN
   * ⇒ 扫描循环一圈不跑 ⇒ **静默回"周围什么都没有"**（比报错更坑：AI 会当成"这里没矿"）。
   * `limit` 更直接喂给 `slice(0, limit)`：负数会"砍掉最后几条"。 */
  const b = makeBot(72, [{ x: 0, y: 72, z: 0 }])
  for (const bad of ['abc', null, NaN, {}, '']) {
    const r = scanAround(b, { radius: bad, height: bad, limit: bad, name: 'blue_concrete' })
    ok(r.total === 1, `radius/height/limit=${JSON.stringify(bad)} ⇒ 回落默认值，照常扫到`, JSON.stringify({ total: r.total, radius: r.radius }))
  }

  const five = makeBot(72, [0, 1, 2, 3, 4].map((x) => ({ x, y: 72, z: 0 })))
  const neg = scanAround(five, { radius: 6, height: 1, name: 'blue_concrete', limit: -2 })
  ok(neg.found.length === 1, 'limit 负数 ⇒ 夹到下限 1 条（老行为 slice(0,-2) 会剩 3 条）', String(neg.found.length))
  const huge = scanAround(five, { radius: 6, height: 1, name: 'blue_concrete', limit: 1e9 })
  ok(huge.found.length === 5, 'limit 超大 ⇒ 全部 5 条都在（不炸）', String(huge.found.length))
  const zero = scanAround(five, { radius: 6, height: 1, name: 'blue_concrete', limit: 0 })
  ok(zero.found.length === 1, 'limit 0 ⇒ 也夹到 1 条（别回空列表让人以为没找到）', String(zero.found.length))
}

/* 🔴 2026-10-24 用户实机（问题清单第 12 条）：`if (isAir(...)) continue` 把 cave_air/void_air
 *    也跳过了 ⇒ 点名找它们永远是"没找到"。 */
{
  const wsSrc = readFileSync(new URL('../src/world-scan.mjs', import.meta.url), 'utf8')
  ok(/if \(!name \|\| blk\.name !== name\) continue/.test(wsSrc), '点名查空气变体（cave_air/void_air）时放行')
}


section('⑥ 水/岩浆分「源头」和「流动」（2026-10-26 用户：“流动的水 scan 出来也是水”）')
{
  const w = (level) => ({ name: 'water', getProperties: () => (level === undefined ? {} : { level }) })
  ok(statNameOf(w(0)) === 'water', 'level 0 = 源头 water', statNameOf(w(0)))
  ok(statNameOf(w(1)) === 'flowing_water', 'level 1 = 流动水', statNameOf(w(1)))
  ok(statNameOf(w(7)) === 'flowing_water', 'level 7 = 流动水', statNameOf(w(7)))
  ok(statNameOf(w(8)) === 'flowing_water', 'level 8（往下落）= 流动水', statNameOf(w(8)))
  ok(statNameOf({ name: 'lava', getProperties: () => ({ level: 0 }) }) === 'lava', '岩浆源头 = lava')
  ok(statNameOf({ name: 'lava', getProperties: () => ({ level: 3 }) }) === 'flowing_lava', '流动岩浆 = flowing_lava')
  ok(statNameOf({ name: 'water', getProperties: () => ({}) }) === 'water', '读不到 level 就按原名（不瞎报流动）')
  ok(statNameOf({ name: 'water' }) === 'water', '连 getProperties 都没有也不炸')
  ok(statNameOf({ name: 'water', getProperties: () => { throw new Error('x') } }) === 'water', 'getProperties 抛错也不炸')
  ok(statNameOf({ name: 'oak_log', getProperties: () => ({ level: 0 }) }) === 'oak_log', '非水/岩浆不受影响')
  ok(statNameOf(null) == null, 'null 不炸')

  /* 一块源头水 + 一块流动水，其余是空气 */
  const b = {
    entity: { position: new Vec3(0, 70, 0), yaw: 0, pitch: 0 },
    blockAt (pos) {
      if (pos.y !== 70) return { name: 'air', getProperties: () => ({}) }
      if (pos.x === 0 && pos.z === 0) return { name: 'water', getProperties: () => ({ level: 0 }) }
      if (pos.x === 1 && pos.z === 0) return { name: 'water', getProperties: () => ({ level: 3 }) }
      return { name: 'air', getProperties: () => ({}) }
    },
  }
  const c = scanAround(b, { radius: 2, height: 1 })
  const byName = Object.fromEntries((c.counts ?? []).map((x) => [x.name, x.count]))
  ok(byName.water === 1, '占比里源头水 1 格', JSON.stringify(byName))
  ok(byName.flowing_water === 1, '占比里流动水 1 格', JSON.stringify(byName))

  const flow = scanAround(b, { radius: 2, height: 1, name: 'flowing_water' })
  ok(flow.total === 1 && flow.found?.[0] === '1,70,0', 'name=flowing_water 只找到流动那格', JSON.stringify(flow.found))
  const src = scanAround(b, { radius: 2, height: 1, name: 'water' })
  ok(src.total === 2, 'name=water 源头 + 流动都找到（族名不做过滤）', String(src.total))
  ok((src.blocks ?? []).some((x) => x.stat === 'flowing_water'),
    '每条用 stat 标出是哪种（流动那条标了）', JSON.stringify(src.blocks))
  ok(statMatches('flowing_lava', 'lava') && statMatches('lava', 'lava'), 'name=lava 也匹配流动岩浆')
  ok(!statMatches('water', 'flowing_water') && !statMatches('lava', 'flowing_lava'), '点流动的只给流动的')
  ok(!statMatches('flowing_water', 'lava') && !statMatches('oak_log', 'water'), '不串族')
}

console.log(`\n${fail ? '❌' : '✅'} ${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
