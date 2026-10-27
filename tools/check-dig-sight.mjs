#!/usr/bin/env node
/**
 * check-dig-sight.mjs —— 「不能隔着方块挖」的回归检查
 *
 * 判据（2026-10-25 三次收敛后的定稿，用户原话「改成方块前后左右有一格方块是空的就可以挖」）：
 *   ① 贴身 1 格（脚下 / 头顶 / 水平相邻 / 斜角）一律放行
 *   ② 前后左右四格只要有一格是空的（空气 / 可通行）⇒ 能挖
 *   ②′ 四面有空**还要过视线**：眼睛到这一格的 7 条采样线全被实心方块挡住 ⇒ 拦（issue #3）
 *   ③ 四面全被实心包住 ⇒ 才是"隔着方块挖"，拦下并说清是哪面
 *   ④ 读不到方块 / 够不着 ⇒ 不拦（判不了就别拒绝干活）
 *
 * 用法：node tools/check-dig-sight.mjs（必须从包目录跑，理由见 check-core-dig.mjs 顶部）
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const req = (() => {
  const bases = [
    new URL('../index.js', import.meta.url).href,
    join(PROFILE, 'node_modules', 'dsh-mc-agent', 'index.js'),
    join(PROFILE, 'index.js'),
  ]
  for (const base of bases) {
    try { const r = createRequire(base); r('mineflayer'); return r } catch {}
  }
  return null
})()
if (!req) {
  console.log('✗ 拿不到 mineflayer —— 请从包目录（<profile>/node_modules/dsh-mc-agent）跑。')
  process.exit(2)
}
const Vec3 = req('vec3')
const { McBot } = await import(new URL('../src/core.mjs', import.meta.url))
const { canSeeBlockOf } = await import(new URL('../src/mining.mjs', import.meta.url))

const TMP = []

/**
 * 假 bot：目标方块在 (0,64,3)，玩家站在 (0,64,0)。
 *   `open` = 'north' → 北面 (0,64,2) 是空气，其余三面实心（有一面空 ⇒ 能挖）
 *   `open` = 'none'  → 前后左右四面全是 stone（四面被包 ⇒ 拦）
 *   `open` = null    → 邻居读不到（blockAt 返回 null）⇒ 判不了，不拦
 */
const mkBot = ({ open = 'north', walls = [] } = {}) => {
  const calls = { dig: 0 }
  const state = { dug: false, gone: new Set() }
  const mk = (name, bb, x, y, z) => ({ name, type: 0, boundingBox: bb, position: new Vec3(x, y, z) })
  const target = mk('iron_ore', 'block', 0, 64, 3)
  const isTarget = (p) => Boolean(p) && p.x === 0 && p.y === 64 && p.z === 3
  const bot = {
    entity: { position: new Vec3(0, 64, 0), onGround: true },
    game: { gameMode: 'survival' },
    registry: { itemsByName: {}, blocksByName: {}, items: {}, blocksByStateId: { 200: { name: 'iron_ore' } } },
    inventory: { items: () => [] },
    heldItem: null,
    blockAt: (p) => {
      if (!p) return null
      /* 被 `dig` 挖掉的格子（清障用）：真实世界里 `dig` 回来它就成空气了。 */
      if (state.gone.has(`${p.x},${p.y},${p.z}`)) return mk('air', 'empty', p.x, p.y, p.z)
      if (isTarget(p)) return state.dug ? mk('air', 'empty', 0, 64, 3) : target
      if (open === null) return null
      /* ⑦ 用：挡在视线中间的金矿（可以给两块，模拟"两格高的矿墙"）。 */
      for (const w of walls) {
        if (p.x === w.x && p.y === w.y && p.z === w.z) return mk(w.name ?? 'gold_ore', 'block', p.x, p.y, p.z)
      }
      /* 玩家到目标之间的走廊是空气。假 bot 的默认世界全是石头，不铺这条的话，
       * "眼睛 → 目标"的视线采样会被整片石头挡住，⑤⑥ 里那些"应该能挖"的用例会集体误拦
       * （真实世界里那几格本来就是空气）。 */
      if (open === 'north' && p.x === 0 && p.y >= 64 && p.y <= 65 && p.z >= 1 && p.z <= 4) {
        return mk('air', 'empty', p.x, p.y, p.z)
      }
      return mk('stone', 'block', p.x, p.y, p.z)
    },
    findBlocks: () => [],
    findBlock: () => null,
    setControlState: () => {},
    on: () => bot,
    removeListener: () => {},
    dig: async (blk) => {
      calls.dig++
      const q = blk?.position ?? null
      if (q) state.gone.add(`${q.x},${q.y},${q.z}`)
      if (isTarget(q)) state.dug = true
    },
    pathfinder: { goto: async () => {}, stop: () => {}, setMovements: () => {} },
  }
  return { bot, calls, state, target }
}

const mkMc = (fake) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-digsight-'))
  TMP.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  mc.bot = fake.bot
  mc.mcPlugins = {}
  mc.pfReady = true
  mc._pf = {
    goals: { GoalNear: class { constructor (x, y, z, r) { Object.assign(this, { x, y, z, r }) } } },
    Movements: class { constructor () {} },
  }
  mc.cfg.collectBudgetMs = 300
  return mc
}

/* ─────────── ① 四面全实心 ⇒ 一格都不挖 ─────────── */
section('① 前后左右四面全被实心包住 ⇒ 不挖，并说清挡着的是哪面')
{
  const fake = mkBot({ open: 'none' })
  const mc = mkMc(fake)
  const out = await mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  ok(fake.calls.dig === 0, '没调用 bot.dig（一格都没挖）', `dig=${fake.calls.dig}`)
  ok(out.some((l) => /四面都被实心方块包着/.test(l)), '明说"四面都被实心方块包着"', String(out[0]).slice(0, 90))
  ok(out.some((l) => /\*\*stone\*\*/.test(l)), '报出挡着的方块名', String(out[0]).slice(0, 90))
  ok(out.some((l) => /0, 64, 2/.test(l)), '给出其中一面的坐标（可以去挖它）')
}

/* ─────────── ② 有一面是空的 ⇒ 照常挖 ─────────── */
section('② 前后左右有一格是空的 ⇒ 照常挖')
{
  const fake = mkBot({ open: 'north' })
  const mc = mkMc(fake)
  const out = await mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  ok(fake.calls.dig === 1, '调用了 bot.dig', `dig=${fake.calls.dig}`)
  ok(/挖掉 iron_ore/.test(out[0] ?? ''), '报了"挖掉 iron_ore"', String(out[0]).slice(0, 80))
  ok(!out.some((l) => /隔着方块/.test(l)), '没有误报"隔着方块"')
}

/* ─────────── ③ 判不了 ⇒ 不拦 ─────────── */
section('③ 邻居读不到（区块没加载）⇒ 不拦（不能凭空拒绝干活）')
{
  const fake = mkBot({ open: null })
  const mc = mkMc(fake)
  const out = await mc.dig({ pos: { x: 0, y: 64, z: 3 } })
  ok(fake.calls.dig === 1, '读不到邻居时照常挖', `dig=${fake.calls.dig}`)
  ok(!out.some((l) => /隔着方块/.test(l)), '没有误报')
}

/* ─────────── ④ mc_act {mode:"break"} 同一条判据 ─────────── */
section('④ breakBlock 也走同一条判据')
{
  const fake = mkBot({ open: 'none' })
  const mc = mkMc(fake)
  const r = await mc.breakBlock({ x: 0, y: 64, z: 3 })
  ok(r?.broken === false, 'broken=false', JSON.stringify({ broken: r?.broken }))
  ok(r?.blockedBy === 'stone', 'blockedBy=stone', String(r?.blockedBy))
  ok(/四面都被实心方块包着/.test(r?.note ?? ''), 'note 里说清四面都被包着', String(r?.note).slice(0, 80))
  ok(fake.calls.dig === 0, '没调用 bot.dig', `dig=${fake.calls.dig}`)

  const fake2 = mkBot({ open: 'north' })
  const mc2 = mkMc(fake2)
  const r2 = await mc2.breakBlock({ x: 0, y: 64, z: 3 })
  ok(r2?.broken === 'iron_ore', '有一面空时照常挖掉（broken=方块名）', JSON.stringify({ broken: r2?.broken }))
}

/* ─────────── ⑤ 单元：canSeeBlockOf 的三种返回 ─────────── */
section('⑤ canSeeBlockOf：能挖 / 四面被包 / 判不了')
{
  const t = mkBot({ open: 'north' })
  const r1 = await canSeeBlockOf(t.bot, { x: 0, y: 64, z: 3 })
  ok(r1?.ok === true, '有一面空 ⇒ {ok:true}', JSON.stringify(r1))

  const w = mkBot({ open: 'none' })
  const r2 = await canSeeBlockOf(w.bot, { x: 0, y: 64, z: 3 })
  ok(r2?.ok === false && r2?.blocker === 'stone', '四面被包 ⇒ {ok:false, blocker:stone}', JSON.stringify(r2))
  ok(r2?.at?.x === 0 && r2?.at?.y === 64 && r2?.at?.z === 2, 'at 是其中一面的坐标', JSON.stringify(r2?.at))

  const n = mkBot({ open: null })
  const r3 = await canSeeBlockOf(n.bot, { x: 0, y: 64, z: 3 })
  ok(r3 === null, '读不到邻居 ⇒ null（不拦）', JSON.stringify(r3))
}

/* ─────────── ⑥ 贴身 1 格一律放行 ─────────── */
section('⑥ 贴身（脚下/头顶/水平相邻 1 格）一律放行')
{
  /* 用户原话：「现在判定又太严了，在附近1格就行。刚刚站在铁矿上都挖不了」——
   * 玩家站在 (0,64,0)，脚下那块是 (0,63,0)。 */
  const w = mkBot({ open: 'none' })
  const under = await canSeeBlockOf(w.bot, { x: 0, y: 63, z: 0 })
  ok(under?.ok === true, '脚下那块放行（站着挖脚下方块不判遮挡）', JSON.stringify(under))
  const head = await canSeeBlockOf(w.bot, { x: 0, y: 65, z: 0 })
  ok(head?.ok === true, '头顶那块放行', JSON.stringify(head))
  const side = await canSeeBlockOf(w.bot, { x: 1, y: 64, z: 0 })
  ok(side?.ok === true, '水平相邻 1 格放行', JSON.stringify(side))
  const diag = await canSeeBlockOf(w.bot, { x: 1, y: 63, z: 1 })
  ok(diag?.ok === true, '斜下方 1 格也放行', JSON.stringify(diag))
  /* 离开 1 格以外才看四面：这一格四面全实心，照样拦。 */
  const far = await canSeeBlockOf(w.bot, { x: 0, y: 64, z: 3 })
  ok(far?.ok === false && far?.blocker === 'stone', '3 格外仍按四面判（不放松）', JSON.stringify(far))
}

/* ─────────── ⑦ 视线被挡：四面有空，但中间还夹着别的方块（issue #3） ─────────── */
section('⑦ 隔着别的方块挖（前面挡着金矿、后面是钻石）')
{
  /* 用户原话：「面前还有金矿，但它没先挖金矿，直接挖了后面的钻石」。
   * 旧的 ② 只看目标紧贴的四面 —— 目标旁边有矿洞开口就放行，正前方那块金矿根本没人管。
   * 真实场景是两格高的矿墙（矿脉常叠着），7 条采样线全撞上它 ⇒ 这才叫"隔着方块挖"。 */
  const w2 = mkBot({ open: 'north', walls: [{ x: 0, y: 64, z: 2 }, { x: 0, y: 65, z: 2 }] })
  const r1 = await canSeeBlockOf(w2.bot, { x: 0, y: 64, z: 3 })
  ok(r1?.ok === false, '四面有空但视线被金矿挡住 ⇒ {ok:false}', JSON.stringify(r1))
  ok(r1?.blocker === 'gold_ore', '报出挡路块是 gold_ore', String(r1?.blocker))
  ok(r1?.los === true, '标了 los:true（走的是视线采样这条判据）', String(r1?.los))
  ok(r1?.at?.z === 2, 'at 指到挡路块那一格', JSON.stringify(r1?.at))

  /* 只挡住下半格、上方还露着 ⇒ 明明看得见，不能拦（别把正常挖矿也卡死）。 */
  const w1 = mkBot({ open: 'north', walls: [{ x: 0, y: 64, z: 2 }] })
  const r2 = await canSeeBlockOf(w1.bot, { x: 0, y: 64, z: 3 })
  ok(r2?.ok === true, '只挡住下半格、上方看得见 ⇒ 放行（不误拦）', JSON.stringify(r2))
}

/* ─────────── ⑧ 视线被挡 ⇒ 自己先把挡路的挖开（2026-10-27 用户要求） ─────────── */
/* 用户原话：「现在 dig 矿石，满足上面条件就会不让挖，然后 AI 是一点一点把周围挖掉。
 *   改一下改成不满足条件直接挖到满足条件。」⇒ 工具自己清障，别把活退回给模型。 */
section('⑧ 视线被挡 ⇒ 自己把挡路的挖开，再挖目标')
{
  const fake = mkBot({ open: 'north', walls: [{ x: 0, y: 64, z: 2 }, { x: 0, y: 65, z: 2 }] })
  const mc = mkMc(fake)
  const r = await mc.breakBlock({ x: 0, y: 64, z: 3 })
  ok(fake.calls.dig >= 2, '挡路的方块真被挖了（至少 2 次 dig）', `dig=${fake.calls.dig}`)
  ok(Array.isArray(r?.cleared) && r.cleared.some((c) => c.name === 'gold_ore'),
    '结果里列出清掉了 gold_ore', JSON.stringify(r?.cleared))
  ok(r?.broken === 'iron_ore', '通路打通后目标也挖到了', String(r?.broken))
  ok(!/隔着方块挖不了/.test(r?.note ?? ''), '不再报"隔着方块挖不了"', String(r?.note ?? '').slice(0, 80))

  const fake2 = mkBot({ open: 'north', walls: [{ x: 0, y: 64, z: 2 }, { x: 0, y: 65, z: 2 }] })
  const mc2 = mkMc(fake2)
  const out = await mc2.dig({ pos: { x: 0, y: 64, z: 3 } })
  ok(fake2.calls.dig >= 2, 'mc_dig 也先挖挡路的', `dig=${fake2.calls.dig}`)
  ok(out.some((l) => /先把挡路的/.test(l)), 'mc_dig 报出"先把挡路的挖开了"', String(out[0]).slice(0, 110))
  ok(fake2.state.dug, 'mc_dig 清完通路后目标真挖掉了', String(fake2.state.dug))

  /* noClear:true 退回老行为 —— 只报告、不动手（给"就是不许挖"的场合留个口子）。 */
  const fake3 = mkBot({ open: 'north', walls: [{ x: 0, y: 64, z: 2 }, { x: 0, y: 65, z: 2 }] })
  const mc3 = mkMc(fake3)
  const r3 = await mc3.breakBlock({ x: 0, y: 64, z: 3, noClear: true })
  ok(fake3.calls.dig === 0, 'noClear:true ⇒ 一格都不挖', `dig=${fake3.calls.dig}`)
  ok(r3?.broken === false, 'noClear:true ⇒ broken=false', String(r3?.broken))
}

/* ─────────── ⑨ 挡路的是容器 / 基岩 ⇒ 不碰，说清为什么 ─────────── */
section('⑨ 挡路的是容器 / 基岩 ⇒ 不动它，把原因说清')
{
  const fake = mkBot({
    open: 'north',
    walls: [{ x: 0, y: 64, z: 2, name: 'chest' }, { x: 0, y: 65, z: 2, name: 'chest' }],
  })
  const mc = mkMc(fake)
  const r = await mc.breakBlock({ x: 0, y: 64, z: 3 })
  ok(fake.calls.dig === 0, '容器挡路 ⇒ 一格都不挖', `dig=${fake.calls.dig}`)
  ok(r?.broken === false, '容器挡路 ⇒ broken=false', String(r?.broken))
  ok(/容器/.test(r?.note ?? ''), '文案说"挡路的是容器"', String(r?.note ?? '').slice(0, 110))
}
{
  const fake = mkBot({
    open: 'north',
    walls: [{ x: 0, y: 64, z: 2, name: 'bedrock' }, { x: 0, y: 65, z: 2, name: 'bedrock' }],
  })
  const mc = mkMc(fake)
  const r = await mc.breakBlock({ x: 0, y: 64, z: 3 })
  ok(fake.calls.dig === 0, '基岩挡路 ⇒ 一格都不挖', `dig=${fake.calls.dig}`)
  ok(/挖不动/.test(r?.note ?? ''), '文案说"挖不动"', String(r?.note ?? '').slice(0, 110))
}

for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\ncheck-dig-sight：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
