/**
 * 物品附魔的**形状**——全仓只在这一个地方"剥壳"。
 *
 * 为什么单开一个模块：`Item.enchants` 的形状一代一个样，而读它的地方有四处
 * （`inventory` 背包/装备栏文本、`dig-speed` 效率附魔估时间、`world-use` 附魔台读回、
 * `shoot` 无限弓判据）。各写一份的结果就是"改了一处、漏了三处"——2026-10-27 一天里
 * 连栽两次，两次都是形状没对齐。
 *
 * 约定：本模块**零依赖**（不 import 游戏库，也不 import 本项目其它模块），谁都引得起、不会成环；
 * 它只回答"这件东西身上挂了哪些附魔条目"，**不查 registry、不翻译名字**（那是调用方的事）。
 *
 * ── 形状一览（都在实机或 proto.yml 里核过） ─────────────────────────────
 *   1.12 ：`[{ name: 'sharpness', lvl: 5 }]`                       —— 带名字
 *   1.16 ：`enchantsByName: { sharpness: 5 }`（走 prismarine-item 的旧分支）
 *   1.20.5+ / 1.21：`componentMap.get('enchantments').data`，**只有数字 id**，
 *      而且 `.data` **不是裸数组**，外面套着一层同名 key：
 *          { enchantments: [ { id: 32, level: 5 } ] }
 *      依据：minecraft-data `pc/1.21.9/proto.yml`
 *          SlotComponent:
 *             type: SlotComponentType
 *             data: type ?
 *                if enchantments or stored_enchantments:
 *                   enchantments: []varint
 *                      id: varint
 *                      level: varint
 *      —— `data: type ?` 的每个 case 是一个**匿名 container**，所以解出来的 `.data`
 *      永远是 `{ 组件名: 值 }` 形式的对象，数组在里面一层。
 *
 * 🔴 2026-10-27 第二轮实机（用户原话：「只显示 diamond_sword×1（enchantments 1）」）：
 *    上一版看到"对象"就当成 `{ sharpness: 5 }` 那种映射，拿 `Object.entries` 走 ——
 *    key `enchantments` 被当成附魔名、值（数组）被 `Number()` 成 NaN 再兜底成 1，
 *    于是每一件附魔装备都显示成「（enchantments 1）」。这一版先剥壳、再谈名字。
 */

/** 剥壳时要认的 key（`enchants` 放最后：`{ enchants: [...] }` 这种也被别人套过一层） */
const SHELL_KEYS = ['enchantments', 'stored_enchantments', 'enchantment_list', 'enchants']

/**
 * 这件物品身上的**原始附魔条目**（剥完壳、没翻译名字）。
 *
 * 返回数组，元素可能是 `{ name, lvl }`（老版本）、`{ id, level }`（1.21 数字 id）、
 * 或者字符串；读不到 / 不认识就给 `[]`（绝不编一个假附魔出来）。
 */
export function enchantListOf (it) {
  let list = null
  /* 未知版本读这个 getter 会直接 throw（`componentMap` 不存在时走 NBT 分支） */
  try { list = it?.enchants } catch { return [] }
  if (list == null) return []
  if (Array.isArray(list)) return list.filter(Boolean)
  if (typeof list !== 'object') return []
  /* ① 1.20.5+ 的壳：`{ enchantments: [...] }`（附魔书是 `stored_enchantments`） */
  for (const k of SHELL_KEYS) {
    if (Array.isArray(list[k])) return list[k].filter(Boolean)
  }
  /* ② 只剩一层壳、名字看不出来的：`{ anything: [...] }` */
  const vals = Object.values(list)
  if (vals.length === 1 && Array.isArray(vals[0])) return vals[0].filter(Boolean)
  /* ③ 最后才是"映射"：`{ sharpness: 5 }`。**值不是数字的一律不认** ——
   *    `{ enchantments: {…} }` 这种剥不干净的，宁可不显示，也不要输出「enchantments 1」。 */
  const out = []
  for (const [k, v] of Object.entries(list)) {
    const n = Number(v)
    if (!Number.isFinite(n)) continue
    out.push({ name: k, lvl: n })
  }
  return out
}

/** 条目自己带的**名字**（字符串）；只有数字 id 的返回 `null`，交给调用方查 registry */
export function enchRawName (e) {
  if (typeof e === 'string') return e
  if (!e || typeof e !== 'object') return null
  let nm = e.name ?? e.enchantment ?? e.type
  if (nm && typeof nm === 'object') nm = nm.name ?? nm.id
  if (typeof nm !== 'string') return null
  const s = nm.trim()
  if (!s || s.includes('[object')) return null
  return s
}

/** 条目里的**数字 id**（`{ id: 32 }`）；没有就给 `null` */
export function enchRawId (e) {
  if (!e || typeof e !== 'object') return null
  for (const k of ['id', 'enchantment', 'type']) {
    const v = e[k]
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v
  }
  return null
}

/** 条目里的**等级**（`level` / `lvl`）；认不出算 1（附魔至少 I 级） */
export function enchRawLevel (e) {
  if (!e || typeof e !== 'object') return 1
  const n = Number(e.level ?? e.lvl ?? 1)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1
}
