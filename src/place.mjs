/* ============================================================================
 * 放置 —— 把背包里的方块放到某个坐标（`mc_act {mode:"place"}` / `mc_build` 的正文）
 *
 * 路线图第 ④ 条第三十九刀从 `src\core.mjs` 搬出来（`#placeRef` + `placeBlock`）。
 * 六条判据（都是 2026-10-08 那几轮实机换来的）：
 *   ① 选料只挑**整方块**（`pickPlaceItem`）：火把/门/半砖放下去站不住，别当填充块
 *   ② 创造模式背包没有就自动取（协议级 `set_creative_slot`，不需要 OP）
 *   ③ 够不着先走近（`self.walkTo` / 创造 `self.flyTo`）；接近失败**不许吞** ——
 *      服务端按**眼睛→方块中心** 4.5（生存）/ 5.0（创造）判，超了直接报"够不着"
 *   ④ 目标格必须 `canPlaceInto`（空气/液体/草花藤蔓）；悬空就先垫一块踩上去（"搭高"）
 *   ⑤ 上游 `place_block.js` 抛的英文 `Server refused to place …` 翻译成人话
 *   ⑥ 放完**必须复核** `b.blockAt`：旧版不管成没成都报 `placed`，真机被投诉"报假成功"
 *
 * 参数：`self` = McBot（读 `requireBot` / `giveItem` / `walkTo` / `flyTo` / `equip`，
 *       写 `_selfMovingAt`），`ctx` = `{ t }`（预算闸门 `#t`，唯一的私有件）。
 * 判据：模块不 import `core.mjs`、不 import 游戏库（只认 `b.blockAt` / `b.placeBlock` / `b.lookAt` / `b.entity`）。
 * ========================================================================== */

import vec3pkg from 'vec3'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg

import { sleep } from './async-util.mjs'
import { isAir, isLiquid, canPlaceInto, isEntityItem } from './block-names.mjs'
import { pickPlaceItem, isFullBlockItem } from './place-items.mjs'
import { heldText } from './inventory.mjs'
import { standableY, portalAt } from './movement.mjs'
import { CALL_BUDGET_MS, needLeft, insufficientText } from './budget.mjs'
import { noteDesync, desyncHealNote } from './desync-guard.mjs'

/* 🔴 2026-10-23 实机（同一段时间里一条 `mc_move` 挂了 208 秒）：`b.placeBlock` 要等服务端
 *    把方块放进去才 settle，服务端不理（拒绝/失步/延迟）就**永不 settle** ——
 *    “跳起来再放”这条原地搭高的路上一样能挂死，而它不在任何预算闸门里。
 *    这里给每次放置一个上限：到点算这次没放上，由外层 `tries` 再试。 */
export const PLACE_TIMEOUT_MS = 2_500

/* 🔴 2026-10-29 DSH 补丁（从 local-0.4.3 `2f73fcd` 移植"火把姿势"）：附着类方块（火把/按钮/拉杆…）
 *    能不能放上，服务端只认"对着哪个相邻面、瞄在面上哪个高度"。旧版把这件事列成候选逐个试、记住
 *    成功的姿势；0.6.38 的 `placeRef` 只取第一个相邻面 + 瞄中心，姿势不对就整条失败、AI 只能盲换坐标。
 *    名单与顺序原样搬运（旧文件 `git show 2f73fcd:src/place.mjs`）。 */
export const ATTACH_RE = /^(torch|soul_torch|redstone_torch|.*_torch$|lantern|soul_lantern|ladder|end_rod|lever|tripwire_hook|carpet|vine|seagrass|kelp|.*_sign$|.*_banner$|.*_button$|.*_pressure_plate$|.*_head$|.*_skull$)/

/* 相邻六面的顺序（和 `placeRef` 一致：先下、再上、再水平）—— 候选面按这个顺序枚举，
 * 保证"没有记忆时第一次尝试"就是 0.6.38 的老行为（第一相邻面 + 瞄中心）。 */
const NEIGHBORS = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
const ATTACH_AIM = 0.25   // 附着类的第二种瞄高：面中心往上 1/4 格
const NUDGE_AIM = 0.28    // 被拒微调时换的俯仰偏移（往下 / 往上）
/* 🔴 2026-10-29 DSH 补丁（移植"被拒重试"）：微调就这两下，各**一次**，别无限试。 */
const NUDGES = [{ key: 'back', aim: -NUDGE_AIM }, { key: 'right', aim: NUDGE_AIM }]

/* 🔴 2026-10-29 DSH 补丁（旧版同款 `rayHitOf`，0.6.38 没搬过来）：报错时说出
 *    "准星实际打到了哪一格" —— 光说"被拒"模型只能瞎猜，报出实际打中的格子它才知道该挪哪。
 *    从眼睛沿当前 yaw/pitch 每 0.2 格采样，第一个实心方块就是答案；读不到/6 格内没有 ⇒ null。 */
export function rayHitOf (b, maxCells = 6) {
  try {
    const p = b?.entity?.position
    if (!p) return null
    const yaw = Number(b.entity.yaw ?? 0); const pitch = Number(b.entity.pitch ?? 0)
    const cp = Math.cos(pitch)
    const dir = new Vec3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp)
    const eye = new Vec3(p.x, p.y + (b.entity.eyeHeight ?? 1.62), p.z)
    let prev = null
    for (let t = 0.2; t <= maxCells; t += 0.2) {
      const c = eye.plus(dir.scale(t)).floored()
      const k = `${c.x},${c.y},${c.z}`
      if (k === prev) continue
      prev = k
      const blk = b.blockAt(c)
      if (blk && blk.boundingBox === 'block') return { x: c.x, y: c.y, z: c.z, name: blk.name }
    }
    return null
  } catch { return null }
}

/**
 * 在目标周围找一块**能站的地面**当落脚点（"走过去放"用）。找不到返回 `null`。
 *
 * 🔴 为什么不能直接朝 `pos.y` 走（用户 2026-10-13 实机报的"搭路一直搭到空气上"）：
 *    搭桥 / 搭高的目标 y 本来就在半空，而 `mc_map`/`mc_scan` 给的"地表高度"在树林里是树冠、
 *    山上是最高的石头 —— 朝那个 y 走过去，pathfinder 会一路**垫方块把自己顶上去**。
 *    改成"站到目标旁边的地面上，再伸手放"。
 */
function approachSpot (b, pos) {
  const cands = []
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (!dx && !dz) continue
      const x = pos.x + dx; const z = pos.z + dz
      const y = standableY(b, x, pos.y + 2, z)
      // `standableY` 找不到能站的地方会**原样返回**传进去的 y ⇒ 那种"半空"不算落脚点
      let under = null
      try { under = b.blockAt(new Vec3(x, y - 1, z)) } catch { under = null }
      if (!under || isAir(under.name) || isLiquid(under.name)) continue
      const d = Math.hypot(x + 0.5 - (pos.x + 0.5), y - pos.y, z + 0.5 - (pos.z + 0.5))
      if (d > 6.5) continue
      cands.push({ x, y, z, d })
    }
  }
  cands.sort((a, c) => a.d - c.d)
  return cands[0] ?? null
}

/** 找一个能对着放的相邻实体方块 */
export function placeRef (self, pos) {
  const b = self.requireBot()
  for (const [dx, dy, dz] of NEIGHBORS) {
    const nb = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz))
    if (nb && nb.boundingBox === 'block') return { ref: nb, face: { x: -dx, y: -dy, z: -dz } }
  }
  return null
}

/**
 * 「跳起来再放」—— **原地搭高**的标准做法。
 *
 * 🔴 为什么必须先跳（用户 2026-10-17 报的「一直尝试放方块」）：
 *    想在自己脚下垫一块时，落点 `underFeet.position + (0,1,0)` 恰好是
 *    **机器人自己站着的那一格**。服务端不会把方块放进玩家身体里 ⇒ 必拒。
 *    站着放 = 每一轮都失败，而且上游抛的是英文
 *    （`mineflayer/lib/plugins/place_block.js:42` 的 `Server refused to place … the block is still air`），
 *    模型看不懂"报的坐标是我自己站的地方"，只会一遍遍重试同一个点位
 *    （用户的 AI 后来自己总结成「服务端不让在脚底下放」，只好改去挖台阶）。
 *    脚离地之后那一格就空了，才放得进去。
 *
 * 用"等真的离地"而不是死等固定毫秒：跳跃的滞空窗口只有几百毫秒，
 * 而 `bot.placeBlock` 内部还要先 `await bot.lookAt(...)` 再发包（`generic_place.js:37`）。
 */
/**
 * 放完方块**回头看世界**，而不是只看回包（用户 2026-10-29：
 *   「竖井放置必须确认方块真的出现……要区分三种情况：服务器尚未确认、放置请求被拒绝、
 *     方块实际已经出现但客户端没及时收到结果」）。
 *
 * 以前只有一个判据：`placeBlock()` 的 Promise 在 1500~2500ms 内有没有 settle。于是三种完全
 * 不同的情况被压成一句“放不上”：
 *   ① 服务端其实放上了，只是回包慢/丢了  → 被判失败，于是又跳又放，把人顶出竖井；
 *   ② 服务端明确拒绝（位置被占、够不着、权限）→ 该换地方，却被当成“再试一次”；
 *   ③ 服务端还在处理（还没回包，方块也还没出现）→ 该再等一会儿，不该立刻重试。
 *
 * 现在一律先看**世界**：目标格真的变成期望方块 ⇒ `appeared`（回包慢也算成功）；
 * 拿到明确拒绝 ⇒ `refused`；到点还没有 ⇒ `pending`（说清等了多久、那格当前是什么）。
 */
export async function confirmPlaced (b, target, { name = null, before = null, waitMs = 1_200, stepMs = 100 } = {}) {
  const t0 = Date.now()
  const want = name ? String(name).replace(/^minecraft:/, '') : null
  const was = before ? String(before).replace(/^minecraft:/, '') : null
  const empty = new Set(['air', 'cave_air', 'void_air'])
  let got = null
  for (;;) {
    try {
      const blk = target ? b.blockAt(target, false) : null
      got = blk?.name ? String(blk.name).replace(/^minecraft:/, '') : null
      /* 🔴 2026-10-29：**没有期望名字时必须要求“和放置前不一样”** —— 以前只判“非空气”，
       *   于是往水/草丛这类可替换格里放时，那格本来就有 water/grass，会被当成“放上了”，
       *   反过来把真失败报成成功（check-core-place 就是这么照出来的）。 */
      const okName = want ? got === want : (Boolean(got) && !empty.has(got) && got !== was)
      if (got && !empty.has(got) && okName) {
        return { state: 'appeared', waitedMs: Date.now() - t0, expected: want ?? (was ? `not ${was}` : null), got }
      }
    } catch { /* 区块没加载：继续等，不当作失败 */ }
    if (Date.now() - t0 >= waitMs) return { state: 'pending', waitedMs: Date.now() - t0, expected: want, got }
    await sleep(stepMs)
  }
}

/** 目标格坐标：`placeBlock(ref, face)` 放在 `ref.position + face`。 */
function placeTargetOf (refBlock, face) {
  try {
    const base = refBlock?.position ?? refBlock
    if (!base || !face) return null
    return new Vec3(Math.floor(Number(base.x) + Number(face.x)), Math.floor(Number(base.y) + Number(face.y)), Math.floor(Number(base.z) + Number(face.z)))
  } catch { return null }
}

/** 这个错误算不算“服务端明确拒绝”。 */
export function isPlaceRefused (e) {
  return /refus|refused to place|Server refused|not allowed|denied/i.test(String(e?.message ?? e ?? ''))
}

/** 三种放置结果说成人话（工具返回 / 日志共用）。 */
export function placeConfirmText (c) {
  if (!c) return ''
  const at = c.got ? `那格现在是 ${c.got}` : '那格还是空的'
  if (c.state === 'appeared') return `方块已确认出现（${c.got}，${c.waitedMs}ms）`
  if (c.state === 'refused') return `服务端明确拒绝放置（${at}）`
  return `发了 ${c.waitedMs}ms 服务端还没确认、方块也没出现（${at}）`
}

/* 🔴 2026-10-29 DSH 补丁（移植"火把姿势"第二步）：下面一小组只干一件事 ——
 *   把"对着哪个面、瞄多高"列成候选逐个试。第一项**必须**等于 0.6.38 的现行为
 *   （`placeRef` 的第一个相邻面 + 瞄中心），失败后才按旧版顺序补其余候选。 */
const nameAt = (b, p) => { try { return p ? (b.blockAt(p, false)?.name ?? null) : null } catch { return null } }
/** 成功要认**变体**（火把贴墙变 `wall_torch`），别只认字面。 */
const sameItem = (b, target, name) => Boolean(name)
  && String(nameAt(b, target) ?? '').replace(/wall_/g, '') === String(name).replace(/wall_/g, '')
const postureKey = (a) => `${a.face.x},${a.face.y},${a.face.z}@${a.aim}`

/** 排候选：普通方块只有一条；附着类补其余相邻面 × 两种瞄高，上次成功的姿势排最前。 */
function placePostures (self, b, pos, ref, name) {
  const base = { ref: ref.ref, face: ref.face, aim: 0 }
  if (!ATTACH_RE.test(String(name ?? ''))) return [base]
  const faces = []
  for (const [dx, dy, dz] of NEIGHBORS) {
    const nb = b.blockAt(pos.offset(dx, dy, dz))
    if (nb && nb.boundingBox === 'block') faces.push({ ref: nb, face: { x: -dx, y: -dy, z: -dz } })
  }
  const plan = []
  for (const c of (faces.length ? faces : [base]).slice(0, 4)) plan.push({ ...c, aim: 0 }, { ...c, aim: ATTACH_AIM })
  const pref = self?._attachPosture?.[name]
  const i = plan.findIndex((a) => postureKey(a) === pref)
  if (i > 0) plan.unshift(plan.splice(i, 1)[0])
  return plan.slice(0, 6)
}

/* 🔴 2026-10-29 DSH 补丁（移植"被拒重试"第一步）：试**一个**姿势，不抛 ——
 *   拒绝 / 没回包都折成 `refused` + 世界复核三态；每试一次都有 PLACE_TIMEOUT_MS 上限。 */
async function tryPosture (b, ctx, a, name) {
  const target = placeTargetOf(a.ref, a.face)
  const before = nameAt(b, target)
  await ctx.t(b.lookAt(a.ref.position.offset(0.5, 0.5 + a.aim, 0.5), true), 'lookAt', '看向放置面')
  let err = null
  try {
    await ctx.t(Promise.race([
      Promise.resolve(b.placeBlock(a.ref, new Vec3(a.face.x, a.face.y, a.face.z))),
      sleep(PLACE_TIMEOUT_MS).then(() => { throw new Error(`放方块 ${PLACE_TIMEOUT_MS}ms 没回包（服务端没理）`) }),
    ]), 'place', '放置方块')
  } catch (e) { err = e }
  const confirm = await confirmPlaced(b, target, { name, before, waitMs: err ? 900 : 700 })
  const refused = Boolean(err) && isPlaceRefused(err)
  try { b.__placeConfirm = refused ? { ...confirm, state: 'refused' } : confirm } catch { /* 记账失败不影响结果 */ }
  return { ok: sameItem(b, target, name) || confirm.state === 'appeared', err, confirm, refused, posture: a }
}

/** 微调一次：轻点后退/侧移 140ms，再换俯仰角瞄一次（各**只做一次**，上限在调用方）。 */
async function nudgeOnce (b, ctx, ref, name, n) {
  try { b.setControlState(n.key, true); await sleep(140); b.setControlState(n.key, false) } catch {}
  await sleep(80)
  return await tryPosture(b, ctx, { ref: ref.ref, face: ref.face, aim: n.aim }, name)
}

/* 🔴 2026-10-29 DSH 补丁（移植"被拒重试"第二步）：候选姿势挨个试（旧版顺序，最多 6 个），
 *   还不行再"后退 / 侧移 + 换俯仰"各重试**一次**（附着类不微调 —— 它靠候选姿势）。
 *   每次都有 PLACE_TIMEOUT_MS + `ctx.t` 的预算闸门兜底，不会无限重试。 */
async function placeWithRetries (self, b, ctx, pos, ref, name) {
  const attach = ATTACH_RE.test(String(name ?? ''))
  const plan = placePostures(self, b, pos, ref, name)
  let got = await tryPosture(b, ctx, plan[0], name)
  for (const a of plan.slice(1)) {
    if (got.ok) break
    got = await tryPosture(b, ctx, a, name)
  }
  if (!got.ok && !attach) {
    for (const n of NUDGES) {
      if (got.ok) break
      got = await nudgeOnce(b, ctx, ref, name, n)
    }
  }
  if (got.ok && attach) { try { (self._attachPosture ??= {})[name] = postureKey(got.posture) } catch {} }
  return got
}

/* 🔴 2026-10-29 DSH 补丁（移植"被拒重试"第三步）：失败文案要能照着做 ——
 *   带上准星**实际打中**的那一格（旧版 `rayHitOf`），并说清自动重试已经做过哪些。 */
function placeFailText (b, pos, got, attach) {
  const ray = rayHitOf(b)
  const rayText = ray ? `我的准星实际打在 **(${ray.x},${ray.y},${ray.z}) 的 ${ray.name}** 上（不是目标格）——` : ''
  if (got?.refused) {
    return `服务端拒了在 (${pos.x},${pos.y},${pos.z}) 的这次放置（太远 / 目标格被占 / 手上有别的 / 失步）——`
      + (attach ? '依附面和瞄点高度已经自动换着试过几轮还是不行。' : '站位和俯仰已经自动微调重试过两轮还是不行。')
      + rayText + '先用 `mc_move` 靠近或**换一个点位**，别对着同一个点位反复试，**也别当成放成功了**。'
  }
  return `在 (${pos.x},${pos.y},${pos.z}) 放完没确认：${placeConfirmText(got?.confirm)}。`
    + rayText + '**别当成放成功了**（回包成功也可能是幽灵方块）—— 等一会儿再复核，或换点位。'
}

export async function placeWhileJumping (b, refBlock, face, { tries = 3 } = {}) {
  let lastErr = null
  /* 🔴 2026-10-25 实机（用户：「水里搭不了方块的原因是上浮比普通跳跃慢」）：
   *   水里按住 jump 的上浮速度只有 ~0.6 格/秒（陆上起跳是瞬间 1.25 格），
   *   700ms 只升得到 0.42 格 —— 贴着水面往上垫一格时常常等不到“脚离格”，直接判失败。
   *   水里放宽到 2500ms；并且只要小数部分还在涨就继续等（别把“慢”当成“卡住”）。 */
  const WATER_RE = /^(water|flowing_water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/
  const inWater = (() => {
    try {
      if (b.entity?.isInWater === true) return true
      const p = b.entity?.position?.floored?.()
      if (!p) return false
      return WATER_RE.test(String(b.blockAt(p, false)?.name ?? ''))
        || WATER_RE.test(String(b.blockAt(p.offset(0, 1, 0), false)?.name ?? ''))
    } catch (e) { return false }
  })()
  const waitMs = inWater ? 2500 : 700
  try { b.setControlState('jump', true) } catch {}
  try {
    for (let i = 0; i < tries; i++) {
      // 等脚真的离开整格（`position.y` 的小数部分不再是 0）
      const t0 = Date.now()
      let bestFrac = -Infinity
      let lastProgress = Date.now()
      while (Date.now() - t0 < waitMs) {
        const y = b.entity?.position?.y
        if (typeof y === 'number') {
          const frac = y - Math.floor(y)
          if (frac > 0.05) break
          if (frac > bestFrac + 0.02) { bestFrac = frac; lastProgress = Date.now() }
          else if (inWater && Date.now() - lastProgress > 800) break
        }
        await sleep(20)
      }
      const target = placeTargetOf(refBlock, face)
      const want = b.heldItem?.name ?? null
      let before = null
      try { before = target ? (b.blockAt(target, false)?.name ?? null) : null } catch { before = null }
      try {
        await Promise.race([
          Promise.resolve(b.placeBlock(refBlock, new Vec3(face.x, face.y, face.z))),
          sleep(PLACE_TIMEOUT_MS).then(() => { throw new Error(`放方块 ${PLACE_TIMEOUT_MS}ms 没回包（服务端没理）`) }),
        ])
        /* 回包成功也要复核：回包说放了、世界没变 = 幽灵方块，不能算成功。 */
        const c = await confirmPlaced(b, target, { name: want, before, waitMs: 600 })
        try { b.__placeConfirm = c } catch { /* 记账失败不影响结果 */ }
        if (c.state === 'appeared') return true
        lastErr = new Error(`回包说放上了，但 ${target?.x},${target?.y},${target?.z} 还是 ${c.got ?? '空'}`)
      } catch (e) {
        /* 🔴 用户 2026-10-29：没回包 ≠ 没放上。先看世界再判。 */
        const c = await confirmPlaced(b, target, { name: want, before, waitMs: 900 })
        try { b.__placeConfirm = c } catch { /* 同上 */ }
        if (c.state === 'appeared') return true
        if (isPlaceRefused(e)) {
          try { b.__placeConfirm = { ...c, state: 'refused' } } catch { /* 同上 */ }
          /* 明确拒绝也**继续重试**剩下的次数（服务端有时是“这一瞬”拒），
           * 但把原始消息带上 —— 外层要按 `Server refused to place` 翻译成中文。 */
          lastErr = new Error(`服务端明确拒绝放置 —— ${e.message}`)
        }
        lastErr = e
      }
      await sleep(120)   // 落地了再跳一次
    }
    throw lastErr ?? new Error('跳起来也没放上')
  } finally {
    try { b.setControlState('jump', false) } catch {}
  }
}

/** 把背包里的方块放到某个坐标（先走近、必要时往上搭） */
export async function placeBlock (self, { x, y, z, name = null } = {}, ctx = {}) {
  const b = self.requireBot()
  const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  /* 2026-10-23 审计（挖掘层报告第 12 条）：传半格 y（63.5）以前静默 floor，AI 不知道方块其实落在 63。
   * 传进来的不是整数就如实报一声（结果对象里 `snapped`）。 */
  const snapped = Number(x) !== pos.x || Number(y) !== pos.y || Number(z) !== pos.z
    ? { asked: { x: Number(x), y: Number(y), z: Number(z) }, used: { x: pos.x, y: pos.y, z: pos.z } }
    : null
  const want = name ? String(name) : null
  /* 🔴 船 / 矿车 / 刷怪蛋 / 盔甲架 是**实体**，不是方块 —— 走 mineflayer 的 placeEntity 那套
   *    （见下面 `placeEntityItem`）。旧代码一律当方块放，服务端收到的是"对着水右键放方块"，
   *    永远不成：2026-10-20 实机在生存和创造下各试了 3 次，`/execute if entity @e[type=oak_boat]`
   *    一次都没命中。 */
  /* 🔴 2026-10-25 实机（用户：「末地传送门它还是会在框架上放石头搭到传送门上方挖掉进去」）：
   *   传送门**紧邻**（水平 1 格 / 上下 1 格）一律不放方块。想进去就走到门方块那一格 —— 站进去服务端会自己传送；
   *   垫方块只会让它站在框架上方、再挖掉自己搭的东西往下掉，又慢又容易摔（还可能掉进虚空）。
   *   判据和 `mc_move` 迈门用的是同一个 `portalAt`（只认原版传送门方块名）。 */
  const nearPortal = portalAt(b, pos.x, pos.y, pos.z, 1)
  if (nearPortal) {
    return {
      placed: false, name: want, at: { x: pos.x, y: pos.y, z: pos.z },
      blockedBy: 'portal', ...(snapped ? { snapped } : {}),
      hint: `这里是传送门旁边（**${nearPortal.name}** 在 ${nearPortal.x}, ${nearPortal.y}, ${nearPortal.z}）`
        + '—— **传送门旁边不放方块**。想进去就 `mc_move` 走到门方块那一格（x/y/z 给那个坐标），'
        + '站进去服务端会自动传送；不用垫方块、也不用挖方块。',
    }
  }
  if (want && isEntityItem(want)) return await placeEntityItem(self, { x: pos.x, y: pos.y, z: pos.z, name: want }, ctx)
  // 选方块：指定名字就给那个；没指定就**只挑整方块**（旧版直接 items[0]，见 pickPlaceItem 注释）
  const pick = () => pickPlaceItem(b, want)
  let item = pick()

  // 创造模式：背包里没有就**自动取**（协议级 set_creative_slot，不需要 OP）。
  // 不这么做的话"给个方块名就能建"不成立——AI 得先想起来调 mc_give，
  // 否则 mc_build 直接报"背包是空的"。生存模式没这福利（得自己挖/合成）。
  if (!item && want && b.game?.gameMode === 'creative') {
    await self.giveItem({ name: want })
    item = pick()
  }
  if (!item) {
    if (want) {
      throw new Error(`背包里没有 ${want}（生存模式请先挖或合成；创造模式本应自动取物，若仍失败请看上一条错误）`)
    }
    let all = []
    try { all = b.inventory.items() } catch {}
    if (!all.length) {
      throw new Error('背包是空的——**给 name 指定要放哪种方块**（创造模式下会自动取物），或先挖方块')
    }
    // 能走到这里 = 背包里有东西，但没有"能当填充块的整方块"
    const junk = [...new Set(all.filter((i) => !isFullBlockItem(b, i.name)).map((i) => i.name))].slice(0, 6)
    const kept = [...new Set(all.filter((i) => isFullBlockItem(b, i.name)).map((i) => i.name))].slice(0, 6)
    throw new Error('背包里没有能当**实体方块**放的东西'
      + (junk.length ? `（只有 ${junk.join('、')} —— 火把/门/半砖这些放下去站不住）` : '')
      + (kept.length ? `（${kept.join('、')} 是家当，不拿来当填充块；真要放就显式给 name）` : '')
      + '。先 mc_dig 挖点泥土/圆石，或 mc_craft 做点木板。')
  }

  // 走/飞到够得着的位置（reach 约 4.5 格）
  /* 🔴 2026-10-08 第五份审计报告 ⑤：以前用"脚 → 方块角点"的距离、阈值 5.5 ——
   *    服务端是按**眼睛 → 方块中心**判的（生存 4.5 / 创造 5.0），角点到中心差最多 ~0.87 格
   *    ⇒ 4.6–5.5 格的方块能过我们的检查、然后被服务端拒（`place_block.js:42` 抛英文
   *    `Server refused to place …`，原样冒泡成工具错误）。现在按眼→中心算、阈值对齐服务端。 */
  const reachMax = b.game?.gameMode === 'creative' ? 5.0 : 4.5
  /* 🔴 2026-10-13 实机：眼睛位置原来只算**一次**（走路之前），走完还用那个旧坐标判距离
   *    ⇒ 明明已经走到跟前，仍然报"够不着 … 41.3 格"（报的是出发那一刻的距离）。
   *    必须**每次现算**。 */
  const eyeNow = () => {
    try {
      const p = b.entity.position
      return new Vec3(p.x, p.y + (b.entity.eyeHeight ?? 1.62), p.z)
    } catch { return b.entity.position }
  }
  const dist = () => eyeNow().distanceTo(pos.offset(0.5, 0.5, 0.5))
  let approachError = null
  if (dist() > 4) {
    self._selfMovingAt = Date.now()
    try {
      if (b.game?.gameMode === 'creative') await self.flyTo(pos.x + 2, pos.y + 1.5, pos.z + 2)
      else {
        // 站到目标旁边的**地面**上，别朝半空的 y 走（见 approachSpot 注释）
        const spot = approachSpot(b, pos)
        if (!spot) {
          throw new Error(`(${pos.x},${pos.y},${pos.z}) 周围 2 格内没有能站的地面（目标悬空）——`
            + '我不会朝半空一路垫方块爬过去。想搭桥 / 搭路请用 `mc_build`（它按范围一块块放），'
            + '想放这一块就先 `mc_move` 走到它旁边能站的地方。')
        }
        /* 🔴 2026-10-28 参数审计：这里写死 25 秒 —— 比单次调用上限（11 秒）还长，走到一半
         *    就被外层掐断，而 `walkTo` 自己以为还剩 14 秒，不会收尾。压到预算以内。 */
        /* 🔴 2026-10-29（预算收口第一步）：剩余不够就**拒绝启动**，不再压 1500 下限。 */
        const nb = needLeft(self, 1_000, CALL_BUDGET_MS)
        if (!nb.ok) throw new Error(insufficientText(nb, '走到那一格旁边'))
        await self.walkTo({ x: spot.x, y: spot.y, z: spot.z }, { arrive: 2.5, budget: nb.budgetMs })
      }
    } catch (e) { approachError = e.message }
    self._selfMovingAt = Date.now()
    await sleep(250)
  }
  // 🔴 够不着就别硬放。旧版把接近失败 `catch {}` 吞掉、照样往下走，
  //    结果服务端拒了放置，而工具还报"placed: X"——真机被投诉的"报假成功"。
  if (dist() > reachMax) {
    throw new Error(`够不着 (${pos.x},${pos.y},${pos.z})：眼睛到方块中心 ${dist().toFixed(1)} 格，`
      + `${b.game?.gameMode === 'creative' ? '创造 5' : '生存 4.5'} 格以内才放得下`
      + (approachError ? `（接近失败：${approachError}）` : '')
      + '。先用 mc_move 靠近，或换更近的点位。')
  }

  // 目标位置必须"能放"：不占空间才放得进去。
  // 判据是 canPlaceInto（boundingBox==='empty'）——覆盖空气三兄弟、**液体**、草/花/藤蔓等可替换物。
  const targetBlock = b.blockAt(pos)
  if (!targetBlock) {
    throw new Error(`(${pos.x},${pos.y},${pos.z}) 未加载（区块还没到）——先 mc_map 看看，或换近一点的点位`)
  }
  if (!canPlaceInto(targetBlock)) {
    throw new Error(`(${pos.x},${pos.y},${pos.z}) 已被 ${targetBlock.name} 占住，放不进去——`
      + '换个位置，或先 mc_act{mode:"break"} 清掉')
  }
  let ref = placeRef(self, pos)
  if (!ref) {
    /* 悬空：先在自己**脚下**垫一块、站上去，目标格就挨着这一块了（"原地搭高"）。
     * 🔴 2026-10-17 用户实机报「一直尝试放方块」：这一步原来**站着就放** ——
     *    落点 = `underFeet.position + (0,1,0)` = **机器人自己站着的那一格**。
     *    服务端不把方块放进玩家身体里 ⇒ 必拒；而那次调用**不在**下面的 try/catch 里
     *    ⇒ 英文原文 `Server refused to place cobblestone at (305,20,-653): the block is still air`
     *    直接冒泡给模型。模型看不懂"报的坐标是我自己站的地方"，只会一遍遍重试同一个点位
     *    （用户的 AI 后来自己总结成「服务端不让在脚底下放」，只好改去挖台阶）。 */
    const below = b.entity.position.floored().offset(0, -1, 0)
    const underFeet = b.blockAt(below)
    let padError = null
    if (underFeet && !isAir(underFeet.name)) {
      await ctx.t(b.equip(item, 'hand'), 'equip', '手持垫脚方块')
      await ctx.t(b.lookAt(below.offset(0.5, 0.5, 0.5), true), 'lookAt', '看向脚下')
      try {
        await ctx.t(placeWhileJumping(b, underFeet, { x: 0, y: 1, z: 0 }), 'place', '垫脚')
      } catch (e) { padError = e }
      /* 🔴 用户 2026-10-29：垫脚（竖井里往上垒）必须确认方块真的出现，三种情况分别记。 */
      try { if (b.__placeConfirm) self.log(`🧱 垫脚：${placeConfirmText(b.__placeConfirm)}`) } catch { /* 日志失败不影响 */ }
      await sleep(250)
    }
    ref = placeRef(self, pos)
    if (!ref) {
      const why = padError
        ? `在原地垫高一块也被拒了（${String(padError?.message ?? padError).slice(0, 120)}）`
        : (underFeet && !isAir(underFeet.name) ? '垫高之后那一格还是挨不着它' : '脚下也没有可垫的方块')
      throw new Error(`(${pos.x},${pos.y},${pos.z}) 悬空：它六面都没有可依附的方块，${why}。`
        + '**别再对着同一个点位试了** —— 要么先 `mc_act{mode:"place"}` 把它**下面那一格**填上，'
        + '要么 `mc_move` 走到紧挨着它的位置（上下左右差一格）再放。')
    }
  }
  await ctx.t(b.equip(item, 'hand'), 'equip', '手持方块')
  await ctx.t(b.lookAt(ref.ref.position.offset(0.5, 0.5, 0.5), true), 'lookAt', '看向放置面')
  /* 🔴 2026-10-17（用户实机：「`mc_act {mode:"place"}` 放不了自己脚下，经典 pillar-jump 做不成，
   *    这是我在竖井里爬不上去、反复淹死的直接原因」）：
   *    目标格正是**自己身体占着的那一格**（脚下 / 齐腰）时，站着放必被服务端拒 ——
   *    服务端不会把方块放进玩家碰撞箱。寻路器的自动垫脚能做，是因为它**先跳起来**；
   *    而水/岩浆这种可替换方块能过 `canPlaceInto` 那一关，所以以前是"预检放行、服务端拒"，
   *    报出来的还是英文原文，模型只会对着同一个点位重试。
   *    ⇒ 这种点位改走"跳起来再放"（脚离地那一瞬，那一格就空了）。 */
  const feetNow = (() => { try { return b.entity.position.floored() } catch { return null } })()
  const isOwnCell = Boolean(feetNow)
    && pos.x === feetNow.x && pos.z === feetNow.z
    && (pos.y === feetNow.y || pos.y === feetNow.y + 1)
  /* 🔴 2026-10-29 DSH 补丁（移植"火把姿势"+"被拒重试"）：第一次仍是 0.6.38 的老行为
   *   （`placeRef` 的第一个相邻面 + 瞄中心，原始尝试**不删**）；不行再按旧版顺序换候选面/瞄高
   *   （附着类优先用上次成功的姿势），普通方块最后再"后退 / 侧移 + 换俯仰"各重试一次。
   *   失败文案带上"准星实际打中的是哪格"，别再让模型盲猜。 */
  const attach = ATTACH_RE.test(item.name)
  try {
    if (isOwnCell) await ctx.t(placeWhileJumping(b, ref.ref, ref.face), 'place', '跳起来放到自己脚下')
    else {
      const got = await placeWithRetries(self, b, ctx, pos, ref, item.name)
      if (!got.ok) {
        try { self.log(`🧱 放置未确认：${placeConfirmText(got.confirm)}`) } catch { /* 同上 */ }
        /* 放完复核不过（含明确被拒）也算失步的一种 —— 攒 3 次触发自愈重连（2f73fcd 移植）。 */
        const heal = noteDesync(self, `放置复核不过 ${pos.x},${pos.y},${pos.z}`)
        throw new Error(placeFailText(b, pos, got, attach) + desyncHealNote(heal))
      }
    }
  } catch (e) {
    /* 🔴 报告⑤：上游 `place_block.js:42` 抛的是英文 `Server refused to place …`，
     *    以前原样冒泡给模型。翻译成它能用的话。 */
    const m = String(e?.message ?? '')
    if (/Server refused to place/i.test(m)) {
      /* 服务端明确拒放置 = 失步信号之一（2f73fcd 移植）。 */
      const heal = noteDesync(self, `放置被拒 ${pos.x},${pos.y},${pos.z}`)
      throw new Error(`服务端拒了在 (${pos.x},${pos.y},${pos.z}) 的这次放置（太远 / 目标格被占 / 手上有别的 / 失步）——`
        + (isOwnCell
          ? '**那一格是我自己身体占着的**（脚下/齐腰），已经试过"跳起来放"也没成 —— '
            + '先 `mc_move` 挪开一格、或者把**下面那一格**填上再站上去。别对着同一个点位反复试。'
          : '先用 `mc_move` 靠近或**换一个点位**，别对着同一个点位反复试，**也别当成放成功了**。')
        + desyncHealNote(heal))
    }
    throw e
  }
  await sleep(200)

  // 🔴 必须**验证**：旧版不管成没成都是 `placed: item.name` → 真机被投诉的"报假成功"
  //    （mc_build 说 placed，mc_scan 复查一格没放下）
  const now = b.blockAt(pos)?.name ?? null
  /* 🔴 2026-10-19（用户实机：连插两个火把，两次都回「❌ 动作失败 / 服务端可能拒了这次放置」，
   *    但 `now` 明明写着 `wall_torch` —— 火把**好端端贴在墙上**了）：
   *    这里原先死比 `now === item.name`。可**方块名会带变体**：火把贴墙变 `wall_torch`
   *    （灵魂火把变 `soul_wall_torch`），告示牌/旗帜也有同类朝向变体。
   *    判据必须是"**同一种方块**"，不是"同一个字符串" —— 两边都去掉 `wall_` 再比。
   *    跟踩坑 199（`outcomeOf` 白名单漏 `opened`/`toggled`）是同一类错：
   *    **判成功要认变体，别认字面**。 */
  const normName = (s) => String(s ?? '').replace(/wall_/g, '')
  const ok = Boolean(now) && (now === item.name || normName(now) === normName(item.name))
  return {
    placed: ok ? item.name : false,
    requested: item.name,
    at: { x: pos.x, y: pos.y, z: pos.z },
    now,
    held: heldText(b),
    ...(snapped ? { snapped } : {}),
    /* 这一块是"跳起来放到自己脚下"放成的 ⇒ 报出来，模型才知道自己刚垫高了一格。
     * 🔴 2026-10-24 用户实机（问题清单第 2 条）：以前只给一个 `pillar:true`，
     *    AI 看到"放成了"却不知道自己**已经被抬高**，接着按旧坐标走，于是"位置对不上"。
     *    现在直接把"垫高了几格、现在 y 多少"说出来。 */
    ...(isOwnCell
      ? {
          pillar: true,
          pillarNote: ok
            ? `🧗 这是"跳起来放到脚下"：你**被垫高了 1 格**，现在站在 y=${Math.round((b.entity?.position?.y ?? 0) * 10) / 10}。`
              + ' 再放一次就再高 1 格（搭柱子就这么来）；已经够高就别再放了。'
            : '（想垫高，但方块没放成 —— 见下面的 note）',
        }
      : {}),
    ...(ok ? {} : {
      note: `方块**没有出现**（现在那里是 ${now ?? '未加载'}）——服务端可能拒了这次放置`
        + '（领地保护 / 权限 / 反作弊 / 失步）。不要当成放成功了。'
        + (isOwnCell ? '（这一格是我自己站的地方，已经跳过再放 —— 还是没成，说明不是"占着"的问题）' : ''),
    }),
  }
}

/* ---------------------------------------------------------------- 实体物品（船 / 矿车 / 蛋 / 盔甲架） */


/**
 * 放一个**实体**物品（船 / 矿车 / 刷怪蛋 / 盔甲架 / 末影水晶）。
 *
 * 🔴 为什么不能用 `placeBlock` / `activateBlock`（2026-10-20 实机踩的）：
 *    mineflayer 的 `lib/plugins/place_entity.js` 写得很清楚 —— 放船时它先 `_genericPlace()`
 *    （发 `use_item_on`/`block_place`：告诉服务端"我对着这一格用了"，服务端拿这个包判断
 *    **该往哪放实体**），**然后再补发一个 `use_item` 包**（`useItemWithOwnPacket` 特性，
 *    1.19+ 都是），最后监听 `entitySpawn` 确认。少发后面那个 `use_item`，服务端就当"空手右键"，
 *    什么都不会生成 —— 正好是用户报的"放不出来"。
 * @returns `{placed, entity, at, name, held}`；没生成就 `{placed:false, hint}`（不抛，好让模型看懂）
 */
export async function placeEntityItem (self, { x, y, z, name = null } = {}, ctx = {}) {
  const b = self.requireBot()
  const t = ctx.t ?? ((p) => p)
  const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  const want = name ? String(name) : (b.heldItem?.name ?? null)
  if (!want) throw new Error('没说放什么，手上也是空的 —— 给 name（如 oak_boat / minecart / zombie_spawn_egg）')
  if (!isEntityItem(want)) {
    throw new Error(`${want} 不是"放下去变实体"的东西（船 / 矿车 / 刷怪蛋 / 盔甲架 / 末影水晶才是）—— 放方块用 mc_build 或 mc_act{mode:"place"} 的方块路径`)
  }
  const findAll = (n) => {
    try { return b.inventory.items().filter((i) => i.name === n) } catch { return [] }
  }
  if (!findAll(want).length && b.game?.gameMode === 'creative') {
    await self.giveItem({ name: want })
    await sleep(120)
  }
  const item = findAll(want)[0] ?? null
  if (!item) {
    throw new Error(`背包里没有 ${want}（生存模式要先合成/捡一个：船 = 5 个木板）`)
  }
  if (b.heldItem?.name !== want) {
    await t(Promise.resolve(b.equip(item, 'hand')), 'act', `把 ${want} 拿到手上`)
    await sleep(100)
  }
  /* 参考方块 = 目标格本身（水里 / 空气里都能点），朝向取"上面"：船就浮在这一格的水面上。
   * 目标格不是水、下面是水/陆地也行 —— 服务端按"点到的这一格 + 这个面"算落点。 */
  let ref = b.blockAt(pos) ?? b.blockAt(pos.offset(0, -1, 0))
  if (!ref) throw new Error(`${pos.x},${pos.y},${pos.z} 未加载 —— 先走过去或 mc_scan 看一眼`)
  /* 🔴 2026-10-20 实机：给的是"水面**上方**那一格"（空气）时，`blockAt(pos)` 拿到的是 air 方块，
   *    `block_place` 对着空气发 ⇒ 服务端直接忽略（不报错、也不生成）。玩家瞄准的永远是水面本身。
   *    所以参考格是空气就往下摸最多 3 格，摸到水/地面为止。 */
  const isAirName = (nm) => /^(air|cave_air|void_air)$/.test(String(nm ?? ''))
  /* 🔴 2026-10-24 用户：「能走到水边，但是放不下，没有对着水面，太远或者太近」。
   *    原来往下摸 3 格，摸到**第一个非空气**就停 —— 岸边那一格是泥土/沙子，于是对着泥土上面放船，
   *    船落到岸上。现在分两趟：先专门找**水**（船/木筏要的就是它），找不到再退回"任意非空气"。 */
  const isWaterBlk = (nm) => /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(String(nm ?? ''))
  if (isAirName(ref?.name)) {
    let water = null
    let solid = null
    for (let dy = 1; dy <= 3; dy++) {
      const below = b.blockAt(pos.offset(0, -dy, 0))
      if (!below) continue
      if (!water && isWaterBlk(below.name)) water = below
      if (!solid && !isAirName(below.name)) solid = below
    }
    if (water) ref = water
    else if (solid) ref = solid
  }
  const before = new Set(Object.keys(b.entities ?? {}).map(String))
  const face = new Vec3(0, 1, 0)
  /* ① 先"对着这一格用"（服务端靠它算落点） ② 再补 `use_item`（船/矿车必须补，见上面的注释） */
  try {
    if (typeof b._genericPlace === 'function') {
      await t(Promise.resolve(b._genericPlace(ref, face, {})), 'act', `对着 ${ref.name} 用 ${want}`)
    } else {
      await t(Promise.resolve(b.activateBlock(ref)), 'act', `对着 ${ref.name} 用 ${want}`)
    }
  } catch (e) {
    return { placed: false, name: want, at: { x: pos.x, y: pos.y, z: pos.z }, hint: `放的时候服务端/上游报错：${e?.message ?? e}` }
  }
  /* 🔴 **不要**补发 `use_item`（2026-10-20 实机踩的，两次被踢）：mineflayer 的 `place_entity.js` 里为船
   *    补发了 `bot._client.write('use_item', { hand })`，但那是老协议的形状 —— 这个服（1.21.10 /
   *    protocol 773，minecraft-data 的 `packet_play_use_item` = `hand + sequence:varint + rotation:vec2f`）
   *    少了 `sequence`/`rotation`。protodef 是"边写边抛"，只写了一半就异常 ⇒ 那条包在流里是**残的**，
   *    服务端读到脏字节，同一秒还能勉强活，几十秒后 `disconnect.timeout` 掉线（实机两次都是"放完船就掉"）。
   *    对照：刷怪蛋走同一条 `_genericPlace`（只发 block_place）一来就放出来了 ⇒ 现代协议下**一个
   *    block_place 就够**，别画蛇添足。 */
  /* 复核：新出现的实体里，4 格内、名字像不像 */
  const KEY = /boat|raft|minecart|armor_stand|armorstand|end_crystal|ender_crystal/i
  const fresh = () => Object.values(b.entities ?? {}).filter((e) => e && e !== b.entity && !before.has(String(e.id)))
  let hit = null
  let stranger = null
  const waitSpawn = async (ms) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      const cands = fresh().filter((e) => {
        try { return e.position.distanceTo(pos) <= 4 } catch { return false }
      })
      /* 2026-10-23 审计：以前 `?? cands[0]` 把「4 格内任何一个新实体」（掉落物、路过的怪、别的玩家）
       * 都当成我放出来的东西 ⇒ 报 placed:true，AI 之后上船永远上不去。现在只认名字像的。 */
      const named = cands.find((e) => KEY.test(String(e.name ?? '')))
      if (named) { hit = named; stranger = null } else if (!stranger && cands[0]) stranger = cands[0]
      if (hit) return hit
      await sleep(80)
    }
    return null
  }
  let via = 'block_place'
  await waitSpawn(700)
  /* ② 还不行就再用一次"手上的东西"：`bot.activateItem()` 自己会拼出正确形状的 `use_item`
   *    （`inventory.js:134`：`{hand, sequence, rotation}`）。用户 2026-10-20 说过「用 useitem 其实也能放」，
   *    而我们自己的 `mc_act {mode:"useitem"}` 实测没放出来 —— 两条路都试一遍，谁成就报谁。 */
  if (!hit) {
    try {
      await t(Promise.resolve(b.activateItem()), 'act', `用手上的 ${want} 试一次`)
      via = 'use_item'
    } catch (e) {
      /* 记下但不打断：下面统一报"两条都没成" */
      via = `block_place + use_item(${String(e?.message ?? e)})`
    }
    await waitSpawn(800)
  }
  if (!hit) {
    return {
      placed: false, name: want, at: { x: pos.x, y: pos.y, z: pos.z }, held: heldText(b),
      sent: via,
      ...(stranger ? { sawInstead: String(stranger.name ?? '?') } : {}),
      hint: `${via} 都发了，但 1.5 秒内**没看到新实体** —— 常见原因：离得远（要 4.5 格内、眼睛看得见）、`
        + `目标格被占（船要放水里/水边，别对着自己脚下）、或者服务端把这次放置吞了。`
        + `先 mc_move 到水边换个点位再试，别对着同一点反复发。`,
    }
  }
  return {
    placed: true, name: want, entity: String(hit.name ?? ''),
    at: { x: Math.round(hit.position.x * 10) / 10, y: Math.round(hit.position.y * 10) / 10, z: Math.round(hit.position.z * 10) / 10 },
    held: heldText(b),
    hint: /boat|raft/i.test(String(hit.name ?? '')) ? '上船用 mc_act {mode:"use", who:"oak_boat"}' : undefined,
  }
}
