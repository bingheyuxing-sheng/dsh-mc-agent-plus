#!/usr/bin/env node
/**
 * check-core-inventory.mjs —— `mc_inventory` 的输出必须"一眼看得出总数"的回归检查
 *
 * 背景（用户 2026-10-07 转来的实机现象：「我手上4个木板它非说不算，让我去砍原木」）：
 *   `McBot.inventory()` 旧实现回 `{ held, items }`，而 mineflayer 的 `inventory.items()`
 *   **本来就包含手上那一格** —— 同一叠东西在输出里出现两遍（`"held": "oak_planksx2"` 和
 *   列表里又一条 `"oak_planksx2"`），模型当场数了两遍：
 *   「oak_planks x2 held + oak_planks x2 = 4 planks」，于是它断定 `mc_craft` 在撒谎
 *   （其实它只有 2 块木板、做工作台要 4 块），跑去砍树了。
 *
 * 这个脚本把四件事钉死（防止坑回来）：
 *   ① 同名的多格要**合计**成一条（`oak_planksx2` ×2 格 ⇒ `oak_planksx4` 一条）；
 *   ② `held` 要明说"已经算在合计里，别再加一遍"，且**不再重复出现在 items 里**；
 *   ③ 回 `text`（宿主直接渲染它，不再 pretty-print JSON），`items` 保持数组给
 *      `mc_craft` / `mc_furnace` 打"背包：…"用；
 *   ④ 静态接线：两个扩展里那行 `Array.isArray(inv)` 的老写法必须绝迹
 *      （`mc.inventory()` 回的是对象，那个条件永远为假 ⇒ 那行"背包：…"从来没打印过）。
 *
 * 用法：node tools/check-core-inventory.mjs
 *   ⚠️ **必须从包目录跑**（`<profile>/node_modules/dsh-mc-agent`）：`src/core.mjs` 顶部
 *      `import ... from 'mineflayer'`，源码树里没有 node_modules 会 ERR_MODULE_NOT_FOUND。
 *      （工作区自带 node_modules，所以在工作区跑也行。）
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

// ── 断言小工具（和别的 check-*.mjs 一致）────────────────────────────────────────
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
/** 断言"不许出现某种写法"之前必须剥注释 —— 注释里正是拿这些反面写法当例子 */
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

// ── 借依赖：源码树里没有 node_modules，从包目录借 vec3 ────────────────────────────
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
  console.log('✗ 拿不到 mineflayer —— 请从包目录（<profile>/node_modules/dsh-mc-agent）跑，')
  console.log('  或确认已安装 mineflayer。')
  process.exit(2)
}
const { McBot } = await import(new URL('../src/core.mjs', import.meta.url))

const TMP_DIRS = []
const mkMc = (stacks, heldIndex = null) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-inv-'))
  TMP_DIRS.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  /* 第三项可选：额外字段（附魔 `{ enchants: [...] }`、耐久 `{ maxDurability }` 等） */
  const items = stacks.map(([name, count, extra]) => ({ name, count, ...(extra ?? {}) }))
  mc.bot = {
    entity: {},
    // 真 mineflayer 的语义：`inventory.items()` 里**手上那一格也在内**
    inventory: { items: () => items },
    heldItem: heldIndex == null ? null : items[heldIndex],
  }
  return mc
}

/* ─────────── ① 同名多格要合计，手上那格不再重复数 ─────────── */
section('① 同名多格合计 + held 不重复计数（实机那个坑）')
{
  // 实机现场：两格 oak_planks 各 2 块（其中一格拿在手上），外加 16 块圆石
  const mc = mkMc([['oak_planks', 2], ['oak_planks', 2], ['cobblestone', 16]], 0)
  const inv = mc.inventory()
  ok(Array.isArray(inv.items), 'items 是数组（扩展要按它打"背包：…"）', JSON.stringify(inv.items))
  const planks = inv.items.find((i) => i.name === 'oak_planks')
  ok(planks && planks.count === 4, '两格 oak_planks 各 2 块 ⇒ 合计 4 块', JSON.stringify(planks))
  ok(inv.items.filter((i) => i.name === 'oak_planks').length === 1, '同名只出一条（不再两格两条）', JSON.stringify(inv.items.map((i) => `${i.name}x${i.count}`)))
  ok(inv.held === 'oak_planksx2', 'held 照旧写清手上那一叠是什么、几个', String(inv.held))
  ok(typeof inv.text === 'string' && inv.text.length > 0, '回 text（宿主直接渲染，不再 pretty-print JSON）')
  ok(inv.text.includes('oak_planksx4'), '文本里是合计后的 4 块', inv.text.replace(/\n/g, ' | '))
  ok(!/oak_planksx2[^\d]*oak_planksx2/.test(inv.text.replace('手上：oak_planksx2', '')), '正文里不会出现两遍 oak_planksx2（模型数两遍的根源）', inv.text.replace(/\n/g, ' | '))
  ok(inv.text.includes('别再加一遍'), '文本明说"手上那叠已经算在合计里，别再加一遍"', inv.text.replace(/\n/g, ' | '))
  /* 空位后缀只在真 `bot.inventory.emptySlotCount()` 可用时才有（假 bot 没有）⇒ 断言别写死后缀。 */
  ok(/共 3 叠 \/ 2 样/.test(inv.text), '给出"几叠 / 几样"的总数', inv.text.replace(/\n/g, ' | '))
}

/* ─────────── ② 只有手上那一叠（最容易数两遍的情形）─────────── */
section('② 只有手上那一叠 —— 必须报 2，不是 4')
{
  const mc = mkMc([['oak_planks', 2]], 0)
  const inv = mc.inventory()
  ok(inv.items.length === 1 && inv.items[0].count === 2, '一格 2 块 ⇒ 合计就是 2 块', JSON.stringify(inv.items))
  ok(inv.text.includes('oak_planksx2') && !inv.text.includes('oak_planksx4'), '文本里不会变成 4 块', inv.text.replace(/\n/g, ' | '))
}

/* ─────────── ③ 空背包 / 空手 ─────────── */
section('③ 空背包')
{
  const mc = mkMc([], null)
  const inv = mc.inventory()
  ok(Array.isArray(inv.items) && inv.items.length === 0, 'items 是空数组')
  ok(inv.held === null, 'held 是 null')
  ok(inv.text.includes('手上：空') && inv.text.includes('背包：空') && /共 0 叠 \/ 0 样/.test(inv.text),
    '空背包文案齐全', inv.text.replace(/\n/g, ' | '))
}

/* ─────────── ⑤ 装备与工具耐久（2026-10-15 用户点名要的） ─────────── */
section('⑤ 装备与工具耐久：会磨损的东西看得见还剩多少')
{
  const invMod = await import(new URL('../src/inventory.mjs', import.meta.url))
  const { durabilityOf, durText, durWarnOf, toolDurability, durabilityText, durWarnText, equipmentOf, equipmentText, DUR_LOW, DUR_CRITICAL } = invMod

  const pick = (used, max = 250) => ({ name: 'iron_pickaxe', count: 1, durabilityUsed: used, maxDurability: max })

  // ① 判据本身
  {
    const d = durabilityOf(pick(100))
    ok(d && d.left === 150 && d.max === 250 && Math.abs(d.pct - 0.6) < 1e-9, '已用 100 / 上限 250 ⇒ 还剩 150（60%）', JSON.stringify(d))
    ok(durabilityOf({ name: 'dirt', count: 64 }) === null, '泥土这种不会磨损的 ⇒ null（没有"耐久"这一说）')
    ok(durabilityOf(null) === null && durabilityOf(undefined) === null, 'null / undefined ⇒ null，不炸')
    /* 🔴 这条是"静默失效"的守门员：`maxDurability` 是 0/undefined 时若拿它当分母，
     *    `left/max` 会得到 `NaN`，而 `NaN <= 0.2` 恒为 false ⇒ "快坏了"永远不报警。 */
    ok(durabilityOf({ name: 'x', durabilityUsed: 0, maxDurability: 0 }) === null, '🔴 maxDurability=0 ⇒ null（0/0 是 NaN，会让"快坏了"永远不报警）')
    ok(durabilityOf({ name: 'x', durabilityUsed: 3, maxDurability: Number.NaN }) === null, 'maxDurability=NaN ⇒ null')
    const over = durabilityOf({ name: 'x', durabilityUsed: 999, maxDurability: 100 })
    ok(over && over.left === 0 && over.pct === 0, '用超了（999/100）⇒ 钳到 0，不出现负数耐久', JSON.stringify(over))
    const neg = durabilityOf({ name: 'x', durabilityUsed: -5, maxDurability: 100 })
    ok(neg && neg.left === 100, '负数用量 ⇒ 钳到 0（不能比上限还新）', JSON.stringify(neg))
    ok(durabilityOf({ name: 'x', maxDurability: 100 })?.left === 100, '没写 durabilityUsed ⇒ 当成 0（全新）')
  }

  // ② 人话与告警档
  {
    ok(durText(pick(100)) === '150/250（60%）', 'durText 是「还剩/上限（百分比）」', String(durText(pick(100))))
    ok(durText({ name: 'dirt' }) === null, '不会磨损的没有 durText')
    ok(DUR_LOW === 0.2 && DUR_CRITICAL === 0.05, '两个阈值就是 20% / 5%', `${DUR_LOW} / ${DUR_CRITICAL}`)
    ok(durWarnOf(pick(0)) === null, '全新的 ⇒ 不告警')
    /* 判据是 `<=`（见 `DUR_LOW` 的注释"低于或等于"）—— 20% 整就算"快坏了"，
     * 宁可早一句，也别等真碎了才发现。51/250 ≈ 20.4% 才是"还好"。 */
    ok(durWarnOf(pick(200)) === 'low', '剩 50/250 = 20% 整 ⇒ 已经算 low（`<=`，早提醒）', String(durWarnOf(pick(200))))
    ok(durWarnOf(pick(199)) === null, '剩 51/250 ≈ 20.4% ⇒ 还好（上一条的反面，证明不是"凡是 20% 上下都报"）', String(durWarnOf(pick(199))))
    ok(durWarnOf(pick(201)) === 'low', '剩 49/250 < 20% ⇒ low', String(durWarnOf(pick(201))))
    ok(durWarnOf(pick(238)) === 'critical', '剩 12/250 < 5% ⇒ critical', String(durWarnOf(pick(238))))
    ok(durWarnOf(pick(237)) === 'low', '剩 13/250 ≈ 5.2% ⇒ 还只是 low（critical 那条的边界反面）', String(durWarnOf(pick(237))))
    ok(durWarnOf({ name: 'dirt' }) === null, '不会磨损的永远不告警')
  }

  // ③ 收集：背包 + 装备栏都要收，最危险的在最前
  {
    const bot = {
      inventory: {
        items: () => [
          { name: 'iron_pickaxe', count: 1, slot: 36, durabilityUsed: 240, maxDurability: 250 },  // 10/250 ⇒ critical
          { name: 'diamond_sword', count: 1, slot: 37, durabilityUsed: 700, maxDurability: 1561 }, // 861/1561 ⇒ 还好
          { name: 'dirt', count: 64, slot: 38 },
        ],
        slots: (() => { const s = []; s[5] = { name: 'iron_helmet', count: 1, durabilityUsed: 150, maxDurability: 165 }; return s })(),
      },
    }
    const list = toolDurability(bot)
    ok(list.length === 3, '会磨损的三件都收进来了（泥土不算）', JSON.stringify(list.map((i) => i.name)))
    ok(list[0].name === 'iron_pickaxe' && list[0].warn === 'critical', '🔴 最危险的在最前（那把剩 10/250 的镐）', JSON.stringify(list[0]))
    ok(list.some((i) => i.name === 'iron_helmet' && i.where === 'equipped'), '🔴 穿在身上的也收（`items()` 看不到装备栏那 5/6/7/8/45 格）', JSON.stringify(list.find((i) => i.name === 'iron_helmet')))
    ok(list.find((i) => i.name === 'diamond_sword')?.warn === null, '还好用的那把不告警')
    ok(list.every((i) => typeof i.pct === 'number' && i.left >= 0 && i.max > 0), '每条的 left/max/pct 都算好了', JSON.stringify(list.map((i) => `${i.name} ${i.left}/${i.max}`)))
    ok(toolDurability({}).length === 0 && toolDurability(null).length === 0, '没 bot / 空 bot ⇒ 空数组，不炸')
    ok(toolDurability({ inventory: { items: () => { throw new Error('boom') } } }).length === 0, 'items() 抛错 ⇒ 空数组')
  }

  // ④ 文字版
  {
    const good = { inventory: { items: () => [{ name: 'diamond_sword', count: 1, durabilityUsed: 10, maxDurability: 1561 }] } }
    const g = durabilityText(good)
    ok(g && g.includes('都还好') && g.includes('diamond_sword'), '全都好好的 ⇒ 一句话带过（不堆数字）', String(g))
    const bad = { inventory: { items: () => [pick(245), { name: 'iron_axe', count: 1, durabilityUsed: 200, maxDurability: 250 }] } }
    const b2 = durabilityText(bad)
    ok(b2 && b2.startsWith('🔴 马上要坏'), '有"马上要坏"的 ⇒ 抬头就是 🔴', String(b2))
    ok(b2.includes('iron_pickaxe 5/250') && b2.includes('iron_axe 50/250'), '只列快坏的那几件，各自带数字', String(b2))
    const lowOnly = { inventory: { items: () => [pick(210)] } }
    ok(durabilityText(lowOnly).startsWith('⚠️ 快坏了'), '只是 low ⇒ ⚠️（不和 🔴 混）', String(durabilityText(lowOnly)))
    ok(durabilityText({ inventory: { items: () => [{ name: 'dirt', count: 1 }] } }) === null, '一件会磨损的都没有 ⇒ null（调用方别 push 空行）')
    const worn = { inventory: { items: () => [], slots: (() => { const s = []; s[6] = { name: 'iron_chestplate', count: 1, durabilityUsed: 235, maxDurability: 240 }; return s })() } }
    ok(durabilityText(worn).includes('穿在身上'), '穿在身上的会标出来（免得 AI 去背包里找）', String(durabilityText(worn)))
    /* 🔴 2026-10-16（用户 m11195 采纳的 F1）：`durWarnText` 是"只报快坏的"那一版 ——
     *    给 `mc_dig` / `mc_act{break}` 这种**每轮都在跑**的动作用：全好时返回 `null`（不占地方），
     *    坏的时候与 `durabilityText` 逐字相同。缺了它的后果很实：镐子在 `mc_dig` **执行中间**
     *    爆掉时，AI 拿到的结果和"挖得好好的"一模一样，只能靠自己 `mc_inventory` 去查（通常不会查）。 */
    ok(durWarnText(good) === null, '🔴 durWarnText 全好 ⇒ null（每轮都跑的动作不能刷"都还好"噪声）', String(durWarnText(good)))
    ok(durWarnText(bad) === b2, '有快坏的 ⇒ 与 durabilityText 逐字相同（共用同一份排版，不许各写一套）', String(durWarnText(bad)))
    ok(durWarnText({ inventory: { items: () => [{ name: 'dirt', count: 1 }] } }) === null, '没有会磨损的东西 ⇒ null')
    ok(durWarnText({}) === null, '没 bot ⇒ null，不炸')
  }

  // ⑤ 装备栏字符串里也带耐久
  {
    const bot = { inventory: { slots: (() => { const s = []; s[5] = { name: 'iron_helmet', count: 1, durabilityUsed: 40, maxDurability: 165 }; s[6] = { name: 'shield', count: 1 }; return s })() } }
    const eq = equipmentOf(bot)
    ok(eq.head === 'iron_helmetx1 · 耐久 125/165（76%）', '装备栏字符串后面挂上耐久', String(eq.head))
    ok(eq.torso === 'shieldx1', '不会磨损的装备照旧（不硬加"耐久"两个字）', String(eq.torso))
    ok(equipmentText(bot).includes('耐久 125/165'), 'equipmentText 也带上了', equipmentText(bot))
    ok(equipmentOf({}).head === null, '空装备栏照旧是 null')
  }

  // ⑥ 接进背包视图
  {
    const mc = mkMc([['iron_pickaxe', 1], ['dirt', 64]], 0)
    mc.bot.inventory.slots = (() => { const s = []; s[5] = { name: 'iron_helmet', count: 1, durabilityUsed: 160, maxDurability: 165 }; return s })()
    const items = mc.bot.inventory.items()
    items[0].durabilityUsed = 246
    items[0].maxDurability = 250
    const v = mc.inventory()
    ok(Array.isArray(v.tools) && v.tools.length === 2, '背包视图多了 tools 字段（结构化）', JSON.stringify(v.tools?.map((i) => i.name)))
    ok(v.text.includes('🔴 马上要坏'), '正文里直接报警（AI 看正文就能发现）', v.text.replace(/\n/g, ' | '))
    ok(v.text.includes('iron_helmet') && v.text.includes('穿在身上'), '穿在身上的快坏了也在正文里', v.text.replace(/\n/g, ' | '))
  }

  // ⑦ 静态接线：mc_observe 真的把它报出去了
  {
    const obs = stripComments(readFileSync(new URL('../extensions/mc_observe.mjs', import.meta.url), 'utf8'))
    ok(/import \{[^}]*toolDurability[^}]*\} from '\.\.\/src\/inventory\.mjs'/.test(obs), 'mc_observe 引了 toolDurability')
    ok(/toolDurability\(bot\)/.test(obs) && /durabilityText\(bot\)/.test(obs), 'mc_observe 真的调了这两个')
    ok(/durability: durText,/.test(obs), 'mc_observe 的 JSON 里有 durability')
    ok(/tools,/.test(obs), 'mc_observe 的 JSON 里有 tools')
    ok(obs.includes('out.durability'), 'mc_observe 的正文里会打出来（不只是塞进 JSON）')
    const invSrc = stripComments(readFileSync(new URL('../src/inventory.mjs', import.meta.url), 'utf8'))
    ok(/export function durabilityOf/.test(invSrc) && /export function toolDurability/.test(invSrc), 'inventory.mjs 导出了这两个')
    ok(!/from '\.\/core\.mjs'/.test(invSrc), '🔴 inventory.mjs 仍然不反向 import core.mjs')
  }
}

/* ─────────── ④ 静态接线：老写法必须绝迹 ─────────── */
section('④ 静态接线（老写法不许回来）')
{
  /* 🔴 2026-10-15 审计：`inventory()` 的实现早就搬到 `src/inventory.mjs` 了
   *    （`core.mjs` 里只剩同名薄包装）⇒ 旧断言在 core 里找不到原文，一直红着。
   *    判据改成：实现文件里有这三条，且 core 确实把它接上了。 */
  const core = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const coreNo = stripComments(core)
  const inv = stripComments(readFileSync(new URL('../src/inventory.mjs', import.meta.url), 'utf8'))
  ok(inv.includes('同名已合计'), 'inventory.mjs 的 inventory() 标了"同名已合计"')
  ok(inv.includes('别再加一遍'), 'inventory.mjs 的 inventory() 提醒"别再加一遍"')
  ok(!/items:\s*b\.inventory\.items\(\)\.map/.test(inv), 'inventory.mjs 不再直接把 items() 原样 map 出去（那是重复计数那版）')
  ok(/const totals = new Map\(\)/.test(inv), 'inventory.mjs 用 totals 按名字合计')
  ok(/from '\.\/inventory\.mjs'/.test(coreNo), 'core 确实从 inventory.mjs 导入（别只搬不接）')

  for (const f of ['mc_craft.mjs', 'mc_furnace.mjs']) {
    const src = stripComments(readFileSync(new URL(`../extensions/${f}`, import.meta.url), 'utf8'))
    ok(src.includes('Array.isArray(inv?.items)'), `${f} 按 { items } 取背包一览`)
    ok(!/Array\.isArray\(inv\)\s*\?/.test(src), `${f} 不再写 Array.isArray(inv)（条件永远为假）`)
    ok(src.includes('背包：'), `${f} 还会打"背包：…"这一行`)
  }
}

/* ─────────── ⑥ 附魔要看得到（2026-10-27 用户："现在看不到附魔的属性"） ─────────── */
section('⑥ 附魔：看得见、而且附魔不同的不合并')
{
  const invMod = await import(new URL('../src/inventory.mjs', import.meta.url))
  const { enchantsOf, enchText, enchKey, itemText, equipmentOf } = invMod

  /* ① 解析：两种 nbt 形状都认（`{name,lvl}` 老形状 / `{type,level}` 1.20.5+ 组件形状） */
  const sharp = { name: 'diamond_sword', count: 1, enchants: [{ name: 'sharpness', lvl: 5 }, { name: 'unbreaking', lvl: 3 }] }
  const modern = { name: 'diamond_sword', count: 1, enchants: [{ type: 'minecraft:mending', level: 1 }] }
  const plain = { name: 'diamond_sword', count: 1, enchants: [] }
  ok(enchText(sharp) === 'sharpness V、unbreaking III', '老形状 {name,lvl} 认得出', String(enchText(sharp)))
  ok(enchText(modern) === 'mending I', '1.20.5+ 的 {type,level} 也认，且剥掉 minecraft:', String(enchText(modern)))
  ok(enchText(plain) === null && enchKey(plain) === '', '没附魔 ⇒ null / 空签名（别输出空括号）')
  ok(enchText(null) === null && enchantsOf(null).length === 0, 'null 不炸')
  ok(enchText({ name: 'x', get enchants () { throw new Error('boom') } }) === null,
    'get enchants 抛错 ⇒ 当没附魔（未知版本会 throw，不能让它带崩整个背包）')
  ok(enchText({ name: 'x', enchants: { sharpness: 2 } }) === 'sharpness II', '映射形状 {name: lvl} 也认')

  /* ①b 🔴 2026-10-27 实机（1.21.10，用户「还是看不到附魔」）：真机形状是 `[{ id: 32, level: 5 }]`
   *     —— 只有**数字 id**，没有名字（1.20.5+ 走 `componentMap.get('enchantments').data`）。
   *     上一版把 `e.id` 当名字用，界面显示成「附魔 32 5」，用户看到的就是"还是没有附魔"。
   *     数字 id 换名字只能查 registry 的 `enchantments[id].name`（字段名是 `enchantments`，
   *     **不是** `enchants` —— `src/world-use.mjs` 那处以前就写错了）。 */
  const fakeReg = { enchantments: [] }
  fakeReg.enchantments[0] = { name: 'aqua_affinity' }
  fakeReg.enchantments[32] = { name: 'sharpness' }
  fakeReg.enchantments[34] = { name: 'unbreaking' }
  const idSword = { name: 'diamond_sword', count: 1, enchants: [{ id: 32, level: 5 }, { id: 34, level: 3 }] }
  ok(enchText(idSword, fakeReg) === 'sharpness V、unbreaking III', '1.21 数字 id 换成名字', String(enchText(idSword, fakeReg)))
  ok(itemText(idSword, fakeReg) === 'diamond_swordx1（sharpness V、unbreaking III）', 'itemText 也认数字 id')
  const noName = enchantsOf({ enchants: [{ id: 32, level: 5 }] })
  ok(noName.length === 1 && !/^\d+$/.test(noName[0].name),
    '认不出名字时**不许**把裸数字当名字（旧 bug 显示"附魔 32 5"）', JSON.stringify(noName))
  /* ①c 🔴 2026-10-27 第二轮实机（用户原话：「只显示 diamond_sword×1（enchantments 1）」）：
   *     1.21 的 `.data` **不是裸数组**，外面套着一层同名 key：
   *     `{ enchantments: [{ id: 32, level: 5 }] }`
   *     （依据 minecraft-data `pc/1.21.9/proto.yml` 的 `SlotComponent: data: type ?` —— 每个 case 是匿名 container）。
   *     上一版看到对象就当 `{ sharpness: 5 }` 映射走 ⇒ key `enchantments` 被当附魔名、数组 `Number()` 成 NaN 再兜底 1
   *     ⇒ 每件附魔装备都显示成「（enchantments 1）」。 */
  const shelled = { name: 'diamond_sword', count: 1, enchants: { enchantments: [{ id: 32, level: 5 }, { id: 34, level: 3 }] } }
  ok(enchText(shelled, fakeReg) === 'sharpness V、unbreaking III', '真形状：{ enchantments: [{id,level}] } 剥壳后换名字', String(enchText(shelled, fakeReg)))
  ok(!/enchantments/.test(String(enchText(shelled, fakeReg))), '绝不把组件名 `enchantments` 当附魔名输出（旧 bug 的原文）')
  /* 这一句必须排在 `setEnchantRegistry` **之前**：登记过全局兜底之后，没有 reg 参数也能换名字了。 */
  ok(enchText(shelled) === '#32 V、#34 III', '没有 registry 就写 `#32`（明示没认出来，也不拿数字当名字）', String(enchText(shelled)))
  ok(enchText({ enchants: { stored_enchantments: [{ id: 32, level: 5 }] } }, fakeReg) === 'sharpness V', '附魔书的 stored_enchantments 也认')
  const nested = { enchants: { enchantments: { enchantments: [{ id: 32, level: 5 }] } } }
  ok(enchText(nested, fakeReg) === null, '剥不干净的怪形状宁可不显示，也不编一个假附魔', String(enchText(nested, fakeReg)))
  ok(invMod.enchantsOf(shelled, fakeReg).length === 2, '剥壳在 `src/item-ench.mjs`，inventory 只是调用方', JSON.stringify(invMod.enchantsOf(shelled, fakeReg)))
  invMod.setEnchantRegistry(fakeReg)
  ok(enchText(idSword) === 'sharpness V、unbreaking III', 'setEnchantRegistry 之后纯函数（没有 bot 参数的）也能换名字')
  ok(invMod.setEnchantRegistry({ enchants: {} }) === fakeReg,
    '字段名不对的 registry 不覆盖已有登记（registry 里是 enchantments，不是 enchants）')
  const dsMod = await import(new URL('../src/dig-speed.mjs', import.meta.url))
  ok(JSON.stringify(dsMod.enchantsOfItem({ enchants: [{ id: 32, level: 5 }] }, fakeReg)) === '[{"name":"sharpness","lvl":5}]',
    'dig-speed 也认数字 id（不然效率附魔被当"没附魔"，挖掘时间估偏大）')
  ok(dsMod.enchantsOfItem({ enchants: [{ id: 999, level: 1 }] }, fakeReg).length === 0, '查不到的数字 id 直接跳过（不猜）')
  try {   /* 真数据核对：读不到 registry 数据就跳过，不算失败 */
    const mkReg = (await import('prismarine-registry')).default
    const real = mkReg('1.21.10')
    ok(real.enchantments?.[32]?.name === 'sharpness', '真 registry：id 32 就是 sharpness（对照表没记错）')
    ok(real.enchants === undefined, '真 registry 里没有 `enchants` 字段')
  } catch (e) { console.log(`  （跳过真 registry 核对：${e.message}）`) }

  /* ② 展示：手上 / 单件 */
  ok(itemText(sharp) === 'diamond_swordx1（sharpness V、unbreaking III）', 'itemText 带上附魔', itemText(sharp))
  ok(itemText(plain) === 'diamond_swordx1', '没附魔就只写名字（不多一对括号）', itemText(plain))

  /* ③ 合计：附魔不同的同名物品**不能**合并（以前会被算成"2 把"） */
  const mc = mkMc([
    ['diamond_sword', 1, { enchants: [{ name: 'sharpness', lvl: 5 }] }],
    ['diamond_sword', 1, { enchants: [] }],
    ['diamond_sword', 1, { enchants: [{ name: 'sharpness', lvl: 5 }] }],
    ['cobblestone', 16],
  ], 0)
  const inv = mc.inventory()
  const swords = inv.items.filter((i) => i.name === 'diamond_sword')
  ok(swords.length === 2, '锋利 V ×2 合成一条、白板单独一条', JSON.stringify(swords))
  ok(swords.some((s) => s.count === 2 && s.enchants?.[0]?.name === 'sharpness'), '锋利那把是 2 把', JSON.stringify(swords))
  ok(swords.some((s) => s.count === 1 && !s.enchants), '白板那把是 1 把、且不带 enchants 字段', JSON.stringify(swords))
  ok(inv.text.includes('sharpness V'), '文本里看得见附魔', inv.text.replace(/\n/g, ' | '))
  ok(inv.held === 'diamond_swordx1（sharpness V）', '手上那行也带附魔', String(inv.held))
  ok(inv.text.includes('cobblestonex16'), '没附魔的东西照旧合计', inv.text.replace(/\n/g, ' | '))

  /* ④ 装备栏：穿在身上的附魔也要看得见（用户就是先看装备栏） */
  const eqBot = {
    inventory: {
      slots: (() => {
        const s = []
        s[5] = { name: 'diamond_helmet', count: 1, enchants: [{ name: 'protection', lvl: 4 }], durabilityUsed: 40, maxDurability: 363 }
        return s
      })(),
    },
  }
  const eq = equipmentOf(eqBot)
  ok(String(eq.head).includes('附魔 protection IV'), '装备栏显示附魔', String(eq.head))
  ok(String(eq.head).includes('耐久 323/363'), '附魔和耐久能同时显示', String(eq.head))
}

for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
