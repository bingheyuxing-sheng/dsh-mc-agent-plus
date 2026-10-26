/**
 * `bot.blockAt()` 的参数归一化 —— 一个坑只在一个地方堵。
 *
 * 🔴 起因（用户 2026-10-26 实机）：跑 `mc_act { mode: 'farm', seed: 'wheat_seeds' }` 直接炸
 *    `Error: pos.floored is not a function`。原因是 `bot.blockAt()` 只认**真 `Vec3`**：
 *    喂普通 `{ x, y, z }` 时 prismarine-world 会去调 `pos.floored()`，纯对象上没有这个方法。
 *
 *    各叶子模块本该自己 `new Vec3(...)`（`src/farm.mjs` 已补了 `at()` 这个唯一口子），
 *    但**漏一处就整条工具链炸**，而且报错来自依赖深处、看不出是哪一行 —— 所以在
 *    **唯一的 bot 创建点**（`src/connection.mjs`）兜一层：真 Vec3 原样放行，
 *    纯坐标对象就地包成 Vec3。只做参数归一化，不改任何语义。
 *
 * 为什么不在 `core.mjs` 里做：`core.mjs` 有 ≤1000 行的硬上限（自检盯着），
 * 而 `connection.mjs` 本来就是唯一 `mineflayer.createBot()` 的地方，放那儿最贴。
 */

import { Vec3 } from 'vec3'

/** 能当坐标用的纯对象？三个分量都有限数才算。 */
const isPlainPos = (p) => Boolean(p) && typeof p === 'object'
  && typeof p.floored !== 'function'
  && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)) && Number.isFinite(Number(p.z))

/**
 * 给 bot 的 `blockAt()` 套一层参数归一化。**幂等**：同一个 bot 套两次也只套一层。
 * @param {object} b mineflayer bot
 * @returns {object} 同一个 bot（方便链式）
 */
export function patchBlockAt (b) {
  if (!b || typeof b.blockAt !== 'function' || b.__wcBlockAtPatched) return b
  const raw = b.blockAt.bind(b)
  b.blockAt = (pos, ...rest) => {
    let p = pos
    if (isPlainPos(pos)) {
      try { p = new Vec3(Number(pos.x), Number(pos.y), Number(pos.z)) } catch { p = pos }
    }
    return raw(p, ...rest)
  }
  b.__wcBlockAtPatched = true
  return b
}

/** 自检用：判断这个 bot 是否已经套过（别拿私有字段到处摸）。 */
export const isBlockAtPatched = (b) => Boolean(b && b.__wcBlockAtPatched)
